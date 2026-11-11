import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputController } from '../../packages/voice-core/src/index.ts';
import { DialogueController, type DialogueEvent, type DialoguePort } from '../../packages/voice-core/src/dialogue.ts';
import type { ChatEvent, ChatSettlement, ChatTurnInput } from '../../packages/dsh-adapter/src/session.ts';
import { SpeechOutput } from '../../apps/desktop/src/speech-output.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const preferences = { personaId: 'assistant-neutral', replyLanguage: 'auto', voiceId: 'v' } as const;

type Call = { input: ChatTurnInput; emit: (event: ChatEvent) => void; finish: (status: ChatSettlement['status']) => ChatSettlement };
class Port implements DialoguePort {
  calls: Call[] = [];
  cancels = 0;
  active?: Call;
  async runTurn(input: ChatTurnInput, emit: Call['emit']) {
    assert.equal(this.active, undefined);
    const sessionId = 'request-' + this.calls.length;
    let resolve!: (result: ChatSettlement) => void;
    const completed = new Promise<ChatSettlement>(done => { resolve = done; });
    const call: Call = { input, emit, finish: status => {
      if (this.active === call) this.active = undefined;
      const result = { sessionId, status };
      resolve(result);
      return result;
    } };
    this.active = call;
    this.calls.push(call);
    return { accepted: true as const, sessionId, completed };
  }
  async cancel() {
    if (!this.active) return undefined;
    this.cancels++;
    return this.active.finish('cancelled');
  }
}

function speak(call: Call, attemptId: string, text: string) {
  call.emit({ type: 'attempt-start', attemptId, revision: 1 });
  call.emit({ type: 'text', attemptId, index: 0, revision: 2, text });
}

test('resumed speech revokes the first candidate and the matching final turn releases only its own buffered reply', async () => {
  const ordinary = new Port(), speculative = new Port();
  const events: DialogueEvent[] = [];
  const synthesis: string[] = [];
  const output = new SpeechOutput({ sessionId: 's', emit: () => {}, port: {
    async synthesize(request, onPCM) {
      synthesis.push(request.text);
      onPCM({ ...request, requestId: 'pcm', chunkSeq: 0, sampleRate: 32000, channels: 1,
        format: 'pcm_s16le', samples: 32, pcm: new Uint8Array(64) });
      return { chunks: 1, samples: 32, canceled: false };
    },
  } });
  const dialogue = new DialogueController(ordinary, preferences, event => { events.push(event); output.handle(event); },
    { port: speculative, maxAgeMs: 12000 });
  let transcriptions = 0, receipts = 0;
  const input = createInputController({ candidateWindowMs: 160, continuationWindowMs: 350,
    transcribe: async () => ++transcriptions === 1 ? '今天' : '今天天气怎么样？',
    onCandidate: candidate => {
      dialogue.prepareSpeculative({ ...candidate, source: 'voice', speculation: candidate, hostContext: { receipt: { kind: 'chat' } } });
    },
    onCandidateRevoked: candidate => dialogue.discardSpeculative(candidate),
    onReady: ready => {
      void dialogue.submit({ ...ready, source: 'voice', speculation: ready, hostContext: { receipt: { kind: 'chat' } },
        isEligible: () => input.isEligible(ready.inputRevision, ready.utteranceIds),
        onAccepted: () => { receipts++; input.markAccepted(ready.inputRevision, ready.utteranceIds); },
      });
    },
  });
  const feed = (probability: number, frames: number) => {
    for (let i = 0; i < frames; i++) input.pushFrame({ samples: new Float32Array(160), probability });
  };
  input.start('s');
  feed(1, 20); feed(0, 16);
  await tick();
  assert.equal(speculative.calls.length, 1);
  speak(speculative.calls[0], 'stale', '候选回复。');
  assert.deepEqual(events, []);
  assert.deepEqual(synthesis, []);

  feed(1, 20); feed(0, 16);
  await tick();
  assert.equal(speculative.cancels, 1);
  speculative.calls[0].emit({ type: 'text', attemptId: 'stale', index: 1, revision: 3, text: '迟到内容。' });
  assert.equal(speculative.calls.length, 2);
  speak(speculative.calls[1], 'final', '可以。');
  assert.deepEqual(events, []);
  assert.deepEqual(synthesis, []);

  feed(0, 19);
  await tick();
  assert.equal(receipts, 1);
  assert.deepEqual(events.filter(event => event.type === 'user').map(event => event.text), ['今天天气怎么样？']);
  assert.deepEqual(events.filter(event => event.type === 'assistant-delta').map(event => event.text), ['可以。']);
  assert.equal(ordinary.calls.length, 0);
  assert.deepEqual(synthesis, ['可以。']);
  await dialogue.cancelOutput();
  assert.equal(speculative.cancels, 2);
  assert.equal(ordinary.cancels, 0);
  input.stop();
  await dialogue.close();
  await output.close();
});

test('matching text cannot reuse a candidate after the authoritative Host receipt changes', async () => {
  const ordinary = new Port(), speculative = new Port(), events: DialogueEvent[] = [];
  const dialogue = new DialogueController(ordinary, preferences, event => events.push(event), { port: speculative, maxAgeMs: 12000 });
  const input = { text: '帮我写一个文件', source: 'voice' as const, speculation: { sessionId: 's', inputRevision: 1 },
    hostContext: { receipt: { kind: 'chat' } } };
  assert.equal(dialogue.prepareSpeculative(input), true);
  await tick();
  speak(speculative.calls[0], 'pending', '尚未正式受理。');
  assert.deepEqual(events, []);
  const receipt = { kind: 'task-submitted', taskId: 'work-1' };
  assert.equal((await dialogue.submit({ ...input, hostContext: { receipt } })).accepted, true);
  assert.equal(speculative.cancels, 1);
  assert.deepEqual(ordinary.calls[0].input.hostContext, { receipt });
  assert.equal(events.some(event => event.type === 'assistant-delta'), false);
  speak(ordinary.calls[0], 'confirmed', '任务已受理。');
  ordinary.calls[0].finish('completed');
  await tick();
  assert.deepEqual(events.filter(event => event.type === 'assistant-delta').map(event => event.text), ['任务已受理。']);
  await dialogue.close();
});

test('revocation releases a confirmation waiting for the native prompt receipt', async () => {
  const ordinary = new Port(), speculative = new Port(), events: DialogueEvent[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const dialogue = new DialogueController(ordinary, preferences, event => events.push(event), { maxAgeMs: 12000, port: {
    async runTurn(input, emit) {
      const accepted = await speculative.runTurn(input, emit);
      await gate;
      return accepted;
    },
    cancel: () => speculative.cancel(),
  } });
  const input = { text: '今天天气怎么样？', source: 'voice' as const, speculation: { sessionId: 's', inputRevision: 1 } };
  let eligible = true;
  assert.equal(dialogue.prepareSpeculative(input), true);
  await tick();
  const confirming = dialogue.submit({ ...input, isEligible: () => eligible });
  await tick();
  eligible = false;
  dialogue.discardSpeculative(input.speculation);
  assert.equal((await confirming).accepted, false);
  release();
  speak(speculative.calls[0], 'late', '已作废。');
  await tick();
  assert.deepEqual(events, []);
  assert.equal(ordinary.calls.length, 0);
  await dialogue.close();
});
