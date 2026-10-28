import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const root = resolve(import.meta.dirname, '../..');
const patch = resolve(root, 'config/voice/dsh-m0.patch.yml');
const speechOnly = process.argv.includes('--speech-only');
const out = resolve(root, `outputs/desktop-validation/m0/dsh-${speechOnly ? 'speech' : 'session'}-probe.json`);
const dsh = resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const profile = 'deskai2-voice-m0';
const started = Date.now();
const report = { version: '0.2.1-rc.2', profile, startedAt: new Date().toISOString(), checks: [], events: [], stream: [] };
let host, socket, ownChild;

function fail(message) { throw new Error(message); }
function note(check, value) { report.checks.push({ check, ...value }); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function redact(value, depth = 0) {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return `[string:${[...value].length}]`;
  if (Array.isArray(value)) return value.slice(0, 8).map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/token|cookie|secret|key|authorization/i.test(k)).map(([k,v]) => [k, redact(v, depth + 1)]));
  return value;
}
async function startHost() {
  let initialize = [];
  try { await access(resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'profiles', profile)); }
  catch { initialize = ['--from-default-profile', 'web']; }
  ownChild = spawn(process.execPath, [dsh, '--profile', profile, ...initialize, '--patch', patch, '--port', '0', '--no-open'], { cwd: root, stdio: ['ignore','pipe','pipe'], windowsHide: true });
  let output = '';
  const ingest = b => { output += b.toString(); if (output.length > 100000) output = output.slice(-100000); };
  ownChild.stdout.on('data', ingest); ownChild.stderr.on('data', ingest);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (ownChild.exitCode !== null) fail(`dsh exited ${ownChild.exitCode}; sanitized tail: ${output.slice(-1500).replace(/token=[^\s&]+/g,'token=[redacted]').replace(/(?:sk-[A-Za-z0-9_-]+)/g,'[redacted]')}`);
    const match = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?\?token=[^\s'"<>]+/);
    if (match) { const url = new URL(match[0].replace(/[),.;]+$/, '')); host = url.origin; return url.searchParams.get('token'); }
    await wait(200);
  }
  fail(`dsh startup timeout; sanitized tail: ${output.slice(-1000).replace(/token=[^\s&]+/g,'token=[redacted]')}`);
}
async function connect(token) {
  const response = await fetch(`${host}/connect?token=${encodeURIComponent(token)}&interactions=none`, { redirect: 'manual' });
  if (response.status !== 302) fail(`/connect HTTP ${response.status}`);
  const cookie = response.headers.get('set-cookie')?.split(';',1)[0];
  if (!cookie) fail('/connect no cookie');
  socket = new WebSocket(`${host.replace(/^http/, 'ws')}/api/remote.mux`, { headers: { Cookie: cookie } });
  await new Promise((ok, bad) => { socket.once('open', ok); socket.once('error', bad); });
  note('authenticated_mux', { ok: true, ms: Date.now() - started });
  return cookie;
}
async function rpcArgs(cookie, endpoint, args) {
  const rpcId = randomUUID();
  const response = await fetch(`${host}/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookie }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }) });
  if (!response.ok) fail(`${endpoint} HTTP ${response.status}`);
  const body = await response.json();
  if (body.rpcId !== rpcId) fail(`${endpoint} rpcId mismatch`);
  if (!body.result?.ok) fail(`${endpoint}: ${body.result?.error?.code ?? 'unknown'} ${body.result?.error?.message ?? ''}`);
  return body.result.value;
}
function open(endpoint, args) {
  const streamId = randomUUID();
  const frames = [];
  let waiter;
  const onMessage = bytes => {
    let item; try { item = JSON.parse(bytes.toString()); } catch { return; }
    if (item.streamId !== streamId) return;
    frames.push(item);
    if (waiter) { waiter(); waiter = undefined; }
  };
  socket.on('message', onMessage);
  socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
  return {
    frames,
    async until(test, timeout = 30000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const found = frames.find(test); if (found) return found;
        await Promise.race([new Promise(r => { waiter = r; }), wait(Math.min(250, end - Date.now()))]);
      }
      fail(`follow timeout after ${timeout}ms`);
    },
    close() { socket.send(JSON.stringify({ type: 'cancel', streamId })); socket.off('message', onMessage); }
  };
}
function follow(sessionId) { return open('session/follow', { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 40 } }); }
function summarizeFollow(frames, label) {
  for (const f of frames) {
    if (f.type !== 'item') { report.stream.push({ label, transport: f.type, error: f.error?.code }); continue; }
    const v = f.value;
    if (v?.type === 'snapshot') report.events.push({ label, type: 'snapshot', cursor: v.cursor, preset: v.header?.agentPreset, records: v.records?.map(x => ({ seq: x.event?.seq, type: x.event?.type })), assistantStream: redact(v.assistantStream), projectionKeys: Object.keys(v.projections?.values ?? {}) });
    else if (v?.type === 'event') report.events.push({ label, type: v.event?.type, seq: v.event?.seq, data: redact(v.event?.data) });
    else if (v?.type === 'assistant-stream') report.stream.push({ label, frame: v.frame?.type, index: v.frame?.index, revision: v.frame?.revision, outcome: v.frame?.outcome?.kind, eventType: v.frame?.outcome?.eventType, chunk: v.frame?.type === 'chunk' ? redact(v.frame?.chunk) : undefined });
  }
}
function inspectContract(frames) {
  const events = frames.filter(f => f.type === 'item' && f.value?.type === 'event').map(f => f.value.event);
  const system = events.find(e => e.type === 'system/message')?.data?.message?.content?.find(x => x.type === 'text')?.text ?? '';
  const request = events.find(e => e.type === 'request/header')?.data?.header;
  const attempt = events.find(e => e.type === 'assistant/attempt')?.data;
  note('effective_prompt', { protocolPresent: system.includes('SPEAK、WAIT 或 SILENT'), codingPersonaAbsent: !/coding agent|software engineer|编程助手/i.test(system), length: [...system].length });
  note('tool_table', { names: request?.tools?.map(t => t.name) ?? [], empty: request !== undefined && (request.tools?.length ?? 0) === 0, toolsFieldOmitted: request !== undefined && !Object.hasOwn(request, 'tools') });
  if (attempt) note('attempt_outcome', { chunkTypes: attempt.stream?.map(x => x.chunk?.type), failureCodes: attempt.stream?.map(x => x.chunk?.reason?.failure?.code).filter(Boolean) });
}
async function main() {
  const token = await startHost();
  const cookie = await connect(token);
  if (speechOnly) {
    const { runSpeech } = await import('./dsh-speech-probe.mjs');
    await runSpeech({ call: (endpoint, args) => rpcArgs(cookie, endpoint, args), open, report });
    return;
  }
  const rpc = (endpoint, request) => rpcArgs(cookie, endpoint, { request });
  const created = await rpc('session/create', { cwd: root, agentPreset: 'deskai2-voice-m0' });
  note('session_create', { ok: created.agentPreset === 'deskai2-voice-m0', preset: created.agentPreset });
  const active = follow(created.sessionId);
  await active.until(f => f.type === 'item' && f.value?.type === 'snapshot');
  const ack = await rpc('session/prompt', { requestId: randomUUID(), sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: '请用中文一句话告诉我，1 加 1 等于几。' }] });
  note('prompt_receipt', { accepted: ack.accepted, meansGenerationFinished: false });
  try { await active.until(f => f.type === 'item' && f.value?.type === 'assistant-stream' && f.value.frame?.type === 'end', 60000); note('stream_end', { ok: true }); }
  catch (e) { note('stream_end', { ok: false, error: e.message }); }
  inspectContract(active.frames);
  summarizeFollow(active.frames, 'first');
  active.close();
  const reconnect = follow(created.sessionId);
  const snap = await reconnect.until(f => f.type === 'item' && f.value?.type === 'snapshot');
  note('reconnect_baseline', { cursor: snap.value.cursor, activeAttempt: !!snap.value.assistantStream?.activeAttempt, revision: snap.value.assistantStream?.revision });
  summarizeFollow(reconnect.frames, 'reconnect'); reconnect.close();
}
try { await main(); } catch (error) { note('fatal', { error: String(error?.message ?? error).replace(/token=[^\s&]+/g,'token=[redacted]') }); process.exitCode = 1; }
finally {
  socket?.close();
  if (ownChild && ownChild.exitCode === null) ownChild.kill();
  await mkdir(resolve(out, '..'), { recursive: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output: out, checks: report.checks }));
}
