import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseCoordinationPlan } from '../../packages/voice-core/src/coordination.ts';
import { HostApi } from '../../apps/host/src/api.ts';
import { LocalHost } from '../../apps/host/src/host.ts';
import { dialogueContext } from '../../apps/host/src/context.ts';
import type { ProviderPort } from '../../packages/work-core/src/types.ts';
import type { AcceptanceReceipt } from '../../packages/work-core/src/completion.ts';

test('coordination rejects incomplete controls and prose, and accepts declared intents', () => {
  assert.deepEqual(parseCoordinationPlan('{"intent":"chat"}'), { intent: 'chat' });
  assert.equal(parseCoordinationPlan('{"intent":"submit","prompt":"生成待办","authoring":true}').authoring, true);
  for (const value of ['已经完成', '{"intent":"cancel"}', '{"intent":"app","sessionId":"x"}', '{"intent":"shell","prompt":"echo hi"}'])
    assert.throws(() => parseCoordinationPlan(value));
});

test('dialogue context reflects host capabilities and the actual execution receipt', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deskai-context-'));
  const provider: ProviderPort = {
    start: async () => ({ outcome: 'completed', summary: 'Done' }),
    append: async () => {}, cancel: async () => {}, reply: async () => {}
  };
  const host = await LocalHost.open(path.join(directory, 'host'), provider, directory);
  try {
    const chatReceipt = await host.execute({ intent: 'chat' });
    const context = dialogueContext(host.snapshot(), chatReceipt);
    assert.deepEqual(context.receipt, { kind: 'chat' });
    assert.equal(host.snapshot().work.tasks.length, 0);
    assert.deepEqual(context.capabilities.applications, []);
    assert.equal(context.capabilities.work.executor, 'dsh');
    assert.equal(context.capabilities.selectedProject?.id, host.selectedProjectId);
    const receipt = await host.execute({ intent: 'submit', prompt: 'Create a note' }) as { kind: string; taskId: string };
    assert.equal(receipt.kind, 'task-submitted');
    assert.equal(host.snapshot().work.tasks[0].id, receipt.taskId);
    assert.deepEqual(dialogueContext(host.snapshot(), receipt).receipt, receipt);
    await new Promise(resolve => setImmediate(resolve));
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('local control API requires its own bearer capability and rejects browser-origin use', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deskai-api-'));
  const api = new HostApi(); let commands = 0;
  try {
    await api.start(directory, () => ({ ready: true }), async () => { commands++; return { accepted: true }; });
    const descriptor = JSON.parse(await readFile(path.join(directory, 'local-api.json'), 'utf8'));
    assert.equal((await fetch(descriptor.url + '/snapshot')).status, 401);
    const headers = { authorization: `Bearer ${descriptor.token}` };
    assert.equal((await fetch(descriptor.url + '/snapshot', { headers: { ...headers, origin: 'http://127.0.0.1' } })).status, 401);
    assert.deepEqual(await (await fetch(descriptor.url + '/snapshot', { headers })).json(), { ready: true });
    assert.equal((await fetch(descriptor.url + '/command', { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal(commands, 1);
  } finally { await api.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Work assessment uses actual delivery and persists only explicit acceptance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deskai-review-'));
  const project = path.join(directory, 'project'); await mkdir(project);
  const stateDir = path.join(directory, 'host');
  await writeFile(path.join(project, 'preexisting.txt'), 'already here');
  const provider: ProviderPort = {
    async start(request, notify) {
      if (request.prompt === 'unverified') notify({ type: 'artifact', path: 'preexisting.txt' });
      if (request.prompt === 'deliver') {
        await writeFile(path.join(request.projectPath, 'report.txt'), 'verified output');
        notify({ type: 'artifact', path: 'report.txt' });
      }
      return { outcome: 'completed', summary: 'The work is done.' };
    },
    async append() {}, async cancel() {}, async reply() {}
  };
  let host = await LocalHost.open(stateDir, provider, project);
  async function run(prompt: string, file: string) {
    const task = host.work.submit({ projectId: host.selectedProjectId, prompt, expectedArtifacts: [file] });
    for (let i = 0; i < 150; i++) {
      const attempt = host.snapshot().work.attempts.find(item => item.taskId === task.id);
      if (attempt?.assessment) return { task, attempt };
      await delay(20);
    }
    throw new Error('Work assessment timed out');
  }
  try {
    const missing = await run('missing', 'missing.txt');
    assert.deepEqual(missing.attempt.assessment?.missingFiles, ['missing.txt']);
    assert.equal(missing.attempt.assessment?.review, 'open');
    await assert.rejects(host.work.review(missing.task.id, missing.attempt.id, 'accept'), /WORK_REVIEW_NOT_READY/);
    const invalid = await run('unverified', 'preexisting.txt');
    assert.equal(invalid.attempt.assessment?.delivery.failures[0].reason, 'WORK_ARTIFACT_NOT_ATTRIBUTABLE');
    assert.equal(invalid.attempt.assessment?.review, 'open');
    const ready = await run('deliver', 'report.txt');
    assert.equal(ready.attempt.assessment?.review, 'review_ready');
    assert.equal(ready.attempt.acceptance, undefined);
    await writeFile(path.join(project, 'report.txt'), 'changed after review');
    await assert.rejects(host.work.review(ready.task.id, ready.attempt.id, 'accept'), /WORK_REVIEW_NOT_READY/);
    await writeFile(path.join(project, 'report.txt'), 'verified output');
    const receipt = await host.work.review(ready.task.id, ready.attempt.id, 'accept') as AcceptanceReceipt;
    assert.equal(receipt.assessment.review, 'accepted');
    await host.close(); host = await LocalHost.open(stateDir, provider, project);
    assert.deepEqual(await host.work.review(ready.task.id, ready.attempt.id, 'accept'), receipt);
    const status = await host.execute({ intent: 'status', taskId: ready.task.id }) as { tasks: Array<{ execution: string; review: string }> };
    assert.equal(status.tasks[0].execution, 'completed');
    assert.equal(status.tasks[0].review, 'accepted');
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});
