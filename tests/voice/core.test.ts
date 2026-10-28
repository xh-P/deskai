import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputController, classifyLocalText, StreamingResampler, encodePcm16Wav } from '../../packages/voice-core/src/index.ts';
import type { Segment, Ready, Boundary, Interruption } from '../../packages/voice-core/src/index.ts';

const frame = (probability: number, length = 160, value = 0.2) => ({ samples: new Float32Array(length).fill(value), probability });
const feed = (controller: ReturnType<typeof createInputController>, probability: number, count: number, length = 160) => {
  for (let i = 0; i < count; i++) controller.pushFrame(frame(probability, length));
};
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('receipt after a newer onset consumes only the submitted prefix without resending it', async () => {
  const ready: Ready[] = [];
  const controller = createInputController({ transcribe: async segment => 'text' + segment.utteranceId, onReady: item => ready.push(item) });
  controller.start('a'); feed(controller, 1, 30); feed(controller, 0, 60); await settle();
  const first = ready[0];
  feed(controller, 1, 10);
  controller.markAccepted(first.inputRevision, first.utteranceIds);
  feed(controller, 0, 60); await settle();
  assert.deepEqual(ready.at(-1)?.utteranceIds, [2]);
  assert.equal(ready.at(-1)?.text, 'text2');
});

test('receipt after a fully transcribed continuation rebuilds only the unsubmitted remainder', async () => {
  const ready: Ready[] = [];
  const controller = createInputController({ transcribe: async segment => 'text' + segment.utteranceId, onReady: item => ready.push(item) });
  controller.start('a'); feed(controller, 1, 30); feed(controller, 0, 60); await settle();
  const first = ready[0];
  feed(controller, 1, 30); feed(controller, 0, 60); await settle();
  assert.equal(ready.at(-1)?.text, 'text1 text2');
  controller.markAccepted(first.inputRevision, first.utteranceIds);
  controller.reevaluateReady();
  assert.deepEqual(ready.at(-1)?.utteranceIds, [2]);
  assert.equal(ready.at(-1)?.text, 'text2');
});

test('ending capture drops pre-roll and prior playback context before a new session', async () => {
  const segments: Segment[] = [], interruptions: Interruption[] = [];
  const controller = createInputController({ onSegment: segment => segments.push(segment), onInterruption: event => interruptions.push(event) });
  controller.start('old');
  controller.setOutput({ generationId: 8, playing: true, expectsReply: false });
  for (let i = 0; i < 25; i++) controller.pushFrame(frame(0, 160, 0.9));
  controller.stop();
  controller.start('new');
  feed(controller, 1, 90); feed(controller, 0, 60);
  await settle();
  assert.equal(segments[0].startSample, 0);
  assert.ok(Math.abs(segments[0].samples[0] - 0.2) < 1e-6);
  assert.equal(interruptions.length, 0);
});

test('punctuation-only ASR restores a candidate without creating a user turn', async () => {
  const interruptions: Interruption[] = [], ready: Ready[] = [];
  const controller = createInputController({ transcribe: async () => '……？', onInterruption: event => interruptions.push(event), onReady: event => ready.push(event) });
  controller.start('a');
  controller.setOutput({ generationId: 1, playing: true, expectsReply: false });
  feed(controller, 1, 30); feed(controller, 0, 60);
  await settle();
  assert.equal(ready.length, 0);
  assert.deepEqual(interruptions.map(event => event.type), ['candidate', 'resume']);
});

test('ASR supplied period after a trailing conditional still waits for continuation', async () => {
  const ready: Ready[] = [];
  let calls = 0;
  const controller = createInputController({ transcribe: async () => ++calls === 1 ? '你回来了。 如果愿意的话。' : '可以和我说说。', onReady: event => ready.push(event) });
  controller.start('a');
  feed(controller, 1, 30); feed(controller, 0, 60); await settle();
  assert.equal(ready.length, 0);
  feed(controller, 1, 30); feed(controller, 0, 60); await settle();
  assert.equal(ready.length, 1);
  assert.deepEqual(ready[0].utteranceIds, [1, 2]);
});

test('complete conditional and explicit questions are not held by the unfinished gate', async () => {
  for (const text of ['如果下雨，就先休息。', '如果明天下雨怎么办？', 'If you are free, please call me.']) {
    const ready: Ready[] = [];
    const controller = createInputController({ transcribe: async () => text, onReady: event => ready.push(event) });
    controller.start('a');
    feed(controller, 1, 30); feed(controller, 0, 60); await settle();
    assert.equal(ready.length, 1, text);
  }
});

test('pre-roll once, 600 ms endpoint, nonoverlapping intervals, and continuing revision', async () => {
  const segments: Segment[] = [], ready: Ready[] = [], boundaries: Boundary[] = [];
  const controller = createInputController({ transcribe: async s => `text${s.utteranceId}`, onSegment: s => segments.push(s), onReady: r => ready.push(r), onBoundary: b => boundaries.push(b) });
  controller.start('a');
  feed(controller, 0, 25);
  feed(controller, 1, 10);
  feed(controller, 0, 60);
  await settle();
  assert.equal(segments.length, 1);
  assert.equal(segments[0].startSample, 0);
  assert.equal(segments[0].endSample, 15200);
  assert.equal(segments[0].samples.length, 15200);
  assert.equal(ready[0].text, 'text1');
  assert.equal(controller.isEligible(ready[0].inputRevision, ready[0].utteranceIds), true);
  feed(controller, 1, 10);
  assert.equal(controller.isEligible(ready[0].inputRevision, ready[0].utteranceIds), false);
  assert.equal(boundaries.at(-1)?.type, 'revoked');
  feed(controller, 0, 60);
  await settle();
  assert.equal(segments[1].startSample, segments[0].endSample);
  assert.equal(ready.at(-1)?.text, 'text1 text2');
  assert.deepEqual(ready.at(-1)?.utteranceIds, [1, 2]);
});

test('ASR in flight survives new onset and merges in original order', async () => {
  const resolutions: ((text: string) => void)[] = [], ready: Ready[] = [];
  const controller = createInputController({ transcribe: () => new Promise(resolve => resolutions.push(resolve)), onReady: x => ready.push(x) });
  controller.start('a');
  feed(controller, 1, 10); feed(controller, 0, 60); await settle();
  feed(controller, 1, 10); feed(controller, 0, 60); await settle();
  assert.equal(resolutions.length, 1);
  resolutions[0]('first'); await settle();
  assert.equal(resolutions.length, 2);
  resolutions[1]('second'); await settle();
  assert.equal(ready.at(-1)?.text, 'first second');
});

test('unfinished text waits 1200 ms after last speech and new onset revokes readiness', async () => {
  const ready: Ready[] = [];
  const controller = createInputController({ transcribe: async () => '如果我明天', onReady: x => ready.push(x) });
  controller.start('a');
  feed(controller, 1, 10); feed(controller, 0, 60); await settle();
  assert.equal(ready.length, 0);
  feed(controller, 0, 60);
  assert.equal(ready.length, 1);
  feed(controller, 1, 1);
  assert.equal(controller.isEligible(ready[0].inputRevision, ready[0].utteranceIds), false);
});

test('playing permits capture, candidate resumes for backchannel, yes after question forwards', async () => {
  const interrupts: Interruption[] = [], ready: Ready[] = [];
  let text = '嗯';
  const controller = createInputController({ transcribe: async () => text, onInterruption: x => interrupts.push(x), onReady: x => ready.push(x) });
  controller.start('a'); controller.setOutput({ generationId: 7, playing: true, expectsReply: false });
  feed(controller, 1, 30); feed(controller, 0, 60); await settle();
  assert.deepEqual(interrupts.map(x => x.type), ['candidate', 'resume']);
  assert.equal(ready.length, 0);
  controller.setOutput({ generationId: 7, playing: true, expectsReply: true });
  feed(controller, 1, 30); feed(controller, 0, 60); await settle();
  assert.equal(ready.at(-1)?.text, '嗯');
  assert.equal(interrupts.at(-1)?.type, 'confirmed');
  assert.equal(classifyLocalText('はい', { playing: true, expectsReply: false }), 'forward');
  assert.equal(classifyLocalText('no', { playing: true, expectsReply: true }), 'forward');
});

test('800 ms sustained speech confirms without waiting for ASR', () => {
  const interrupts: Interruption[] = [];
  const controller = createInputController({ onInterruption: x => interrupts.push(x) });
  controller.start('a'); controller.setOutput({ generationId: 3, playing: true, expectsReply: false });
  feed(controller, 1, 80);
  assert.deepEqual(interrupts.map(x => x.type), ['candidate', 'confirmed']);
});

test('stop expression is narrow and does not submit LLM text', async () => {
  const ready: Ready[] = [], interrupts: Interruption[] = [];
  const controller = createInputController({ transcribe: async () => '别说了', onReady: x => ready.push(x), onInterruption: x => interrupts.push(x) });
  controller.start('a'); controller.setOutput({ generationId: 1, playing: true, expectsReply: false });
  feed(controller, 1, 10); feed(controller, 0, 60); await settle();
  assert.equal(ready.length, 0);
  assert.equal(interrupts.at(-1)?.type, 'confirmed');
  assert.equal(classifyLocalText('不要停，接着说', { playing: true, expectsReply: false }), 'backchannel');
  assert.equal(classifyLocalText('他说了 stop', { playing: true, expectsReply: false }), 'forward');
});

test('long speech slices at smaller catalog cap without semantic readiness', async () => {
  const segments: Segment[] = [], ready: Ready[] = [];
  const controller = createInputController({ maxSegmentSeconds: 1, transcribe: async () => 'part', onSegment: x => segments.push(x), onReady: x => ready.push(x) });
  controller.start('a');
  feed(controller, 1, 250); await settle();
  assert.ok(segments.length >= 2);
  assert.equal(ready.length, 0);
  assert.equal(segments[0].endSample, segments[1].startSample);
  feed(controller, 0, 60); await settle();
  assert.ok(ready.length > 0);
});

test('bounded queue reports overflow and cannot silently produce incomplete ready', async () => {
  const boundaries: Boundary[] = [], ready: Ready[] = [];
  const controller = createInputController({ maxSegmentSeconds: 1, maxQueuedSegments: 1, transcribe: () => new Promise(() => {}), onBoundary: x => boundaries.push(x), onReady: x => ready.push(x) });
  controller.start('a');
  feed(controller, 1, 350);
  assert.ok(boundaries.some(x => x.type === 'overflow'));
  assert.equal(ready.length, 0);
});

test('stop/start cancels old ASR and isolates late result', async () => {
  let resolveOld!: (text: string) => void;
  const ready: Ready[] = [];
  let calls = 0;
  const controller = createInputController({ transcribe: () => ++calls === 1 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve('new'), onReady: x => ready.push(x) });
  controller.start('old'); feed(controller, 1, 10); feed(controller, 0, 60); await settle();
  controller.start('new'); feed(controller, 1, 10); feed(controller, 0, 60); await settle();
  assert.equal(calls, 1, 'new ASR must wait for old cancellation to settle');
  resolveOld('old'); await settle();
  assert.equal(calls, 2);
  assert.deepEqual(ready.map(x => [x.sessionId, x.text]), [['new', 'new']]);
});

test('ASR failure discards current accumulation and next speech can proceed', async () => {
  let calls = 0;
  const boundaries: Boundary[] = [], ready: Ready[] = [];
  const controller = createInputController({ transcribe: async () => ++calls === 1 ? Promise.reject(new Error('ASR down')) : 'recovered',
    onBoundary: x => boundaries.push(x), onReady: x => ready.push(x) });
  controller.start('a');
  feed(controller, 1, 10); feed(controller, 0, 60); await settle();
  assert.ok(boundaries.some(x => x.type === 'discarded' && x.reason === 'incomplete ASR accumulation'));
  feed(controller, 1, 10); feed(controller, 0, 60); await settle();
  assert.equal(ready.at(-1)?.text, 'recovered');
});

test('queue overflow discards bounded accumulation then accepts a new utterance', async () => {
  let resolveFirst!: (text: string) => void;
  let calls = 0;
  const boundaries: Boundary[] = [], ready: Ready[] = [];
  const controller = createInputController({ maxSegmentSeconds: 1, maxQueuedSegments: 1,
    transcribe: () => ++calls === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve('next'),
    onBoundary: x => boundaries.push(x), onReady: x => ready.push(x) });
  controller.start('a');
  feed(controller, 1, 200); feed(controller, 0, 60); await settle();
  assert.ok(boundaries.some(x => x.type === 'overflow'));
  assert.equal(ready.length, 0);
  resolveFirst('partial'); await settle();
  assert.ok(boundaries.some(x => x.type === 'discarded' && x.reason === 'incomplete ASR accumulation'));
  feed(controller, 1, 10); feed(controller, 0, 60); await settle();
  assert.equal(ready.at(-1)?.text, 'next');
});

test('empty ASR after candidate restores old playback', async () => {
  const interrupts: Interruption[] = [];
  const controller = createInputController({ transcribe: async () => '', onInterruption: x => interrupts.push(x) });
  controller.start('a'); controller.setOutput({ generationId: 1, playing: true, expectsReply: false });
  feed(controller, 1, 25); feed(controller, 0, 60); await settle();
  assert.deepEqual(interrupts.map(x => x.type), ['candidate', 'resume']);
});

test('ducked playback stays in interruption context for 800 ms confirm and short backchannel resume', async () => {
  const events: Interruption[] = [];
  let text = '嗯';
  const controller = createInputController({ transcribe: async () => text, onInterruption: event => {
    events.push(event);
    if (event.type === 'candidate') controller.setOutput({ generationId: event.generationId, playing: false, expectsReply: false });
  } });
  controller.start('a'); controller.setOutput({ generationId: 1, playing: true, expectsReply: false });
  feed(controller, 1, 30); feed(controller, 0, 60); await settle();
  assert.deepEqual(events.map(x => x.type), ['candidate', 'resume']);
  controller.setOutput({ generationId: 2, playing: true, expectsReply: false });
  text = 'new request';
  feed(controller, 1, 80);
  assert.deepEqual(events.slice(2).map(x => x.type), ['candidate', 'confirmed']);
});

test('short false onset never pauses output', async () => {
  const events: Interruption[] = [];
  const controller = createInputController({ transcribe: async () => '', onInterruption: x => events.push(x) });
  controller.start('a'); controller.setOutput({ generationId: 1, playing: true, expectsReply: false });
  feed(controller, 1, 10); feed(controller, 0, 60); await settle();
  assert.deepEqual(events, []);
});

test('PCM is absent from pending text records and released after submission', async () => {
  const ready: Ready[] = [];
  const controller = createInputController({ transcribe: async () => 'hello', onReady: x => ready.push(x) });
  controller.start('a');
  feed(controller, 1, 10); feed(controller, 0, 60); await settle();
  const internal = controller as unknown as { pending: Map<number, object>; queue: Segment[]; active: Float32Array[]; preRollLength: number };
  assert.equal(internal.queue.length, 0);
  assert.equal(internal.active.length, 0);
  assert.deepEqual([...internal.pending.values()].map(record => Object.keys(record)), [['text']]);
  controller.markSubmitted(ready[0].utteranceIds);
  assert.equal(internal.pending.size, 0);
  assert.ok(internal.preRollLength <= 4000);
});

test('continuationOf applies only to a prompt continuation within 1200 ms', async () => {
  const ready: Ready[] = [];
  const controller = createInputController({ transcribe: async s => `text${s.utteranceId}`, onReady: x => ready.push(x) });
  controller.start('a');
  feed(controller, 1, 10); feed(controller, 0, 60); await settle();
  controller.markSubmitted(ready.at(-1)!.utteranceIds);
  feed(controller, 1, 10); feed(controller, 0, 60); await settle();
  assert.equal(ready.at(-1)?.continuationOf, 1);
  controller.markSubmitted(ready.at(-1)!.utteranceIds);
  feed(controller, 0, 121);
  feed(controller, 1, 10); feed(controller, 0, 60); await settle();
  assert.equal(ready.at(-1)?.continuationOf, undefined);
});

test('streaming resampling 32/48 kHz keeps tone frequency and suppresses alias', () => {
  for (const rate of [32000, 48000]) {
    const resampler = new StreamingResampler(rate);
    const output: Float32Array[] = [];
    const source = Float32Array.from({ length: rate }, (_, i) => Math.sin(2 * Math.PI * 1000 * i / rate));
    for (let i = 0; i < source.length; i += 333) output.push(resampler.push(source.slice(i, i + 333)));
    output.push(resampler.flush());
    const result = Float32Array.from(output.flatMap(chunk => [...chunk]));
    assert.equal(result.length, 16000);
    const lag = 16;
    let correlation = 0, energy = 0;
    for (let i = 100; i < result.length - lag; i++) { correlation += result[i] * result[i + lag]; energy += result[i] ** 2; }
    assert.ok(correlation / energy > 0.98);
    const high = new StreamingResampler(rate);
    const aliasSource = Float32Array.from({ length: rate }, (_, i) => Math.sin(2 * Math.PI * 10000 * i / rate));
    const aliased = Float32Array.from([...high.push(aliasSource), ...high.flush()]);
    const rms = Math.sqrt(aliased.reduce((sum, x) => sum + x * x, 0) / aliased.length);
    assert.ok(rms < 0.04, `${rate} alias RMS ${rms}`);
  }
});

test('WAV encodes 16 kHz mono PCM16 with clipped values', () => {
  const wav = encodePcm16Wav(Float32Array.of(-2, 0, 2));
  const view = new DataView(wav.buffer);
  assert.equal(wav.length, 50);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(48, true), 32767);
});
