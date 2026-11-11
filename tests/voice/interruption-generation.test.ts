import test from 'node:test';
import assert from 'node:assert/strict';
import { BargeInDetector, type VadFrame } from '../../apps/desktop/renderer/src/barge-in.ts';
import { rms } from '../../apps/desktop/renderer/src/echo-guard.ts';
import { loadInputRuntimeConfig } from '../../apps/desktop/src/speech-runtime.ts';
import { SpeechOutput, type SpeechOutputEvent, type SpeechPort } from '../../apps/desktop/src/speech-output.ts';
import { DialogueController, type DialoguePort } from '../../packages/voice-core/src/dialogue.ts';
import { INPUT_RATE, VAD_FRAME_SAMPLES } from '../../packages/voice-core/src/input-config.ts';
import type { ChatEvent, ChatSettlement } from '../../packages/dsh-adapter/src/session.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const { interruption, endpoint } = await loadInputRuntimeConfig(process.cwd());
const referenceAt = (i: number) => {
  if (i < 0) return 0;
  const frequency = [180, 330, 720, 1140][Math.floor(i / 1280) % 4];
  return 0.2 * Math.sin(2 * Math.PI * frequency * i / INPUT_RATE);
};

test('an acoustic match leaves playback alone and attenuated near-end speech reaches ASR with its onset', async () => {
  for (const webRtc of [false, true]) {
    const detector = new BargeInDetector(interruption, endpoint);
    const admitted: VadFrame[] = [];
    let cursor = 0;
    const push = async (kind: 'echo' | 'near-end' | 'weak' | 'quiet') => {
      const reference = Float32Array.from({ length: VAD_FRAME_SAMPLES }, (_, i) => referenceAt(cursor + i));
      const near = Float32Array.from(reference, (_, i) => {
        const at = cursor + i;
        const frequency = [220, 390, 800, 1230][Math.floor(at / 1280) % 4];
        return 0.16 * Math.sin(2 * Math.PI * frequency * at / INPUT_RATE);
      });
      const mic = kind === 'near-end' ? near : kind === 'weak' ? Float32Array.from(near, value => value * 0.08) : kind === 'echo'
        ? Float32Array.from(reference, (_, i) => referenceAt(cursor + i - 1130) * 0.7 + referenceAt(cursor + i - 1210) * 0.1)
        : new Float32Array(VAD_FRAME_SAMPLES);
      const samples = webRtc ? Float32Array.from(mic, value => value * 0.01) : mic;
      admitted.push(...await detector.process({ sampleStart: cursor, contextFrameEnd: 0, samples, raw: webRtc ? mic : undefined, reference },
        1, async frame => rms(frame) > 0.02 ? 0.95 : 0));
      cursor += VAD_FRAME_SAMPLES;
    };

    for (let i = 0; i < 24; i++) await push('echo');
    assert.ok(admitted.length >= 20);
    assert.ok(admitted.every(frame => frame.probability === 0 && rms(frame.samples) === 0));
    for (let i = 0; i < 3; i++) await push('quiet');
    await push('near-end');
    await push('quiet');
    await push('quiet');
    assert.ok(admitted.every(frame => frame.interruptGeneration === undefined), 'one short spike leaves playback running');

    const weakOnset = cursor;
    await push('weak');
    const onset = cursor;
    for (let i = 0; i < 9; i++) await push('near-end');
    assert.deepEqual(admitted.flatMap(frame => frame.interruptGeneration ?? []), [1]);
    assert.equal(admitted.find(frame => frame.interruptGeneration === 1)?.sampleStart, onset);
    assert.ok(rms(admitted.find(frame => frame.sampleStart === weakOnset)!.samples) > 0.007);
    assert.ok(rms(admitted.find(frame => frame.sampleStart === onset)!.samples) > 0.1);
    assert.ok(admitted.every((frame, i) => frame.sampleStart === i * VAD_FRAME_SAMPLES));
  }
});

test('repeated interruption clears each generation once and the next PCM waits for the aborted synthesis to settle', async () => {
  let emitModel!: (event: ChatEvent) => void;
  let finishModel!: (settlement: ChatSettlement) => void;
  const port: DialoguePort = {
    async runTurn(_input, callback) {
      emitModel = callback;
      const completed = new Promise<ChatSettlement>(resolve => { finishModel = resolve; });
      return { accepted: true, sessionId: 'model', completed };
    },
    async cancel() { finishModel({ sessionId: 'model', status: 'cancelled' }); return undefined; },
  };
  const jobs: { generationId: number; signal: AbortSignal; finish: () => void }[] = [];
  const speechPort: SpeechPort = {
    async synthesize(request, onPCM, signal) {
      const done = new Promise<void>(resolve => { jobs.push({ generationId: request.generationId, signal: signal!, finish: resolve }); });
      onPCM({ ...request, requestId: request.segmentId, chunkSeq: 0, sampleRate: 32000,
        channels: 1, format: 'pcm_s16le', samples: 64000, pcm: new Uint8Array(128000) });
      await done;
      return { chunks: 1, samples: 64000, canceled: signal!.aborted };
    },
  };
  const speechEvents: SpeechOutputEvent[] = [];
  const progress: number[] = [];
  const output = new SpeechOutput({ sessionId: 's', port: speechPort, emit: event => speechEvents.push(event),
    onSegment: segment => { if (segment.completed) progress.push(segment.generationId); } });
  const dialogue = new DialogueController(port, { personaId: 'assistant-neutral', replyLanguage: 'auto', voiceId: 'v' },
    event => output.handle(event));
  const reply = async () => {
    assert.equal((await dialogue.submit({ text: '回答', source: 'voice' })).accepted, true);
    const generation = dialogue.generationId;
    const attemptId = 'attempt-' + generation;
    emitModel({ type: 'attempt-start', attemptId, revision: 1 });
    emitModel({ type: 'text', attemptId, index: 0, revision: 2, text: '这一轮继续播报。' });
    await tick();
    return generation;
  };
  let generation = await reply();
  for (let i = 0; i < 3; i++) {
    const job = jobs.at(-1)!;
    assert.equal(job.generationId, generation);
    await dialogue.cancelOutput(generation);
    await dialogue.cancelOutput(generation);
    assert.equal(dialogue.generationId, generation + 1);
    assert.equal(job.signal.aborted, true);
    const oldGeneration = generation;
    generation = await reply();
    await dialogue.cancelOutput(oldGeneration);
    assert.equal(dialogue.generationId, generation);
    assert.equal(jobs.at(-1), job, 'the old worker still owns the synthesis slot');
    job.finish();
    await tick();
    assert.equal(jobs.at(-1)?.generationId, generation);
  }
  finishModel({ sessionId: 'model', status: 'completed' });
  jobs.at(-1)!.finish();
  await tick();
  for (const event of speechEvents) {
    if (event.type === 'audio-chunk') output.playback({ ...event, playing: !event.segmentFinal, paused: false,
      chunkAccepted: true, segmentCompleted: event.segmentFinal, queuedSeconds: 0 });
  }
  assert.deepEqual(progress, [generation]);
  assert.deepEqual(jobs.map(job => job.generationId), [1, 3, 5, 7]);
  await dialogue.close();
  await output.close();
});
