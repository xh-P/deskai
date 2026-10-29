import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { SentenceStream, cleanSpeech } from '../../packages/voice-core/src/sentences.ts';
import { DeliveryLedger } from '../../packages/voice-core/src/delivery.ts';
import { DialogueController, type DialoguePort, type DialogueEvent } from '../../packages/voice-core/src/dialogue.ts';
import { SpeechOutput, type SpeechOutputEvent, type SpeechPort, type SpeechProgress } from '../../apps/desktop/src/speech-output.ts';
import type { PCMChunk, SynthesisRequest } from '../../packages/tts-adapter/src/index.ts';

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const speechHeader = { v: 1, action: 'SPEAK', reason: 'direct_request', expectsReply: true } as const;
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

test('cleaned playback uses source spans and never inserts skipped code into heard history', () => {
  const ledger = new DeliveryLedger();
  ledger.startAttempt('a', 't', speechHeader, 'voice');
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
  cancelCalls = 0;
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
  async cancel() { this.cancelCalls++; }
}
function outputFixture(tts = new FakeTts()) {
  const events: SpeechOutputEvent[] = [], progress: SpeechProgress[] = [], finals: string[] = [], errors: string[] = [];
  const output = new SpeechOutput({ sessionId: 's', port: tts, emit: e => events.push(e), onSegment: e => progress.push(e),
    onFinalSegment: (_a, id) => finals.push(id), onError: code => errors.push(code) });
  output.setSelection({ voiceId: 'voice', referenceId: 'reference', voiceRevision: 3 });
  const delta = (text: string, generationId = 1, attemptId = 'a') => output.handle({ type: 'assistant-delta', turnId: 't', attemptId, generationId, text, source: 'voice' });
  const complete = (generationId = 1, attemptId = 'a') => output.handle({ type: 'assistant-state', turnId: 't', attemptId, generationId, state: 'complete' });
  const chunks = () => events.filter((e): e is Extract<SpeechOutputEvent, { type: 'audio-chunk' }> => e.type === 'audio-chunk');
  const ack = (chunk: ReturnType<typeof chunks>[number], options: { completed?: boolean; queuedSeconds?: number } = {}) => output.playback({ ...chunk,
    playing: !options.completed, paused: false, chunkAccepted: true, segmentCompleted: options.completed, queuedSeconds: options.queuedSeconds ?? 0 });
  return { output, tts, events, progress, finals, errors, delta, complete, chunks, ack };
}

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
  listener!({ type: 'text', attemptId: 'a', index: 0, revision: 2, text: JSON.stringify(speechHeader) + '\n**你好**。继续吗？' });
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
    AudioWorkletProcessor: Processor, Float32Array, sampleRate: 48000,
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
