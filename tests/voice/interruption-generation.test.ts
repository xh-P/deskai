import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputController, type Interruption } from '../../packages/voice-core/src/index.ts';
import { DialogueController, type DialogueEvent, type DialoguePort } from '../../packages/voice-core/src/dialogue.ts';
import { SpeechOutput, type SpeechOutputEvent, type SpeechPort } from '../../apps/desktop/src/speech-output.ts';
import type { ChatEvent, ChatSettlement } from '../../packages/dsh-adapter/src/session.ts';
import type { SynthesisRequest } from '../../packages/tts-adapter/src/index.ts';

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

test('one sustained interruption clears once and the next dialogue reply reaches speech synthesis', async () => {
  let modelEvent: ((event: ChatEvent) => void) | undefined;
  let finishModel: ((settlement: ChatSettlement) => void) | undefined;
  const port: DialoguePort = {
    async runTurn(_input, callback) {
      modelEvent = callback;
      const completed = new Promise<ChatSettlement>(resolve => { finishModel = resolve; });
      return { accepted: true, sessionId: 'model', completed };
    },
    async cancel() { finishModel?.({ sessionId: 'model', status: 'cancelled' }); return undefined; },
  };
  const requests: SynthesisRequest[] = [];
  const speechPort: SpeechPort = {
    async synthesize(request, onPCM) {
      requests.push(request);
      onPCM({ ...request, requestId: `pcm-${requests.length}`, chunkSeq: 0, sampleRate: 32000,
        channels: 1, format: 'pcm_s16le', samples: 16000, pcm: new Uint8Array(32000) });
      return { chunks: 1, samples: 16000, canceled: false };
    },
    async cancel() { return undefined; },
  };
  const interruptions: Interruption[] = [];
  const speechEvents: SpeechOutputEvent[] = [];
  let outputBusy = false;
  let outputPaused = false;
  let dialogue!: DialogueController;
  let input!: ReturnType<typeof createInputController>;
  const output = new SpeechOutput({ sessionId: 's', port: speechPort, emit: event => {
    speechEvents.push(event);
    if (event.type === 'speech-state') outputBusy = event.state !== 'idle' && event.state !== 'error';
  } });
  const onDialogue = (event: DialogueEvent) => {
    output.handle(event);
    if (event.type === 'output-clear') outputPaused = false;
    input?.setOutput({ generationId: dialogue.generationId,
      playing: outputBusy || outputPaused || dialogue.isGenerating, expectsReply: false });
  };
  dialogue = new DialogueController(port, { personaId: 'assistant-neutral', replyLanguage: 'auto', voiceId: 'v' }, onDialogue);
  input = createInputController({ interruptionCandidateMs: 200, interruptionConfirmMs: 800,
    onInterruption: event => {
      interruptions.push(event);
      if (event.type === 'candidate') { outputPaused = true; output.command('pause', event.generationId); }
      else if (event.type === 'resume') { outputPaused = false; output.command('resume', event.generationId); }
      else { outputPaused = false; void dialogue.cancel(); }
    } });
  output.setSelection({ voiceId: 'v', voiceRevision: 0 });
  input.start('s');
  await dialogue.submit({ text: '先回答', source: 'voice' });
  modelEvent!({ type: 'attempt-start', attemptId: 'first', revision: 1 });
  modelEvent!({ type: 'text', attemptId: 'first', index: 0, revision: 2, text: '第一句。' });
  await settle();
  assert.equal(requests.length, 1);
  for (let i = 0; i < 45; i++) {
    input.setOutput({ generationId: dialogue.generationId,
      playing: outputBusy || outputPaused || dialogue.isGenerating, expectsReply: false });
    input.pushFrame({ samples: new Float32Array(512).fill(.2), probability: 1, sampleStart: i * 512 });
  }
  await settle();
  assert.deepEqual(interruptions.map(event => event.type), ['candidate', 'confirmed'],
    'one continuous utterance must give one interruption, even after output generation changes');
  assert.equal(dialogue.generationId, 2);
  assert.equal(outputBusy, false, 'clear releases the paused speech state');
  assert.ok(speechEvents.some(event => event.type === 'speech-state' && event.state === 'idle'));
  await dialogue.submit({ text: '接着回答', source: 'voice' });
  modelEvent!({ type: 'attempt-start', attemptId: 'second', revision: 1 });
  modelEvent!({ type: 'text', attemptId: 'second', index: 0, revision: 2, text: '第二句。' });
  await settle();
  assert.deepEqual(requests.map(request => request.generationId), [1, 3],
    'new dialogue generation remains above speech output floor and starts TTS');
  await dialogue.close();
  await output.close();
  input.stop();
});
