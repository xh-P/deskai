import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

if (!process.argv.includes('--real-model')) throw new Error('Pass --real-model to authorize a real dsh model and tool run.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), 'packages/dsh-adapter/src/work-provider.ts',
  '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--esModuleInterop',
  '--types', 'node', '--rewriteRelativeImportExtensions', '--rootDir', '.', '--outDir', '.cache/desktop-main'], { cwd: root, stdio: 'inherit' });
const { DshWorkProvider } = await import('../../.cache/desktop-main/packages/dsh-adapter/src/work-provider.js');
const projectPath = await mkdtemp(path.join(tmpdir(), 'deskai-work-'));
const entry = path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const patch = path.join(root, 'node_modules/@deepseek-ai/dsh-experimental-auto-review/cordis.patch.yml');
const child = spawn(process.execPath, [entry, '--profile', 'web', '--patch', patch, '--port', '0', '--no-open'], {
  cwd: projectPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
});
let origin = '';
let cookie = '';
const launch = new Promise((resolve, reject) => {
  let buffer = '';
  const timeout = setTimeout(() => reject(new Error('Host startup timeout')), 90_000);
  const receive = chunk => {
    buffer = (buffer + chunk.toString('utf8')).slice(-64_000);
    const match = buffer.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?\?token=[^\s'"<>]+/);
    if (match) { clearTimeout(timeout); resolve(new URL(match[0].replace(/[),.;]+$/, ''))); }
  };
  child.stdout.on('data', receive); child.stderr.on('data', receive);
  child.once('error', () => reject(new Error('Host spawn failed')));
  child.once('exit', () => reject(new Error('Host exited during startup')));
});
const host = {
  async ensureHost() { return { state: 'ready' }; },
  async call(endpoint, args) {
    const rpcId = randomUUID();
    const response = await fetch(`${origin}/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }), signal: AbortSignal.timeout(180_000) });
    const body = await response.json();
    if (!response.ok || body.rpcId !== rpcId || !body.result?.ok) throw new Error(`${endpoint}: ${body.result?.error?.code ?? response.status}`);
    return body.result.value;
  },
  sessionCall(endpoint, request) { return this.call(endpoint, { request }); },
  async sessionFollow(request, onFrame) {
    const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/api/remote.mux', { headers: { Cookie: cookie } });
    const streamId = randomUUID();
    socket.on('message', raw => { const frame = JSON.parse(raw.toString()); if (frame.streamId === streamId) onFrame(frame); });
    socket.on('error', () => onFrame({ type: 'error', error: { code: 'SOCKET_FAILED' } }));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request } } }));
    return () => socket.close();
  }
};
try {
  const url = await launch;
  origin = url.origin;
  const response = await fetch(`${origin}/connect?token=${encodeURIComponent(url.searchParams.get('token'))}&interactions=none`, { redirect: 'manual' });
  cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  if (response.status !== 302 || !cookie) throw new Error('Host API authentication failed');
  const provider = new DshWorkProvider(host, root);
  const events = [];
  const result = await provider.start({ taskId: randomUUID(), attemptId: randomUUID(), requestId: randomUUID(), projectPath,
    prompt: '请在当前工作目录创建名为 work-probe.txt 的 UTF-8 文本文件，内容严格为 DESKAI_WORK_PROBE_OK，然后读取该文件确认。只执行这项小任务。' },
  event => { if (event.type === 'artifact' || event.type === 'session') events.push(event); });
  const content = await readFile(path.join(projectPath, 'work-probe.txt'), 'utf8').catch(() => '');
  const output = { outcome: result.outcome, error: result.error, wroteExpectedFile: content.trim() === 'DESKAI_WORK_PROBE_OK',
    artifactObserved: events.some(event => event.type === 'artifact' && path.basename(event.path) === 'work-probe.txt'),
    sessionObserved: events.some(event => event.type === 'session') };
  process.stdout.write(JSON.stringify(output) + '\n');
  if (result.outcome !== 'completed' || !output.wroteExpectedFile || !output.artifactObserved) process.exitCode = 1;
} catch (error) {
  process.stderr.write(JSON.stringify({ failed: error instanceof Error ? error.message : String(error) }) + '\n');
  process.exitCode = 1;
} finally {
  if (child.pid && child.exitCode === null) {
    if (process.platform === 'win32') await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('exit', resolve);
    });
    else child.kill('SIGTERM');
  }
  if (path.dirname(path.resolve(projectPath)).toLowerCase() !== path.resolve(tmpdir()).toLowerCase() || !path.basename(projectPath).startsWith('deskai-work-'))
    throw new Error('Refusing to remove an unexpected probe directory');
  await rm(projectPath, { recursive: true, force: true });
}
