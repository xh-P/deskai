import type { PetState } from './types.ts';

export type Live2DCue = PetState | 'tap';
export type Live2DMotion = { group: string; index: number };
export type Live2DStyle = {
  frame: 'portrait' | 'full';
  zoom: number;
  x: number;
  y: number;
  gaze: number;
  mouthGain: number;
  mouth: { open?: string; form?: string; wide?: string; round?: string };
  cues: Partial<Record<Live2DCue, { expression?: string; motion?: Live2DMotion }>>;
};
export type Live2DProfile = {
  id: string;
  name: string;
  source: 'sample' | 'local';
  url: string;
  textures: string[];
  expressions: string[];
  motions: Live2DMotion[];
  lipSync: string[];
  physics: boolean;
  style: Live2DStyle;
};
export type Live2DCatalog = {
  coreReady: boolean;
  models: Live2DProfile[];
  bindings: Record<string, string | null>;
  issues: string[];
};
export type Live2DApply = { personaId: string; modelId: string | null; style?: Live2DStyle };

/** A small presentation signal from the audio output clock, in context frames. */
export type MouthFrame = {
  sessionId: string; generationId: number; attemptId: string; segmentId: string;
  frame: number; sampleRate: number; open: number; shape: number;
};

export const defaultLive2DStyle: Live2DStyle = {
  frame: 'portrait', zoom: 1, x: 0, y: 0, gaze: 0.7, mouthGain: 1,
  mouth: {}, cues: {},
};
