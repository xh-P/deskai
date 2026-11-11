import test from 'node:test';
import assert from 'node:assert/strict';
import { DshWorkProvider, type DshWorkTransport } from '../../packages/dsh-adapter/src/work-provider.ts';
import type { ProviderBinding, ProviderEvent } from '../../packages/work-core/src/types.ts';

const request = { taskId: 'task', attemptId: 'attempt', requestId: 'submit-operation', projectPath: process.cwd(), prompt: 'Build' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await tick();
  assert.ok(check(), 'expected provider state did not arrive');
}

test('cancel removes only this attempt’s accepted and in-flight queued prompts', async () => {
  const queue: Array<{ id: string; source: { kind: string; rpcId: string } }> =
    [{ id: 'native-row', source: { kind: 'user', rpcId: 'native-request' } }];
  const removed: string[] = [];
  let releaseAppend!: () => void;
  let appendSubmitted = false;
  const host = {
    ensureHost: async () => ({ state: 'ready' }),
    sessionFollow: async (_args: unknown, onFrame: (frame: unknown) => void) => {
      queueMicrotask(() => onFrame({ type: 'item', value: { type: 'snapshot', cursor: 0,
        header: { id: 'session', cwd: request.projectPath } } }));
      return () => {};
    },
    call: async (endpoint: string) => endpoint === 'permissionPresets/catalog' ? { options: [{ value: 'auto' }] } : { result: { kind: 'success' } },
    sessionCall: async (endpoint: string, args: any) => {
      if (endpoint === 'session/create') return { sessionId: 'session' };
      if (endpoint === 'session/prompt') {
        if (String(args.content[0].text) === 'Extra') {
          appendSubmitted = true;
          await new Promise<void>(resolve => { releaseAppend = resolve; });
        }
        queue.push({ id: `own-${queue.length}`, source: { kind: 'user', rpcId: args.requestId } });
        return { accepted: true };
      }
      if (endpoint === 'session/cancel') return { accepted: true };
      if (endpoint === 'session/projections') return { values: { inbox: { 'next-turn': [...queue], 'next-step': [] } } };
      if (endpoint === 'session/updateQueue') {
        removed.push(args.itemId);
        queue.splice(queue.findIndex(row => row.id === args.itemId), 1);
        return { accepted: true };
      }
      throw new Error(endpoint);
    }
  } as unknown as DshWorkTransport;
  const provider = new DshWorkProvider(host, process.cwd());
  const run = provider.start(request, () => {});
  await until(() => queue.length === 2);
  const append = provider.append(request.attemptId, 'Extra', 'append-operation');
  await until(() => appendSubmitted);
  const cancel = provider.cancel(request.attemptId);
  releaseAppend();
  await Promise.all([append, cancel]);
  assert.equal((await run).outcome, 'cancelled');
  assert.deepEqual(removed.sort(), ['own-1', 'own-2']);
  assert.deepEqual(queue.map(row => row.id), ['native-row']);
});

test('cancel repeats after an in-flight append becomes the next live turn', async () => {
  let frame!: (value: unknown) => void;
  let releaseAppend!: () => void;
  let appendSubmitted = false;
  let cancelCalls = 0;
  let seq = 0;
  const event = (type: string, data: unknown) => frame({ type: 'item', value: { type: 'event', event: { seq: ++seq, time: Date.now(), type, data } } });
  const host = {
    ensureHost: async () => ({ state: 'ready' }),
    sessionFollow: async (_args: unknown, onFrame: (value: unknown) => void) => {
      frame = onFrame;
      queueMicrotask(() => frame({ type: 'item', value: { type: 'snapshot', cursor: 0,
        header: { id: 'session', cwd: request.projectPath } } }));
      return () => {};
    },
    call: async (endpoint: string) => endpoint === 'permissionPresets/catalog' ? { options: [{ value: 'auto' }] } : { result: { kind: 'success' } },
    sessionCall: async (endpoint: string, args: any) => {
      if (endpoint === 'session/create') return { sessionId: 'session' };
      if (endpoint === 'session/prompt') {
        if (String(args.content[0].text) === 'Extra') {
          appendSubmitted = true;
          await new Promise<void>(resolve => { releaseAppend = resolve; });
          event('turn/start', { turn: 2 });
        } else event('turn/start', { turn: 1 });
        event('user/message', { source: { kind: 'user', rpcId: args.requestId } });
        return { accepted: true };
      }
      if (endpoint === 'session/cancel') {
        cancelCalls++;
        event('turn/end', { turn: cancelCalls, reason: { kind: 'aborted' } });
        return { accepted: true };
      }
      if (endpoint === 'session/projections') return { values: { inbox: { 'next-turn': [], 'next-step': [] } } };
      throw new Error(endpoint);
    }
  } as unknown as DshWorkTransport;
  const provider = new DshWorkProvider(host, process.cwd());
  let settled = false;
  const run = provider.start(request, () => {}).then(value => { settled = true; return value; });
  await until(() => seq === 2);
  const append = provider.append(request.attemptId, 'Extra', 'append-operation');
  await until(() => appendSubmitted);
  const cancel = provider.cancel(request.attemptId);
  await until(() => cancelCalls === 1);
  await tick();
  assert.equal(settled, false);
  releaseAppend();
  await Promise.all([append, cancel]);
  assert.equal((await run).outcome, 'cancelled');
  assert.ok(cancelCalls >= 2);
});

test('native decisions resolve pending requests and text deltas are batched', async () => {
  let frame!: (value: unknown) => void;
  let promptAccepted = false;
  let promptId = '';
  const host = {
    ensureHost: async () => ({ state: 'ready' }),
    sessionFollow: async (_args: unknown, onFrame: (value: unknown) => void) => {
      frame = onFrame;
      queueMicrotask(() => frame({ type: 'item', value: { type: 'snapshot', cursor: 0,
        header: { id: 'session', cwd: request.projectPath } } }));
      return () => {};
    },
    call: async (endpoint: string) => endpoint === 'permissionPresets/catalog' ? { options: [{ value: 'auto' }] } : { result: { kind: 'success' } },
    sessionCall: async (endpoint: string, args: any) => {
      if (endpoint === 'session/create') return { sessionId: 'session' };
      if (endpoint === 'session/prompt') { promptId = args.requestId; promptAccepted = true; return { accepted: true }; }
      throw new Error(endpoint);
    }
  } as unknown as DshWorkTransport;
  const provider = new DshWorkProvider(host, process.cwd());
  const events: ProviderEvent[] = [];
  const run = provider.start(request, event => events.push(event));
  await until(() => promptAccepted);
  let seq = 0;
  const event = (type: string, data: unknown) => frame({ type: 'item', value: { type: 'event', event: { seq: ++seq, type, data } } });
  event('turn/start', { turn: 1 });
  event('user/message', { source: { kind: 'user', rpcId: promptId } });
  event('tool/call', { name: 'ask_user_question', callId: 'question', arguments: '{"questions":[]}' });
  event('approval/asked', { id: 'approval', reason: 'May I?' });
  event('approval/decided', { id: 'approval', outcome: 'allowed-once' });
  event('tool/result', { message: { toolCallId: 'question', content: [{ type: 'text', text: '{"pending":true}' }] } });
  event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await tick();
  assert.deepEqual(events.filter(e => e.type === 'request-resolved').map(e => e.requestId), ['approval']);
  assert.deepEqual(events.filter(e => e.type === 'question').map(e => e.answerable), [false, true]);
  event('turn/start', { turn: 2 });
  event('step/start', { turn: 2, step: 1 });
  event('user/message', { source: { kind: 'user-question-reply', callId: 'question' } });
  event('request/header', { header: { config: { provider: 'dsh', model: 'fixture', reasoningEffort: 'high' } } });
  await tick();
  assert.deepEqual(events.filter(e => e.type === 'request-resolved').map(e => e.requestId), ['approval', 'question']);
  const stream = (data: object) => frame({ type: 'item', value: { type: 'assistant-stream',
    frame: { attemptId: 'stream-1', time: Date.now(), ...data } } });
  stream({ type: 'start', turn: 2, step: 1 });
  ['a', 'b', 'c'].forEach((text, index) => stream({ type: 'chunk', index, chunk: { type: 'text-delta', text } }));
  await new Promise(resolve => setTimeout(resolve, 300));
  const models = () => events.filter(e => e.type === 'trace').filter(e => e.entry.kind === 'model');
  assert.deepEqual(models().map(e => e.entry.text), ['', 'abc']);
  stream({ type: 'chunk', index: 3, chunk: { type: 'text-delta', text: 'd' } });
  event('assistant/attempt', { turn: 2, step: 1,
    stream: [{ type: 'text-chunks', time0: Date.now(), index: 0, dt: [], texts: ['abcd'] }] });
  event('llm/retry-started', { turn: 2, step: 1, retry: 1 });
  event('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'answer' }] },
    usage: { inputTokens: 30, outputTokens: 4, cacheReadTokens: 70 } });
  event('turn/end', { turn: 2, reason: { kind: 'completed' } });
  assert.equal((await run).outcome, 'completed');
  assert.deepEqual(models().map(e => e.entry.text), ['', 'abc', 'abcd', 'answer']);
  assert.deepEqual(models().filter(e => e.providerSeq !== undefined).map(e => e.entry.state), ['interrupted', 'completed']);
  assert.equal(new Set(models().map(e => e.entry.key)).size, 2);
  assert.equal(models().at(-1)?.entry.metrics?.usage?.cacheReadTokens, 70);
});

test('dsh replays a socket gap and reattaches the same request after Host restart', async () => {
  let follows = 0;
  let submissions = 0;
  let binding!: ProviderBinding;
  let frame!: (value: unknown) => void;
  const entry = (seq: number, type: string, data: unknown) => ({ type: 'event', event: { seq, type, data } });
  const history = () => [
    entry(1, 'turn/start', { turn: 1 }),
    entry(2, 'user/message', { source: { rpcId: binding.requestIds[0] } }),
    entry(3, 'assistant/message', { message: { content: [{ type: 'text', text: 'Owned result' }] } }),
    entry(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    entry(5, 'turn/start', { turn: 2 }),
    entry(6, 'assistant/message', { message: { content: [{ type: 'text', text: 'Other turn' }] } }),
    entry(7, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  ];
  const host = {
    ensureHost: async () => ({ state: 'ready' }),
    sessionFollow: async (_args: unknown, onFrame: (value: unknown) => void) => {
      frame = onFrame;
      const cursor = follows++ === 0 ? 0 : 7;
      frame({ type: 'item', value: { type: 'snapshot', cursor, header: { id: 'session', cwd: request.projectPath },
        records: cursor ? history().slice(-2) : [], hasMore: cursor > 0 } });
      return () => {};
    },
    call: async (endpoint: string) => endpoint === 'permissionPresets/catalog' ? { options: [{ value: 'auto' }] } : { result: { kind: 'success' } },
    sessionCall: async (endpoint: string, args: { beforeSeq: number }) => {
      if (endpoint === 'session/create') return { sessionId: 'session' };
      if (endpoint === 'session/prompt') {
        submissions++;
        for (const record of history().slice(0, 2)) frame({ type: 'item', value: record });
        frame({ type: 'error', error: { code: 'WORK_FOLLOW_CLOSED' } });
        return { accepted: true };
      }
      if (endpoint === 'session/page') return { records: history().slice(Math.max(0, args.beforeSeq - 3), args.beforeSeq - 1), hasMore: args.beforeSeq > 3 };
      throw new Error(endpoint);
    }
  } as unknown as DshWorkTransport;
  const original = new DshWorkProvider(host, process.cwd());
  const result = await original.start(request, event => { if (event.type === 'binding') binding = event.binding; });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.summary, 'Owned result');
  const restored = new DshWorkProvider(host, process.cwd());
  assert.deepEqual(await restored.recover({ ...request, providerSessionId: 'session', binding }, () => {}), result);
  const unknown = await restored.recover({ ...request, providerSessionId: 'session', binding: { baseline: 0, requestIds: ['missing'] } }, () => {});
  assert.equal(unknown.outcome, 'unknown');
  assert.equal(unknown.unsettled, true);
  assert.equal(submissions, 1);
});
