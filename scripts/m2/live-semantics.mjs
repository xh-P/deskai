import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { LocalDshSpeech } from '../../.cache/desktop-main/packages/dsh-adapter/src/speech.js';
import { LocalDshChat } from '../../.cache/desktop-main/packages/dsh-adapter/src/session.js';
import { DecisionStream } from '../../.cache/desktop-main/packages/voice-core/src/stream.js';
import { localDecision } from '../../.cache/desktop-main/packages/voice-core/src/policy.js';

// This is deliberately separate from automatic unit/UI tests: it sends fixture
// transcripts to the model already configured in dsh and may incur model usage.
if (!process.argv.includes('--real-model')) throw new Error('真实模型回归需显式 --real-model；先配置 dsh 账号并执行 npm run desktop:build。');
const root = path.resolve(import.meta.dirname, '../..');
const suite = JSON.parse(await readFile(path.join(root, 'tests/voice/fixtures/m2-semantic-cases.json'), 'utf8'));
const observed = { schemaVersion: 1, observationSource: 'actual dsh configured model; synthetic text fixtures', cases: [], missingCredential: false };
const service = new LocalDshSpeech(root);
try {
  await service.start();
  for (const item of suite.cases) {
    if (item.context.acousticEvidence || item.context.inputStillSpeaking || item.context.permissionCheck) continue;
    const context = item.context;
    const local = localDecision(item.input, { outputPlaying: context.outputPlaying, pausedOutput: context.pausedOutput,
      expectsReply: context.pendingQuestion?.status === 'awaiting' });
    if (local !== 'MODEL') {
      observed.cases.push({ id: item.id, actual: { action: local, route: 'local' }, evidence: { modelCalls: 0 } });
      continue;
    }
    const question = context.pendingQuestion?.status === 'awaiting' ? { questionId: 'fixture-question', turnId: 'fixture-setup',
      text: context.pendingQuestion.text, status: 'awaiting' } : undefined;
    let parser = new DecisionStream();
    let header, code;
    const consume = events => { for (const event of events) {
      if (event.type === 'header') header = event.header;
      if (event.type === 'error') code ??= 'PROTOCOL_FORMAT';
    } };
    const chat = new LocalDshChat(service, root);
    const accepted = await chat.runTurn({ text: item.input, personaId: 'nagato-normal-light', mode: item.source,
      replyLanguage: item.language, visibleHistory: [], deliveryState: { attempts: [], pendingQuestion: question } }, event => {
      if (event.type === 'attempt-start') { parser = new DecisionStream(); header = undefined; }
      if (event.type === 'text') consume(parser.push(event.text));
      if (event.type === 'error') code = event.code;
    });
    const settled = await accepted.completed;
    consume(parser.finish());
    if (code === 'MISSING_CREDENTIAL') { observed.missingCredential = true; break; }
    if (settled.status !== 'completed' || code || !header) {
      observed.cases.push({ id: item.id, actual: { action: 'INVALID', route: 'model' }, evidence: { code: code ?? settled.code ?? 'NO_HEADER', modelCalls: 1 } });
    } else observed.cases.push({ id: item.id, actual: { action: header.action, route: 'model' },
      evidence: { reason: header.reason, modelCalls: 1, realModel: true } });
  }
} finally {
  await service.dispose();
  const out = path.join(root, 'outputs/desktop-validation/m2');
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'semantic-observed-real.json'), JSON.stringify(observed, null, 2));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/m2/semantic-report.mjs'), '--observed',
      path.join(out, 'semantic-observed-real.json'), '--format', 'json'], { cwd: root, windowsHide: true, stdio: ['ignore','pipe','inherit'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', reject); child.once('exit', code => resolve({ code, output }));
  });
  await writeFile(path.join(out, 'semantic-report-real.json'), result.output);
  console.log(JSON.stringify({ ...(JSON.parse(result.output).counts), missingCredential: observed.missingCredential }));
  if (observed.missingCredential || result.code) process.exitCode = 1;
}
