import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultPreferences, mergePreferences, loadPreferences, savePreferences } from '../../apps/desktop/src/settings.ts';

test('desktop settings whitelist preserves independent persona, voice and language', () => {
  const next = mergePreferences(defaultPreferences, { voiceId: 'haruhi-v2', referenceId: 'ref-02', volume: 0 });
  assert.equal(next.personaId, defaultPreferences.personaId);
  assert.equal(next.replyLanguage, 'auto');
  assert.equal(next.volume, 0);
  for (const patch of [{ volume: Infinity }, { speed: 2 }, { systemPrompt: 'inject' }, { closeToTray: 'yes' }, { inputDeviceId: 'bad\nvalue' }]) {
    assert.throws(() => mergePreferences(defaultPreferences, patch));
  }
});
test('preferences persist atomically and invalid settings recover to defaults', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deskai-prefs-'));
  try {
    assert.deepEqual(await loadPreferences(directory), defaultPreferences);
    const expected = mergePreferences(defaultPreferences, { replyLanguage: 'ja', closeToTray: false, speed: 1.2 });
    await savePreferences(directory, expected);
    assert.deepEqual(await loadPreferences(directory), expected);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
