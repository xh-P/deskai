import type { PetState } from './types.ts';

export type Live2DCue = PetState | 'tap';
export type Live2DMotion = { group: string; index: number };
export const live2DIdleParts = ['head', 'body', 'arms', 'hair', 'clothes', 'eyes'] as const;
export type Live2DIdlePart = typeof live2DIdleParts[number];
export type Live2DIdleTuning = Record<Live2DIdlePart | 'speed', number>;
export const live2DIdleLimits = { speed: [0.5, 2], amplitude: [0, 1.6] } as const;
export const defaultLive2DIdleTuning: Live2DIdleTuning = {
  speed: 1, head: 1, body: 1, arms: 1, hair: 1, clothes: 1, eyes: 1,
};
export type Live2DIdleRig = {
  motion: Live2DMotion;
  tracks: Partial<Record<Live2DIdlePart | 'base', string[]>>;
  physics: Partial<Record<Live2DIdlePart, string[]>>;
};

export type Live2DStyle = {
  frame: 'portrait' | 'full';
  zoom: number;
  x: number;
  y: number;
  gaze: number;
  mouthGain: number;
  mouth: { open?: string; form?: string; wide?: string; round?: string };
  cues: Partial<Record<Live2DCue, { expression?: string; motion?: Live2DMotion }>>;
  idle?: Live2DIdleTuning;
  glasses?: boolean;
};
export type Live2DProfile = {
  id: string;
  name: string;
  source: 'bundled' | 'sample' | 'local';
  url: string;
  textures: string[];
  expressions: string[];
  motions: Live2DMotion[];
  lipSync: string[];
  physics: boolean;
  idle?: Live2DIdleRig;
  glassesParameter?: string;
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
