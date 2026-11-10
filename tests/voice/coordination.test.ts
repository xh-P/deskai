import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCoordinationPlan } from '../../packages/voice-core/src/coordination.ts';
import { HostApi } from '../../apps/desktop/src/host-api.ts';

test('coordination rejects incomplete controls and prose, and accepts declared intents', () => {
  assert.deepEqual(parseCoordinationPlan('{"intent":"chat"}'), { intent: 'chat' });
  assert.equal(parseCoordinationPlan('{"intent":"submit","prompt":"生成待办","authoring":true}').authoring, true);
  for (const value of ['已经完成', '{"intent":"cancel"}', '{"intent":"app","sessionId":"x"}', '{"intent":"shell","prompt":"echo hi"}'])
    assert.throws(() => parseCoordinationPlan(value));
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
