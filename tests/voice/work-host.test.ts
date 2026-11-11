import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkHost } from '../../packages/work-core/src/host.ts';
import type { ProviderEvent, ProviderPort, ProviderResult } from '../../packages/work-core/src/types.ts';
import { pendingRequests } from '../../packages/work-core/src/requests.ts';

test('work ledger persists facts, replies and continues the native session', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deskai-work-')); const file = path.join(dir, 'work.json');
  let notify!: (event: ProviderEvent) => void; let finish!: (result: ProviderResult) => void;
  let finishAppend!: () => void;
  const appends: Array<string | undefined> = [];
  const requests: Array<{ providerSessionId?: string }> = []; const replies: unknown[] = [];
  const provider: ProviderPort = {
    start: (request, onEvent) => { requests.push(request); notify = onEvent; return new Promise(resolve => { finish = resolve; }); },
    append: (_attempt, _prompt, id) => { appends.push(id); return new Promise(resolve => { finishAppend = resolve; }); },
    cancel: async () => {}, reply: async (_attempt, request, response) => { replies.push({ request, response }); }
  };
  try {
    const host = new WorkHost(file, provider); const project = host.createProject({ name: 'Example', path: dir });
    host.saveDraft({ projectId: project.id, text: 'Draft' });
    const { task } = await host.dispatch({ type: 'submit', projectId: project.id, prompt: 'Build' });
    await new Promise(resolve => setImmediate(resolve));
    notify({ type: 'session', providerSessionId: 'native-1' });
    const command = { type: 'append' as const, taskId: task.id, prompt: 'Add details' };
    const delivery = { id: 'append-operation' };
    const pendingAppend = host.dispatch(command, delivery);
    const replay = await host.dispatch(command, delivery);
    assert.equal(replay.operation.state, 'pending');
    assert.deepEqual(appends, [delivery.id]);
    finishAppend();
    const confirmed = await pendingAppend;
    assert.equal(confirmed.operation.state, 'acknowledged');
    assert.equal(confirmed.execution.runId, replay.execution.runId);
    assert.equal(host.snapshot().events.some(event => event.type === 'input-added'), true);
    notify({ type: 'question', requestId: 'q1', text: 'Which?' });
    assert.equal(host.snapshot().tasks[0].status, 'waiting');
    await host.dispatch({ type: 'reply', taskId: task.id, requestId: 'q1', response: { answer: 'A' } });
    assert.equal(replies.length, 1);
    await assert.rejects(host.dispatch({ type: 'reply', taskId: task.id, requestId: 'q1', response: 'again' }));
    notify({ type: 'question', requestId: 'q2', text: 'Native answer?' });
    notify({ type: 'permission', requestId: 'p1', text: 'Native approval?' });
    notify({ type: 'request-resolved', requestId: 'q2' });
    assert.equal(host.snapshot().tasks[0].status, 'waiting');
    assert.equal(pendingRequests(host.snapshot()).length, 1);
    notify({ type: 'request-resolved', requestId: 'p1' });
    assert.equal(host.snapshot().tasks[0].status, 'running');
    await assert.rejects(host.dispatch({ type: 'reply', taskId: task.id, requestId: 'q2', response: 'already answered' }));
    notify({ type: 'artifact', path: 'out.txt' });
    assert.equal(host.authorizeArtifact(task.id, dir, 'out.txt'), true);
    assert.equal(host.authorizeArtifact(task.id, dir, 'other.txt'), false);
    finish({ outcome: 'completed', summary: 'Done' }); await new Promise(resolve => setImmediate(resolve));
    await host.dispatch({ type: 'continue', taskId: task.id, prompt: 'Refine' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests[1].providerSessionId, 'native-1');
    const restored = new WorkHost(file, provider).snapshot();
    assert.equal(restored.drafts[0].text, 'Draft'); assert.equal(restored.tasks[0].status, 'interrupted');
    assert.equal(restored.attempts[0].status, 'completed'); assert.equal(restored.attempts[1].status, 'interrupted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('uncertain provider failure is not completion and failed append is not recorded', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deskai-work-'));
  let rejectRun!: (error: Error) => void;
  const provider: ProviderPort = {
    start: () => new Promise((_resolve, reject) => { rejectRun = reject; }),
    append: async () => { throw new Error('not ready'); }, cancel: async () => {}, reply: async () => {}
  };
  try {
    const host = new WorkHost(path.join(dir, 'work.json'), provider);
    const project = host.createProject({ name: 'Example', path: dir });
    const { task } = await host.dispatch({ type: 'submit', projectId: project.id, prompt: 'Do work' });
    await new Promise(resolve => setImmediate(resolve));
    const command = { type: 'append' as const, taskId: task.id, prompt: 'After reconnect' };
    const receipt = await host.dispatch(command, { id: 'uncertain-append' });
    assert.equal(receipt.operation.state, 'unknown');
    assert.equal(receipt.operation.error, 'not ready');
    assert.deepEqual(await host.dispatch(command, { id: 'uncertain-append' }), receipt);
    assert.equal(host.snapshot().events.some(event => event.type === 'input-added'), false);
    rejectRun(new Error('connection lost')); await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.snapshot().tasks[0].status, 'unknown');
    assert.equal(host.snapshot().attempts[0].error, 'connection lost');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
