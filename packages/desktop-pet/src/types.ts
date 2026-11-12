import type { Live2DProfile } from './live2d.ts';
import type { Gesture, GestureName } from '../../voice-core/src/gesture.ts';

export const PET_VARIANTS = ['uniform-chibi', 'uniform-normal', 'witch-chibi', 'witch-normal'] as const;
export type PetVariant = typeof PET_VARIANTS[number];
export type PetState = 'off' | 'listening' | 'recognizing' | 'thinking' | 'speaking' |
  'paused' | 'waiting' | 'silent' | 'error';
export type PetMotionMode = 'gentle' | 'system' | 'reduced';
export type PetGesture = Gesture & { startedAt: number };

export type PetPreferences = {
  variant: PetVariant;
  /** Alpha-cropped character height in logical CSS pixels. */
  size: number;
  visible: boolean;
  alwaysOnTop: boolean;
  /** Gentle motion overrides only this pet's reduced-motion preference. */
  motionMode: PetMotionMode;
  /** Electron screen coordinates in device-independent pixels. */
  position: { x: number; y: number } | null;
};

export type PetPreferencePatch = Partial<Pick<PetPreferences, 'variant' | 'size' | 'visible' | 'alwaysOnTop' | 'motionMode'>>;

export type PetSnapshot = {
  variant: PetVariant;
  size: number;
  visible: boolean;
  alwaysOnTop: boolean;
  motionMode: PetMotionMode;
  state: PetState;
  /** Spoken sentence text only after its matching playback receipt. */
  subtitle: string;
  sessionId: string | null;
  generationId: number;
  attemptId?: string;
  segmentId?: string;
  gesture?: PetGesture;
  model?: Live2DProfile;
};

export type PetGeometry = { variant: PetVariant; modelId?: string; aspect: number; gestures?: readonly GestureName[] };
