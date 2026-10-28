import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalDshSpeech } from '../../.cache/desktop-main/packages/dsh-adapter/src/speech.js';
import { encodePcm16Wav } from '../../.cache/desktop-main/packages/voice-core/src/wav.js';

const root = path.resolve(import.meta.dirname, '../..');
const states = [];
const service = new LocalDshSpeech(root, status => {
  if (status.phase && states.at(-1) !== status.phase) states.push(status.phase);
});
const report = { timestamp: new Date().toISOString(), simulatedMicrophone: true, realSenseVoiceCPU: true,
  transcriptContentStored: false, physicalMicrophoneTested: false, passed: false, states };
try {
  for (const cancelAfterMilliseconds of [0, 40]) {
    const startingService = new LocalDshSpeech(root);
    const result = startingService.start().then(() => 'unexpected-ready', () => 'cancelled');
    if (cancelAfterMilliseconds) await new Promise(resolve => setTimeout(resolve, cancelAfterMilliseconds));
    await startingService.dispose();
    assert.equal(await result, 'cancelled');
  }
  report.startupCancellationBeforeAndDuringSpawn = true;
  await service.start();
  const canonical = await readFile(path.join(root, 'tests/voice/fixtures/m0-sensevoice-zh.wav'));
  assert.equal(canonical.toString('ascii', 36, 40), 'data');
  const baseline = await service.transcribe(canonical, AbortSignal.timeout(30_000));
  assert.ok(baseline.text.trim());
  const source = new Float32Array((canonical.length - 44) / 2);
  for (let i = 0; i < source.length; i++) source[i] = canonical.readInt16LE(44 + i * 2) / 32768;
  const long = Float32Array.from({ length: 16000 * 20 }, (_, i) => source[i % source.length]);
  const cancel = new AbortController();
  const started = performance.now();
  const pending = service.transcribe(encodePcm16Wav(long), cancel.signal);
  const timer = setTimeout(() => cancel.abort(), 35);
  try { await pending; throw new Error('Cancellation request completed unexpectedly'); }
  catch (error) { assert.equal(cancel.signal.aborted, true); assert.ok(/abort/i.test(error.name + error.message)); }
  finally { clearTimeout(timer); }
  report.clientAbortMilliseconds = Number((performance.now() - started).toFixed(2));
  const recoveryStarted = performance.now();
  const recovered = await service.transcribe(canonical, AbortSignal.timeout(30_000));
  report.recoveryMilliseconds = Number((performance.now() - recoveryStarted).toFixed(2));
  assert.equal(recovered.text, baseline.text);
  report.clientAbortObserved = true;
  report.nextTranscriptionMatchesWarmBaseline = true;
  report.providerCancellationAcknowledgmentAvailable = false;
  report.note = 'The HTTP client observes AbortError and successful subsequent recognition; no separate provider cancellation acknowledgment is exposed.';
  report.passed = true;
} catch (error) {
  report.error = error.code ?? error.name;
  process.exitCode = 1;
} finally {
  await service.dispose();
  const out = path.join(root, 'outputs/desktop-validation/m1');
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'asr-cancel-probe.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
