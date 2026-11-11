import test from 'node:test';
import assert from 'node:assert/strict';
import { extractModelSelection, prepareChatPatch } from '../../packages/dsh-adapter/src/chat-patch.ts';
import { DESKTOP_CHAT_PRESET } from '../../packages/voice-core/src/prompts.ts';
import { COORDINATOR_PRESET } from '../../packages/voice-core/src/coordination.ts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('shared Web model selection copies only safe route fields', () => {
  assert.deepEqual(extractModelSelection('- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-flash\n    credential: never-copy\n'),
    { provider: 'deepseek-account', model: 'deepseek-flash' });
  assert.equal(extractModelSelection('- id: other\n  config: {provider: deepseek-account, model: deepseek-flash}'), undefined);
  assert.equal(extractModelSelection('- id: agent-default-model\n  config: {provider: "${{ evil }}", model: deepseek-flash}'), undefined);
});

test('generated overlay uses one chat preset and the coordinator with the saved model route', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'deskai-persona-overlay-'));
  const originalHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = path.join(root, 'dsh');
    const profile = path.join(process.env.DSH_HOME, 'profiles/web');
    await mkdir(profile, { recursive: true });
    const saved = path.join(profile, 'cordis.patch.yml');
    const original = '- id: agent-default-model\n  config: { provider: account, model: saved-model, secret: unused }\n';
    await writeFile(saved, original);
    const entries = JSON.parse(await readFile(await prepareChatPatch(root), 'utf8'));
    const presets = entries.flatMap((entry: any) => entry.insert ?? []).map((entry: any) => entry.config);
    assert.deepEqual(presets.map((preset: any) => preset.id), [DESKTOP_CHAT_PRESET, COORDINATOR_PRESET]);
    assert.deepEqual(entries[0], { id: 'agent-default-model', config: { provider: 'account', model: 'saved-model' } });
    for (const preset of presets) {
      assert.equal(preset.plugins.length, 1);
      assert.equal(preset.plugins[0].name, '@deepseek-ai/dsh-persona');
      assert.equal(preset.plugins[0].config.complete, true);
    }
    assert.equal(await readFile(saved, 'utf8'), original);
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  }
});
