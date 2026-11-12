import type { PetMotionMode } from './types.ts';

/** Resolve motion for the pet only; never changes the OS or Chromium preference. */
export function petMotionEnabled(mode: PetMotionMode, systemReduced: boolean): boolean {
  return mode === 'gentle' || mode === 'system' && !systemReduced;
}
