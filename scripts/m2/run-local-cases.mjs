import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { localDecision } from '../../.cache/desktop-main/packages/voice-core/src/policy.js';
import { createInputController } from '../../.cache/desktop-main/packages/voice-core/src/index.js';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(await readFile(path.join(root, 'tests/voice/fixtures/m2-semantic-cases.json'), 'utf8'));
const observed = { schemaVersion: 1, observationSource: 'actual local policy/core replay; no model or physical acoustics', cases: [] };
for (const sample of fixture.cases) {
  // Acoustic evidence must come from devices/reference measurements, not fixture labels.
  if (sample.context.acousticEvidence) continue;
  if (sample.context.inputStillSpeaking) {
    let ready = 0, calls = 0;
    const controller = createInputController({ transcribe: async () => { calls++; return sample.input; }, onReady: () => { ready++; } });
    controller.start('semantic-replay');
    for (let i = 0; i < 40; i++) controller.pushFrame({ samples: new Float32Array(512).fill(.2), probability: .9 });
    const actual = ready === 0 && calls === 0 ? 'ACCUMULATE' : 'SPEAK';
    controller.stop();
    observed.cases.push({ id: sample.id, actual: { action: actual, route: 'local' }, evidence: { callbackCounts: { ready, asrCalls: calls }, simulatedVAD: true } });
    continue;
  }
  const action = localDecision(sample.input, { outputPlaying: sample.context.outputPlaying,
    pausedOutput: sample.context.pausedOutput, expectsReply: sample.context.pendingQuestion?.status === 'awaiting' });
  if (action !== 'MODEL') observed.cases.push({ id: sample.id, actual: { action, route: 'local' }, evidence: { localFunction: 'localDecision', modelCalls: 0 } });
}
const out = path.join(root, 'outputs/desktop-validation/m2');
await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'semantic-observed-local.json'), JSON.stringify(observed, null, 2));
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, 'scripts/m2/semantic-report.mjs'), '--observed', path.join(out, 'semantic-observed-local.json'), '--format', 'json'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit']
  });
  let result = ''; child.stdout.on('data', chunk => { result += chunk.toString(); });
  child.once('error', reject);
  child.once('exit', async code => {
    try { const report = JSON.parse(result); await writeFile(path.join(out, 'semantic-report-local.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ ...report.counts, observationSource: report.observationSource }));
      if (code) process.exitCode = code; resolve(); } catch (error) { reject(error); }
  });
});
