import test from 'node:test';
import assert from 'node:assert/strict';
import { extractModelSelection } from '../../packages/dsh-adapter/src/chat-patch.ts';
import { prepareChatPatch } from '../../packages/dsh-adapter/src/chat-patch.ts';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('shared Web model selection copies only safe route fields', () => {
  assert.deepEqual(extractModelSelection('- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-flash\n    credential: never-copy\n'),
    { provider: 'deepseek-account', model: 'deepseek-flash' });
  assert.equal(extractModelSelection('- id: other\n  config: {provider: deepseek-account, model: deepseek-flash}'), undefined);
  assert.equal(extractModelSelection('- id: agent-default-model\n  config: {provider: "${{ evil }}", model: deepseek-flash}'), undefined);
});

test('generated local overlay includes separate relationship prompts without mutating source cards or saved model route', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'deskai-persona-overlay-'));
  const originalHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = path.join(root, 'dsh-empty');
    await mkdir(path.join(root, 'config'), { recursive: true });
    await cp(new URL('../../config/personas', import.meta.url), path.join(root, 'config/personas'), { recursive: true });
    const original = await readFile(path.join(root, 'config/personas/nagato-mainline-post-disappearance.json'), 'utf8');
    const entries = JSON.parse(await readFile(await prepareChatPatch(root), 'utf8'));
    const presets = entries.flatMap((entry: any) => entry.insert ?? []).map((entry: any) => entry.config);
    assert.equal(presets.length, 5);
    assert.ok(presets.some((preset: any) => preset.id === 'deskai2-host-coordinator'));
    const friend = presets.find((preset: any) => preset.id === 'deskai2-voice-nagato-mainline-friend');
    const kyon = presets.find((preset: any) => preset.id === 'deskai2-voice-nagato-mainline-kyon');
    assert.match(friend.plugins[0].config.prefix, /"relationshipMode":"friend"/u);
    assert.match(kyon.plugins[0].config.prefix, /"relationshipMode":"kyon"/u);
    for (const preset of presets) {
      assert.equal(preset.plugins.length, 1);
      assert.equal(preset.plugins[0].name, '@deepseek-ai/dsh-persona');
      assert.equal(preset.plugins[0].config.complete, true);
    }
    assert.equal(await readFile(path.join(root, 'config/personas/nagato-mainline-post-disappearance.json'), 'utf8'), original);
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  }
});
