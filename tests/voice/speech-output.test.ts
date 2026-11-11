import test from 'node:test';
import { OutputTimeline } from '../../packages/voice-core/src/diagnostics.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { SentenceStream, cleanSpeech } from '../../packages/voice-core/src/sentences.ts';
import { DeliveryLedger } from '../../packages/voice-core/src/delivery.ts';
import { DialogueController, type DialogueEvent } from '../../packages/voice-core/src/dialogue.ts';
import type { DialoguePort } from '../../packages/voice-core/src/chat-contract.ts';
import { SpeechOutput, type SpeechOutputEvent, type SpeechPort, type SpeechProgress } from '../../apps/desktop/src/speech-output.ts';
import type { PCMChunk, SynthesisRequest } from '../../packages/tts-adapter/src/index.ts';

test('timing diagnostics stay bounded, exclude conversation/audio fields, and return isolated snapshots', () => {
  const trace = new OutputTimeline();
  const identity = { sessionId: 's', turnId: 't', utteranceIds: [1], text: 'private speech', samples: new Float32Array([1]) };
  trace.record('model-first-text', identity, true);
  trace.record('model-first-text', identity, true);
  assert.equal(trace.snapshot().length, 1);
  assert.doesNotMatch(JSON.stringify(trace.snapshot()), /private speech|samples|"text"/u);
  identity.utteranceIds[0] = 2;
  const copy = trace.snapshot();
  copy[0].utteranceIds![0] = 3;
  assert.deepEqual(trace.snapshot()[0].utteranceIds, [1]);
  for (let i = 0; i < 120; i++) trace.record('tts-started', { sessionId: 's', segmentId: String(i) });
  assert.equal(trace.snapshot().length, 100);
  assert.equal(trace.snapshot()[0].segmentId, '20');
  trace.clear();
  assert.deepEqual(trace.snapshot(), []);
});
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function sentences(raw: string) {
  const stream = new SentenceStream();
  const result = [];
  for (const char of raw) { stream.append(char); let value; while ((value = stream.next())) result.push(value); }
  stream.finish(); let value; while ((value = stream.next())) result.push(value);
  return result;
}
test('streamed zh/ja/en punctuation preserves decimals, abbreviations, source spans and safe code/URL cleanup', () => {
  const raw = '**你好**。Dr. Smith paid 3.14 dollars. 次はどうする？\n```js\nalert("秘密！");\n```\n*点头* [链接](https://example.com/a?q=1)。https://example.com/path.\n（微笑）好的。';
  const parts = sentences(raw);
  assert.equal(parts.map(s => s.rawText).join(''), raw);
  assert.ok(parts.some(s => s.text === 'Dr. Smith paid 3.14 dollars.'));
  const text = parts.map(s => s.text).join('');
  assert.match(text, /你好。.*次はどうする？/u);
  assert.doesNotMatch(text, /alert|秘密|https|点头|微笑|```|\*\*/u);
  for (const part of parts) assert.equal(raw.slice(part.rawStart, part.rawEnd), part.rawText);
  assert.ok(sentences('甲'.repeat(1000)).every(s => s.text.length <= 181), 'long CJK prose stays within sentence limits');
  assert.equal(cleanSpeech('Use `secret()` and **bold**.'), 'Use and bold.');
  assert.equal(cleanSpeech('*Important* detail.'), 'Important detail.');
  assert.doesNotMatch(sentences('*点头！* **可以！继续。**（うなずく！）好。').map(s => s.text).join(''), /点头|うなず/u);
});

test('confirmed sentence boundaries release without a later model token while ambiguous tokens stay buffered', () => {
  for (const raw of ['可以。', '本当？', '好的！', 'Ready!', 'Ready?', 'First line\n', 'Ready. ']) {
    const stream = new SentenceStream(); stream.append(raw);
    const sentence = stream.next();
    assert.ok(sentence, `${JSON.stringify(raw)} must not wait for another delta or EOF`);
    assert.equal(sentence.rawStart, 0);
    assert.equal(sentence.rawText, raw.endsWith(' ') ? raw.trimEnd() : raw);
    assert.equal(sentence.rawEnd, sentence.rawText.length);
  }
  for (const raw of ['Dr.', 'Value 3.', 'Ready.', 'https://example.com/?q=ok!', '**还没完。', '`code!', '（微笑！', '[链接！']) {
    const stream = new SentenceStream(); stream.append(raw);
    assert.equal(stream.next(), undefined, `${JSON.stringify(raw)} remains ambiguous or nonspoken`);
  }
  const decimal = new SentenceStream(); decimal.append('Value 3.');
  assert.equal(decimal.next(), undefined);
  decimal.append('14 dollars. ');
  assert.equal(decimal.next()?.text, 'Value 3.14 dollars.');
});

test('cleaned playback uses source spans and never inserts skipped code into heard history', () => {
  const ledger = new DeliveryLedger();
  ledger.startAttempt('a', 't', 'voice', true);
  const raw = '**你好**。\n```js\nsecret()\n```\n继续吗？';
  ledger.appendGenerated('a', raw);
  const parts = sentences(raw).filter(s => s.text);
  for (let i = 0; i < parts.length; i++) ledger.recordMappedPlayback('a', { ...parts[i], segmentId: 's' + i }, true);
  ledger.setQuestionCandidate('a', 'q', '继续吗？');
  assert.equal(ledger.getPendingQuestion(), undefined);
  ledger.setFinalSegment('a', 's' + (parts.length - 1));
  assert.equal(ledger.getPendingQuestion()?.status, 'awaiting');
  assert.equal(ledger.snapshot()[0].unplayed, '');
  assert.equal(ledger.snapshot()[0].fullyPlayedSegments.map(s => s.text).join(''), '你好。继续吗？');
});

class FakeTts implements SpeechPort {
  requests: SynthesisRequest[] = [];
  callbacks: ((pcm: PCMChunk) => void)[] = [];
  running = 0;
  maxRunning = 0;
  seconds = 4;
  rate = 32000;
  failure = false;
  async synthesize(request: SynthesisRequest, callback: (pcm: PCMChunk) => void) {
    this.requests.push(request); this.callbacks.push(callback);
    this.running++; this.maxRunning = Math.max(this.maxRunning, this.running);
    await Promise.resolve();
    this.running--;
    if (this.failure) throw new Error('MOCK_OOM');
    const samples = this.rate * this.seconds;
    const pcm = Buffer.alloc(samples * 2); for (let i = 0; i < samples; i++) pcm.writeInt16LE(8192, i * 2);
    callback({ ...request, requestId: 'r', chunkSeq: 0, sampleRate: this.rate, channels: 1, format: 'pcm_s16le', samples, pcm });
    return { chunks: 1, samples, canceled: false };
  }
}

/** Exposes the gap between receiving PCM and the worker's terminal result. */
class SettlingTts extends FakeTts {
  finish!: () => void;
  reject!: (error: Error) => void;
  private receivedSamples = 0;
  private receivedChunks = 0;
  async synthesize(request: SynthesisRequest, callback: (pcm: PCMChunk) => void) {
    this.requests.push(request); this.callbacks.push(callback);
    this.running++; this.maxRunning = Math.max(this.maxRunning, this.running);
    try { await new Promise<void>((resolve, reject) => { this.finish = resolve; this.reject = reject; }); }
    finally { this.running--; }
    return { chunks: this.receivedChunks, samples: this.receivedSamples, canceled: false };
  }
  pcm(seconds: number): Float32Array {
    const request = this.requests.at(-1)!;
    const samples = Math.round(this.rate * seconds), pcm = Buffer.alloc(samples * 2);
    const expected = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const value = (this.receivedSamples + i) % 20000 - 10000;
      pcm.writeInt16LE(value, i * 2); expected[i] = value / 32768;
    }
    this.callbacks.at(-1)!({ ...request, requestId: 'r', chunkSeq: this.receivedChunks++, sampleRate: this.rate,
      channels: 1, format: 'pcm_s16le', samples, pcm });
    this.receivedSamples += samples;
    return expected;
  }
}
function outputFixture(tts = new FakeTts()) {
  const events: SpeechOutputEvent[] = [], progress: SpeechProgress[] = [], finals: string[] = [], errors: string[] = [];
  const output = new SpeechOutput({ sessionId: 's', selection: { voiceId: 'voice', referenceId: 'reference', voiceRevision: 3 },
    port: tts, emit: e => events.push(e), onSegment: e => progress.push(e),
    onFinalSegment: (_a, id) => finals.push(id), onError: code => errors.push(code) });
  const delta = (text: string, generationId = 1, attemptId = 'a') => output.handle({ type: 'assistant-delta', turnId: 't', attemptId, generationId, text, source: 'voice' });
  const complete = (generationId = 1, attemptId = 'a') => output.handle({ type: 'assistant-state', turnId: 't', attemptId, generationId, state: 'complete' });
  const chunks = () => events.filter((e): e is Extract<SpeechOutputEvent, { type: 'audio-chunk' }> => e.type === 'audio-chunk');
  const ack = (chunk: ReturnType<typeof chunks>[number], options: { completed?: boolean; queuedSeconds?: number } = {}) => output.playback({ ...chunk,
    playing: !options.completed, paused: false, chunkAccepted: true, segmentCompleted: options.completed, queuedSeconds: options.queuedSeconds ?? 0 });
  return { output, tts, events, progress, finals, errors, delta, complete, chunks, ack };
}

test('validated PCM starts before synthesis settles, retains its tail, and preserves every sample and receipt bound', async () => {
  const tts = new SettlingTts(), f = outputFixture(tts);
  f.delta('首句已经完整。'); await settle();
  assert.equal(tts.requests.length, 1, 'safe punctuation starts TTS before model EOF');
  const expected = tts.pcm(4);
  assert.equal(tts.running, 1);
  assert.equal(f.chunks().length, 1, 'PCM reaches playback before synthesis.completed');
  assert.equal(f.chunks()[0].segmentFinal, false);
  f.ack(f.chunks()[0], { queuedSeconds: 1 });
  f.ack(f.chunks()[1], { queuedSeconds: 2 });
  f.ack(f.chunks()[2], { queuedSeconds: 3 });
  assert.equal(f.chunks().length, 3, 'lookahead still stops at three seconds');
  f.output.playback({ ...f.chunks()[2], chunkAccepted: false, playing: false, paused: false, queuedSeconds: 0, segmentCompleted: true });
  assert.equal(f.progress.filter(p => p.completed).length, 0, 'no receipt completes a settling segment');
  assert.equal(f.chunks().length, 3, 'last PCM chunk remains private even when the renderer is empty');
  f.complete(); tts.finish(); await settle();
  assert.equal(f.chunks().length, 4);
  assert.equal(f.chunks()[3].segmentFinal, true);
  assert.equal(f.chunks()[3].final, true);
  assert.equal(f.progress.filter(p => p.completed).length, 0);
  f.ack(f.chunks()[3], { completed: true });
  assert.equal(f.progress.filter(p => p.completed).length, 1);
  assert.deepEqual(Float32Array.from(f.chunks().flatMap(chunk => Array.from(chunk.samples))), expected);
  assert.deepEqual(f.finals, ['a-s1']);
  await f.output.close();
});

test('partial PCM keeps a short tail through pause and completes only after worker success and actual playback', async () => {
  const tts = new SettlingTts(), f = outputFixture(tts);
  f.delta('完整句。'); f.complete(); await settle();
  tts.pcm(.25);
  assert.equal(f.chunks().length, 0, 'single PCM block cannot be mislabeled final before worker success');
  f.output.command('pause'); tts.pcm(.75); tts.finish(); await settle();
  assert.equal(f.chunks().length, 0, 'settlement does not bypass a candidate interruption');
  f.output.command('resume');
  assert.equal(f.chunks().length, 1);
  assert.equal(f.chunks()[0].segmentFinal, false);
  f.ack(f.chunks()[0]);
  assert.equal(f.chunks()[1].segmentFinal, true);
  f.ack(f.chunks()[1], { completed: true });
  assert.equal(f.progress.filter(p => p.completed).length, 1);
  await f.output.close();
});

test('failure or cancel after early PCM clears playback without delivering the segment or reviving late audio', async () => {
  for (const failure of [true, false]) {
    const tts = new SettlingTts(), f = outputFixture(tts);
    f.delta('提前收到音频。'); f.complete(); await settle();
    tts.pcm(2);
    const early = f.chunks()[0];
    assert.ok(early); assert.equal(early.segmentFinal, false);
    if (failure) tts.reject(new Error('SETTLEMENT_FAILED'));
    else { f.output.command('clear', 2); tts.finish(); }
    await settle();
    const count = f.chunks().length;
    f.ack(early, { completed: true });
    tts.pcm(1); await settle();
    assert.equal(f.chunks().length, count);
    assert.equal(f.progress.filter(p => p.completed).length, 0);
    assert.deepEqual(f.errors, failure ? ['SETTLEMENT_FAILED'] : []);
    assert.ok(f.events.some(event => event.type === 'output-command' && event.command === 'clear' && event.generationId === (failure ? 1 : 2)));
    await f.output.close();
  }
});

test('one synthesis runs, at most two sentences look ahead, pause stops work, and PCM is receipt-driven', async () => {
  const f = outputFixture();
  f.delta('第一句。第二句。第三句。第四句。'); f.complete();
  await settle();
  assert.equal(f.tts.requests.length, 2);
  assert.equal(f.tts.maxRunning, 1);
  assert.equal(f.chunks().length, 1, 'one chunk in transit until acknowledged');
  const first = f.chunks()[0];
  assert.equal(first.samples.length, 32000, 'transport chunks are at most one second');
  f.ack(first, { queuedSeconds: 1 }); assert.equal(f.chunks().length, 2);
  f.ack(first, { queuedSeconds: 0 }); assert.equal(f.chunks().length, 2, 'duplicate acceptance does not release the next in-flight chunk');
  f.ack(f.chunks()[1], { queuedSeconds: 2 }); assert.equal(f.chunks().length, 3);
  f.ack(f.chunks()[2], { queuedSeconds: 3 }); assert.equal(f.chunks().length, 3, 'three-second high water');
  f.output.command('pause');
  f.output.playback({ ...first, playing: false, paused: true, queuedSeconds: 0 });
  assert.equal(f.chunks().length, 3);
  assert.equal(f.tts.requests.length, 2);
  f.output.command('resume');
  assert.equal(f.chunks().length, 4);
  const lastFirst = f.chunks()[3]; assert.equal(lastFirst.segmentFinal, true);
  f.ack(lastFirst, { completed: true }); await settle();
  assert.equal(f.progress.filter(p => p.completed).length, 1);
  assert.equal(f.tts.requests.length, 3, 'completed sentence releases one lookahead slot');
  assert.equal(f.tts.maxRunning, 1);
  await f.output.close();
});

test('generation, attempt and voice identity reject stale receipts; clear suppresses late PCM and retries recover from errors', async () => {
  const f = outputFixture();
  f.delta('前一轮。'); f.complete(); await settle();
  const old = f.chunks()[0];
  f.output.command('clear', 2);
  f.ack(old, { completed: true });
  assert.equal(f.progress.filter(p => p.completed).length, 0);
  const count = f.chunks().length;
  f.tts.callbacks[0]({ ...f.tts.requests[0], requestId: 'late', chunkSeq: 1, sampleRate: 32000, channels: 1, format: 'pcm_s16le', samples: 1, pcm: new Uint8Array(2) });
  assert.equal(f.chunks().length, count);
  f.delta('迟到旧句。', 1); await settle(); assert.equal(f.chunks().length, count);
  f.tts.failure = true; f.delta('新尝试。', 3, 'b'); f.complete(3, 'b'); await settle();
  assert.deepEqual(f.errors, ['MOCK_OOM']);
  f.delta('失败后迟到增量。', 3, 'b'); await settle(); assert.equal(f.tts.requests.length, 2);
  f.tts.failure = false; f.delta('恢复。', 4, 'c'); f.complete(4, 'c'); await settle();
  const current = f.chunks().at(-1)!;
  f.output.playback({ ...current, voiceRevision: 999, chunkAccepted: true, playing: false, paused: false, queuedSeconds: 0 });
  assert.equal(f.chunks().at(-1), current);
  f.ack(current); assert.equal(f.chunks().at(-1)?.chunkSeq, 1);
  await f.output.close();
});

test('text-only turns never synthesize and final segment mapping is derived from actual sentence ids', async () => {
  const f = outputFixture(); f.tts.seconds = 1;
  f.output.handle({ type: 'assistant-delta', turnId: 'text', attemptId: 'txt', generationId: 1, text: '文字备用。', source: 'text' });
  await settle(); assert.equal(f.tts.requests.length, 0);
  f.delta('続けますか？'); f.complete(); await settle();
  assert.equal(f.tts.requests[0].language, 'all_ja');
  assert.deepEqual(f.finals, ['a-s1']);
  const chunk = f.chunks()[0]; f.ack(chunk, { completed: true });
  assert.equal(f.progress.filter(p => p.completed).length, 1);
  f.ack(chunk, { completed: true });
  assert.equal(f.progress.filter(p => p.completed).length, 1, 'completion receipt is idempotent');
  await f.output.close();
});

test('native generation completion still allows stopping pending voice and prevents it entering history', async () => {
  let listener: Parameters<DialoguePort['runTurn']>[1] | undefined;
  const events: DialogueEvent[] = [];
  let complete!: (value: { sessionId: string; status: 'completed' }) => void;
  let cancelCalls = 0;
  const port: DialoguePort = {
    async runTurn(_input, callback) {
      listener = callback;
      return { accepted: true, sessionId: 'native', completed: new Promise(resolve => { complete = resolve; }) };
    }, async cancel() { cancelCalls++; return undefined; },
  };
  const controller = new DialogueController(port, { personaId: 'assistant-neutral', replyLanguage: 'auto', voiceId: 'v' }, e => events.push(e));
  await controller.submit({ text: '请回答', source: 'voice' });
  listener!({ type: 'attempt-start', attemptId: 'a', revision: 1 });
  listener!({ type: 'text', attemptId: 'a', index: 0, revision: 2, text: '**你好**。继续吗？' });
  listener!({ type: 'attempt-end', attemptId: 'a', outcome: 'committed', eventType: 'assistant/message' });
  complete({ sessionId: 'native', status: 'completed' }); await settle();
  assert.equal(controller.isGenerating, false);
  await controller.cancel();
  assert.equal(cancelCalls, 0, 'settled native model does not need another native cancel');
  assert.ok(events.some(e => e.type === 'output-clear'));
  assert.equal(controller.ledger.snapshot()[0].interrupted, true);
  assert.doesNotMatch(JSON.stringify(controller.projectHistory()), /继续吗|你好/u);
  await controller.close();
});

test('complete synthesis-to-worklet receipt loop delivers each cleaned sentence once with bounded queues', async () => {
  const f = outputFixture(); f.tts.seconds = .5;
  const reports: Record<string, unknown>[] = [];
  let Worklet: any;
  class Processor { port = { onmessage: null, postMessage: (message: Record<string, unknown>) => reports.push(message) }; }
  runInNewContext(readFileSync('apps/desktop/renderer/public/worklets/pcm-player.js', 'utf8'), {
    AudioWorkletProcessor: Processor, Float32Array, sampleRate: 48000, currentFrame: 0,
    registerProcessor: (_name: string, type: unknown) => { Worklet = type; },
  });
  const player = new Worklet();
  f.delta('**第一句**。\n```js\nsecret()\n```\n第二句。最後ですか？'); f.complete();
  let eventCursor = 0, maxQueued = 0;
  for (let tick = 0; tick < 1000 && f.progress.filter(p => p.completed).length < 3; tick++) {
    await settle();
    for (; eventCursor < f.events.length; eventCursor++) {
      const event = f.events[eventCursor];
      if (event.type === 'audio-chunk') player.command({ ...event, type: 'enqueue' });
      else if (event.type === 'output-command') player.command({ type: event.command, generationId: event.generationId });
    }
    while (reports.length) f.output.playback(reports.shift() as any);
    maxQueued = Math.max(maxQueued, player.queuedSeconds());
    for (let block = 0; block < 10; block++) player.process([], [[new Float32Array(128)]]);
  }
  assert.equal(f.progress.filter(p => p.completed).map(p => p.text).join(''), '第一句。第二句。最後ですか？');
  assert.equal(new Set(f.progress.filter(p => p.completed).map(p => p.segmentId)).size, 3);
  assert.ok(maxQueued <= 3.01);
  assert.equal(f.tts.maxRunning, 1);
  assert.equal(f.errors.length, 0);
  await f.output.close();
});

test('100 deterministic cancellation/voice-change interleavings never deliver stale segments', async () => {
  for (let i = 0; i < 100; i++) {
    const f = outputFixture(); f.tts.seconds = .01;
    f.delta('旧声音。'); f.complete();
    if (i % 3 !== 0) await settle();
    if (i % 2) f.output.command('pause');
    const oldChunks = [...f.chunks()];
    f.output.command('clear', 2);
    f.output.setSelection({ voiceId: 'new-voice', referenceId: 'new-ref', voiceRevision: 4 });
    for (const old of oldChunks) f.ack(old, { completed: true });
    f.delta('迟到。', 1, 'a');
    f.delta('新声音。', 3, 'b'); f.complete(3, 'b'); await settle();
    const current = f.chunks().filter(c => c.generationId === 3);
    assert.equal(current.length, 1, 'new generation emits its own PCM');
    assert.equal(current[0].voiceRevision, 4);
    f.ack(current[0], { completed: true });
    assert.deepEqual(f.progress.filter(p => p.completed).map(p => p.text), ['新声音。']);
    assert.equal(f.errors.length, 0);
    await f.output.close();
  }
});
