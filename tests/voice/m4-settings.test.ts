import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
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

test('legacy saved settings gain a dormant friend mode without changing the file or existing choices', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deskai-prefs-legacy-'));
  try {
    const legacy = { personaId: 'assistant-neutral', replyLanguage: 'ja', voiceId: 'haruhi-v2', referenceId: 'reference-old',
      inputDeviceId: 'mic-old', outputDeviceId: 'speaker-old', volume: 0.35, speed: 1.4, closeToTray: false };
    const file = path.join(directory, 'voice-preferences.json'), original = JSON.stringify(legacy);
    await writeFile(file, original);
    assert.deepEqual(await loadPreferences(directory), { ...legacy, relationshipMode: 'friend' });
    assert.equal(await readFile(file, 'utf8'), original);
    const next = mergePreferences(await loadPreferences(directory), { personaId: 'nagato-mainline-post-disappearance', relationshipMode: 'kyon' });
    assert.deepEqual(next, { ...legacy, personaId: 'nagato-mainline-post-disappearance', relationshipMode: 'kyon' });
    await savePreferences(directory, next);
    assert.deepEqual(await loadPreferences(directory), next);
    for (const relationshipMode of ['lover', '', null, 1]) assert.throws(() => mergePreferences(next, { relationshipMode }), /INVALID_RELATIONSHIP/u);
    assert.throws(() => mergePreferences(next, { personaId: '../evil' }), /INVALID_PERSONA/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
