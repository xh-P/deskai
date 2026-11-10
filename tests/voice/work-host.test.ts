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
  const requests: Array<{ providerSessionId?: string }> = []; const replies: unknown[] = [];
  const provider: ProviderPort = {
    start: (request, onEvent) => { requests.push(request); notify = onEvent; return new Promise(resolve => { finish = resolve; }); },
    append: async () => {}, cancel: async () => {}, reply: async (_attempt, request, response) => { replies.push({ request, response }); }
  };
  try {
    const host = new WorkHost(file, provider); const project = host.createProject({ name: 'Example', path: dir });
    host.saveDraft({ projectId: project.id, text: 'Draft' }); const task = host.submit({ projectId: project.id, prompt: 'Build' });
    await new Promise(resolve => setImmediate(resolve));
    notify({ type: 'session', providerSessionId: 'native-1' });
    await host.append(task.id, 'Add details');
    assert.equal(host.snapshot().events.some(event => event.type === 'input-added'), true);
    notify({ type: 'question', requestId: 'q1', text: 'Which?' });
    assert.equal(host.snapshot().tasks[0].status, 'waiting');
    await host.reply(task.id, 'q1', { answer: 'A' }); assert.equal(replies.length, 1);
    await assert.rejects(host.reply(task.id, 'q1', 'again'));
    notify({ type: 'question', requestId: 'q2', text: 'Native answer?' });
    notify({ type: 'permission', requestId: 'p1', text: 'Native approval?' });
    notify({ type: 'request-resolved', requestId: 'q2' });
    assert.equal(host.snapshot().tasks[0].status, 'waiting');
    assert.equal(pendingRequests(host.snapshot()).length, 1);
    notify({ type: 'request-resolved', requestId: 'p1' });
    assert.equal(host.snapshot().tasks[0].status, 'running');
    await assert.rejects(host.reply(task.id, 'q2', 'already answered'));
    notify({ type: 'artifact', path: 'out.txt' });
    assert.equal(host.authorizeArtifact(task.id, dir, 'out.txt'), true);
    assert.equal(host.authorizeArtifact(task.id, dir, 'other.txt'), false);
    finish({ outcome: 'completed', summary: 'Done' }); await new Promise(resolve => setImmediate(resolve));
    host.continue(task.id, 'Refine'); await new Promise(resolve => setImmediate(resolve));
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
    const task = host.submit({ projectId: project.id, prompt: 'Do work' });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(host.append(task.id, 'More'), /not ready/);
    assert.equal(host.snapshot().events.some(event => event.type === 'input-added'), false);
    rejectRun(new Error('connection lost')); await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.snapshot().tasks[0].status, 'unknown');
    assert.equal(host.snapshot().attempts[0].error, 'connection lost');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
