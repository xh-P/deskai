import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkTraceFeed } from '../../apps/host/src/work-trace.ts';
import type { NativeTrace, WorkTraceFrame } from '../../packages/work-core/src/telemetry.ts';
import type { WorkAttempt, WorkEvent, WorkHistory } from '../../packages/work-core/src/types.ts';

test('Work trace pages earlier rows and replays the durable model result once', async () => {
  const base = Date.parse('2026-01-01T00:00:00Z');
  const time = (offset: number) => new Date(base + offset).toISOString();
  const attempt: WorkAttempt = { id: 'attempt', taskId: 'task', operationId: 'operation', prompt: 'Read',
    status: 'running', providerSessionId: 'session', createdAt: time(0), updatedAt: time(0) };
  const events: WorkEvent[] = Array.from({ length: 175 }, (_, i) => ({
    id: `row-${i}`, taskId: 'task', attemptId: attempt.id, time: time(i), type: 'input-added', data: { prompt: String(i) }
  }));
  const history: WorkHistory = { attempts: [attempt], events, operations: [], task: {
    id: 'task', projectId: 'project', title: 'Task', prompt: 'Read', status: 'running', attemptIds: [attempt.id],
    createdAt: time(0), updatedAt: time(0)
  } };
  const feed = new WorkTraceFeed(() => history);
  const received: WorkTraceFrame[] = [];
  const stop = feed.subscribe('task', undefined, frame => received.push(frame));
  const initial = received[0];
  assert.equal(initial.type, 'snapshot');
  assert.equal(initial.rows.length, 160);
  assert.equal(initial.older, true);
  assert.equal(feed.page('task', initial.rows[0].id).rows.length, 15);

  const entry: NativeTrace = { key: 'model-1-1', at: base + 200, kind: 'model', title: 'Model', state: 'running' };
  feed.observe('task', attempt.id, { type: 'trace', entry });
  await Promise.resolve();
  const active = received.at(-1)!;
  assert.equal(active.type, 'delta');
  assert.equal(active.totals[attempt.id].executor.reported, 0);
  stop();

  const completed: NativeTrace = { ...entry, state: 'completed', metrics: {
    usage: { inputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 20, outputTokens: 5, totalTokens: 105 }
  } };
  events.push({ id: 'durable', taskId: 'task', attemptId: attempt.id, time: time(210),
    type: 'trace', data: completed, providerSeq: 200 });
  feed.observe('task', attempt.id, { type: 'trace', entry: completed, providerSeq: 200 });
  const replay: WorkTraceFrame[] = [];
  const close = feed.subscribe('task', active.cursor, frame => replay.push(frame));
  assert.equal(replay.length, 1);
  assert.equal(replay[0].type, 'delta');
  assert.equal(replay[0].rows[0].id, active.rows[0].id);
  assert.equal(replay[0].rows[0].sessionId, attempt.providerSessionId);
  assert.deepEqual(replay[0].totals[attempt.id].executor, { requests: 1, reported: 1, output: 5,
    cache: { read: 0, input: 100, requests: 1 } });
  close();
});
