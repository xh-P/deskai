import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { petMotionEnabled } from '../../packages/desktop-pet/src/motion.ts';
import { clampPetDragBounds, PetDrag, resizePetKeepingFeet } from '../../packages/desktop-pet/src/drag.ts';
import { defaultPetPreferences, loadPetPreferences, mergePetPreferences, savePetPreferences } from '../../apps/desktop/src/pet-settings.ts';

test('pet motion follows its own mode without changing system preference', () => {
  assert.equal(petMotionEnabled('gentle', true), true);
  assert.equal(petMotionEnabled('gentle', false), true);
  assert.equal(petMotionEnabled('system', true), false);
  assert.equal(petMotionEnabled('system', false), true);
  assert.equal(defaultPetPreferences.motionMode, 'gentle');
  assert.throws(() => mergePetPreferences(defaultPetPreferences, { motionMode: 'forced' }), /INVALID_PET_MOTION_MODE/);
});

test('incomplete pet settings are discarded and current motion changes persist independently', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deskai-pet-motion-'));
  try {
    await writeFile(path.join(directory, 'pet-settings.json'), JSON.stringify({
      variant: 'witch-normal', size: 300, visible: false, alwaysOnTop: false,
      position: { x: 120, y: -40 },
    }));
    assert.deepEqual(await loadPetPreferences(directory), defaultPetPreferences);
    const current = { ...defaultPetPreferences, variant: 'witch-normal' as const, position: { x: 120, y: -40 } };
    await savePetPreferences(directory, mergePetPreferences(current, { motionMode: 'system' }));
    const saved = JSON.parse(await readFile(path.join(directory, 'pet-settings.json'), 'utf8'));
    assert.equal(saved.motionMode, 'system');
    assert.equal(saved.variant, 'witch-normal');
    assert.deepEqual(saved.position, { x: 120, y: -40 });
    assert.equal((await loadPetPreferences(directory)).motionMode, 'system');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pet drag projects from its initial DIP position across the upper half and negative display coordinates', () => {
  const drag = new PetDrag();
  const area = { x: -1920, y: -200, width: 1920, height: 1080 };
  const bounds = { x: -500, y: 300, width: 300, height: 400 };
  assert.equal(drag.begin(7, { x: -350, y: 650 }, bounds), true);
  assert.deepEqual(drag.move(7, { x: -800, y: 150 }, area),
    { x: -950, y: -200, width: 300, height: 400 });
  assert.deepEqual(drag.move(7, { x: -800, y: 100 }, area),
    { x: -950, y: -250, width: 300, height: 400 });
  assert.deepEqual(drag.move(7, { x: -800, y: 350 }, area),
    { x: -950, y: 0, width: 300, height: 400 });
  assert.deepEqual(drag.move(7, { x: -350, y: 650 }, area), bounds);
});

test('top drag boundary leaves a reachable foot and reverses without dead travel', () => {
  const drag = new PetDrag();
  const area = { x: 0, y: 0, width: 1200, height: 800 };
  const bounds = { x: 400, y: 300, width: 300, height: 400 };
  assert.equal(drag.begin(3, { x: 550, y: 650 }, bounds), true);
  assert.deepEqual(drag.move(3, { x: 550, y: 250 }, area),
    { x: 400, y: -100, width: 300, height: 400 });
  assert.deepEqual(drag.move(3, { x: 550, y: 0 }, area),
    { x: 400, y: -336, width: 300, height: 400 });
  assert.deepEqual(drag.move(3, { x: 550, y: -20 }, area),
    { x: 400, y: -336, width: 300, height: 400 });
  assert.deepEqual(drag.move(3, { x: 550, y: -19 }, area),
    { x: 400, y: -335, width: 300, height: 400 });
  assert.deepEqual(clampPetDragBounds({ x: 400, y: -336, width: 300, height: 400 }, area),
    { x: 400, y: -336, width: 300, height: 400 });
});

test('initial geometry correction preserves a saved manual top position', () => {
  const area = { x: 0, y: 0, width: 1200, height: 800 };
  const prior = { x: 400, y: -336, width: 300, height: 400 };
  assert.deepEqual(resizePetKeepingFeet(prior, { width: 330, height: 450 }, area, true),
    { x: 385, y: -386, width: 330, height: 450 });
  assert.deepEqual(resizePetKeepingFeet(prior, { width: 330, height: 450 }, area),
    { x: 385, y: 0, width: 330, height: 450 });
});

test('pet drag ignores stale pointers and recovers after capture loss and a new drag', () => {
  const drag = new PetDrag();
  const area = { x: 0, y: 0, width: 1200, height: 800 };
  const bounds = { x: 400, y: 300, width: 300, height: 400 };
  assert.equal(drag.begin(1, { x: 550, y: 650 }, bounds), true);
  assert.equal(drag.begin(2, { x: 550, y: 650 }, bounds), false);
  assert.equal(drag.move(2, { x: 700, y: 500 }, area), undefined);
  assert.equal(drag.end(2), false);
  assert.equal(drag.active, true);
  assert.equal(drag.cancel(), true);
  assert.equal(drag.move(1, { x: 700, y: 500 }, area), undefined);
  assert.equal(drag.begin(2, { x: 550, y: 650 }, bounds), true);
  assert.equal(drag.end(1), false);
  assert.deepEqual(drag.move(2, { x: 600, y: 600 }, area),
    { x: 450, y: 250, width: 300, height: 400 });
  assert.equal(drag.end(2), true);
  assert.equal(drag.active, false);
});
