import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCoordinationPlan } from '../../packages/voice-core/src/coordination.ts';
import { HostApi } from '../../apps/desktop/src/host-api.ts';
import { DesktopHost } from '../../apps/desktop/src/desktop-host.ts';
import type { ProviderPort } from '../../packages/work-core/src/types.ts';

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
  const host = await DesktopHost.open(directory, provider, directory);
  try {
    const chatReceipt = await host.execute({ intent: 'chat' });
    const context = host.dialogueContext(chatReceipt);
    assert.deepEqual(context.receipt, { kind: 'chat' });
    assert.equal(host.snapshot().work.tasks.length, 0);
    assert.deepEqual(context.capabilities.applications, []);
    assert.equal(context.capabilities.work.executor, 'dsh');
    assert.equal(context.capabilities.selectedProject?.id, host.selectedProjectId);
    const receipt = await host.execute({ intent: 'submit', prompt: 'Create a note' }) as { kind: string; taskId: string };
    assert.equal(receipt.kind, 'task-submitted');
    assert.equal(host.snapshot().work.tasks[0].id, receipt.taskId);
    assert.deepEqual(host.dialogueContext(receipt).receipt, receipt);
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
