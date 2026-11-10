import test from 'node:test';
import assert from 'node:assert/strict';
import { DshWorkProvider, type DshWorkTransport } from '../../packages/dsh-adapter/src/work-provider.ts';
import type { ProviderEvent } from '../../packages/work-core/src/types.ts';

const request = { taskId: 'task', attemptId: 'attempt', projectPath: process.cwd(), prompt: 'Build' };
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
  const append = provider.append(request.attemptId, 'Extra');
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
  const event = (type: string, data: unknown) => frame({ type: 'item', value: { type: 'event', event: { seq: ++seq, type, data } } });
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
  const append = provider.append(request.attemptId, 'Extra');
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
  assert.deepEqual(events.filter(e => e.type === 'request-resolved').map(e => e.requestId), ['approval']);
  event('user/message', { source: { kind: 'user-question-reply', callId: 'question' } });
  event('tool/result', { message: { toolCallId: 'unrelated', content: [] } });
  assert.deepEqual(events.filter(e => e.type === 'request-resolved').map(e => e.requestId), ['approval', 'question']);
  for (const text of ['a', 'b', 'c']) frame({ type: 'item', value: { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text } } } });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(events.filter(e => e.type === 'activity').map(e => e.text), ['dsh: ask_user_question', 'abc']);
  frame({ type: 'item', value: { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'd' } } } });
  event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal((await run).outcome, 'completed');
  assert.deepEqual(events.filter(e => e.type === 'activity').map(e => e.text), ['dsh: ask_user_question', 'abc', 'd']);
});
