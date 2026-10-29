/** Real sequential GPU acceptance through the production Node adapter. Never trains. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalTtsService } from '../../packages/tts-adapter/src/index.ts';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = path.resolve(process.argv[2] ?? path.join(root, 'outputs/desktop-validation/m3/tts'));
await mkdir(output, { recursive: true });
const report = { timestampUTC: new Date().toISOString(), trainingPerformed: false,
  subjectiveListeningPerformed: false, microphoneTested: false, speakerAECTested: false,
  parameters: { version: 'v2', is_half: true, use_cuda_graph: true, batch_size: 1, text_split_method: 'cut0' },
  voices: [], checks: {}, passed: false };
let lastState = '';
const service = new LocalTtsService(root, (status) => {
  if (status.state !== lastState) { lastState = status.state; console.log(`TTS ${status.state}${status.code ? ` ${status.code}` : ''}`); }
});
let generation = 0;

function wav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
function request(selection, text = '你好。我在这里。') {
  return { ...selection, sessionId: 'm3-tts-probe', turnId: `turn-${++generation}`, generationId: generation,
    segmentId: `segment-${generation}-attempt-1`, text, language: 'all_zh', speed: 1 };
}
async function synthesize(selection, filename) {
  let rate;
  const chunks = [];
  const result = await service.synthesize(request(selection), (chunk) => {
    assert.equal(chunk.chunkSeq, chunks.length);
    if (rate !== undefined) assert.equal(chunk.sampleRate, rate);
    rate = chunk.sampleRate; chunks.push(Buffer.from(chunk.pcm));
  });
  assert.equal(result.canceled, false); assert.ok(chunks.length);
  const bytes = Buffer.concat(chunks);
  let peak = 0, squares = 0;
  for (let i = 0; i < bytes.length; i += 2) { const sample = bytes.readInt16LE(i); peak = Math.max(peak, Math.abs(sample)); squares += sample * sample; }
  assert.ok(peak > 0); assert.ok(bytes.length / 2 / rate > 0.2);
  const wave = wav(bytes, rate);
  await writeFile(path.join(output, filename), wave);
  return { ...selection, ...result, sampleRate: rate, durationSeconds: bytes.length / 2 / rate,
    peak, rms: Math.sqrt(squares / (bytes.length / 2)) / 32768, filename,
    sha256: createHash('sha256').update(wave).digest('hex') };
}
try {
  const start = performance.now();
  const voices = await service.start(); assert.equal(voices.length, 10);
  report.startupSeconds = (performance.now() - start) / 1000;
  report.checks.tenVoiceResourcesExist = true;
  report.checks.defaultNormalNagatoReady = service.getStatus().voiceId === 'nagato-normal-v2';
  for (const voice of voices) {
    const selection = await service.selectVoice(voice.id);
    report.voices.push({ name: voice.name, ...await synthesize(selection, `${voice.id}.wav`) });
    console.log(`Generated ${voice.id}`);
  }
  report.checks.tenVoicePairsLoadedAndSynthesized = report.voices.length === 10;
  const normal = voices.find((voice) => voice.id === 'nagato-normal-v2');
  if (normal.references.length > 1) {
    const selection = await service.selectVoice(normal.id, normal.references[1].id);
    report.alternateReference = await synthesize(selection, 'nagato-normal-v2-alternate-reference.wav');
    report.checks.referenceSelectionSynthesized = true;
  }
  const selection = await service.selectVoice(normal.id);
  report.cancellations = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    let receivedAfterCancel = false;
    let canceled = false;
    const synthesizing = service.synthesize(request(selection, '这是一段用于取消握手和恢复检查的较长测试内容。'.repeat(10)), () => {
      if (canceled) receivedAfterCancel = true;
    });
    synthesizing.catch(() => {}); // Attach immediately; the main await below still reports failures.
    // Yield to the synthesize/start microtasks, then cancel while inference is active.
    await new Promise((resolve) => setTimeout(resolve, 50));
    canceled = true;
    const started = performance.now();
    await service.cancel();
    const result = await synthesizing;
    assert.equal(result.canceled, true); assert.equal(receivedAfterCancel, false);
    report.cancellations.push({ settledMilliseconds: performance.now() - started, noLatePCM: true });
  }
  report.recovery = await synthesize(selection, 'nagato-normal-v2-after-cancel.wav');
  report.checks.repeatedCancelNoLatePCMAndRecovery = true;
  report.checks.voiceFailureRollbackUnitTestOnly = true;
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : 'UNKNOWN_FAILURE';
  process.exitCode = 1;
} finally {
  await service.dispose();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
}
console.log(JSON.stringify({ passed: report.passed, report: path.join(output, 'report.json') }));
