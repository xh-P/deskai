import test from 'node:test';
import assert from 'node:assert/strict';
import { WakeGate } from '../../apps/desktop/src/wake-gate.ts';
import { SpeechRuntime } from '../../apps/desktop/src/speech-runtime.ts';
import { loadInputRuntimeConfig } from '../../apps/desktop/src/speech-runtime.ts';
import { createInputController } from '../../packages/voice-core/src/index.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const feed = (c: ReturnType<typeof createInputController>, voiced: boolean, count: number) => { for (let i = 0; i < count; i++) c.pushFrame({ samples: new Float32Array(160), probability: voiced ? 0.9 : 0 }); };

test('160ms candidate is invalidated on resumed speech and commits at 350ms', async () => {
  const resolutions: ((s: string) => void)[] = []; const ready: string[] = [];
  const c = createInputController({ candidateWindowMs: 160, continuationWindowMs: 350, unfinishedWindowMs: 350, transcribe: () => new Promise(resolve => resolutions.push(resolve)), onReady: r => ready.push(r.text) });
  c.start('test'); feed(c, true, 20); feed(c, false, 16); await tick(); assert.equal(resolutions.length, 1);
  feed(c, true, 10); feed(c, false, 35); resolutions[0]('obsolete'); await tick(); await tick();
  assert.equal(resolutions.length, 2); resolutions[1]('完整语句'); await tick(); assert.deepEqual(ready, ['完整语句']);
});

test('wake gate routes remainder, rejects stale results, and expires after inactivity', () => {
  const gate = new WakeGate(['有希', '长门有希'], 180000); const wake = gate.snapshot(1);
  assert.deepEqual(gate.preview('长门有希，今天天气如何？', wake, 1), { accepted: true, text: '今天天气如何？', woke: true });
  assert.deepEqual(gate.snapshot(1), wake);
  assert.deepEqual(gate.accept('长门有希，今天天气如何？', wake, 1), { accepted: true, text: '今天天气如何？', woke: true });
  assert.equal(gate.accept('有希', wake, 2).accepted, false);
  gate.touch(100000); assert.equal(gate.snapshot(200000).mode, 'conversation');
  assert.equal(gate.snapshot(280000).mode, 'wake');
});

test('configured multilingual wake phrases and updates invalidate in-flight results', async () => {
  const config = await loadInputRuntimeConfig(process.cwd());
  assert.equal(config.conversation.idlePolicy, 'resident');
  for (const phrase of ['长门', '有希', '长门有希', '長門', '有希', '長門有希', 'ながと', 'ゆき', 'ながとゆき']) {
    const gate = new WakeGate(config.wake.phrases);
    assert.deepEqual(gate.accept(`${phrase}，你好`, gate.snapshot(1), 1), { accepted: true, text: '你好', woke: true });
  }
  const gate = new WakeGate(config.wake.phrases);
  const oldRoute = gate.snapshot(1);
  gate.setPhrases(['自定义']);
  assert.equal(gate.accept('有希', oldRoute, 2).accepted, false);
  assert.equal(gate.accept('有希', gate.snapshot(2), 2).woke, false);
  assert.equal(gate.accept('自定义，您好', gate.snapshot(3), 3).text, '您好');
});

test('openai transcription and local wake are separate routes', async () => {
  let localCalls = 0; const local = { transcribe: async () => { localCalls++; return { text: 'wake' }; } };
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url, init) => {
      assert.equal(String(url), 'http://127.0.0.1:1234/v1/audio/transcriptions');
      assert.equal((init?.body as FormData).get('model'), 'Qwen/Qwen3-ASR-0.6B');
      return Response.json({ text: 'conversation' });
    }) as typeof fetch;
    const runtime = new SpeechRuntime(local, { provider: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'Qwen/Qwen3-ASR-0.6B' });
    assert.equal(await runtime.transcribe('wake', new Uint8Array(), new AbortController().signal), 'wake');
    assert.equal(await runtime.transcribe('conversation', new Uint8Array(), new AbortController().signal), 'conversation');
    assert.equal(localCalls, 1);
    const missing = new SpeechRuntime(local, { provider: 'openai' });
    await assert.rejects(missing.transcribe('conversation', new Uint8Array(), new AbortController().signal), /CONVERSATION_ASR_NOT_CONFIGURED/);
  } finally { globalThis.fetch = oldFetch; }
});
