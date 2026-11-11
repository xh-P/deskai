import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PET_VARIANTS, type PetPreferences, type PetPreferencePatch } from '../../../packages/desktop-pet/src/types.ts';

export const defaultPetPreferences: PetPreferences = {
  variant: 'uniform-chibi', size: 220, visible: true, alwaysOnTop: true, motionMode: 'gentle', position: null,
};

function petSettingsPath(userData: string): string { return path.join(userData, 'pet-settings.json'); }

export function mergePetPreferences(previous: PetPreferences, value: unknown): PetPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_PET_PREFERENCES');
  const patch = value as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    if (!['variant', 'size', 'visible', 'alwaysOnTop', 'motionMode'].includes(key)) throw new Error('INVALID_PET_PREFERENCES');
  }
  if ('variant' in patch && !PET_VARIANTS.includes(patch.variant as never)) throw new Error('INVALID_PET_VARIANT');
  if ('size' in patch && (!Number.isInteger(patch.size) || (patch.size as number) < 120 || (patch.size as number) > 360)) {
    throw new Error('INVALID_PET_SIZE');
  }
  if ('visible' in patch && typeof patch.visible !== 'boolean') throw new Error('INVALID_PET_VISIBILITY');
  if ('alwaysOnTop' in patch && typeof patch.alwaysOnTop !== 'boolean') throw new Error('INVALID_PET_TOPMOST');
  if ('motionMode' in patch && patch.motionMode !== 'gentle' && patch.motionMode !== 'system') {
    throw new Error('INVALID_PET_MOTION_MODE');
  }
  return { ...previous, ...patch as PetPreferencePatch };
}

export async function loadPetPreferences(userData: string): Promise<PetPreferences> {
  try {
    const saved = JSON.parse(await readFile(petSettingsPath(userData), 'utf8'));
    if (!Object.keys(defaultPetPreferences).every(key => Object.hasOwn(saved, key))) return { ...defaultPetPreferences };
    const { position, ...patch } = saved;
    if (position !== null && (!Number.isInteger(position?.x) || !Number.isInteger(position?.y) ||
        Math.abs(position.x) >= 100000 || Math.abs(position.y) >= 100000)) return { ...defaultPetPreferences };
    const preferences = mergePetPreferences(defaultPetPreferences, patch);
    return { ...preferences, position: position === null ? null : { x: position.x, y: position.y } };
  } catch { return { ...defaultPetPreferences }; }
}

export async function savePetPreferences(userData: string, preferences: PetPreferences): Promise<void> {
  await mkdir(userData, { recursive: true });
  const file = petSettingsPath(userData);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(preferences, null, 2), 'utf8');
  await rename(temporary, file);
}
