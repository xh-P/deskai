import type { PetState } from './types.ts';

export type Live2DCue = PetState | 'tap';
export type Live2DMotion = { group: string; index: number };
export type Live2DIdleTuning = { speed: number; [group: string]: number | undefined };
export const live2DIdleLimits = { speed: [0.5, 2], amplitude: [0, 1.6] } as const;
export const defaultLive2DIdleTuning: Live2DIdleTuning = { speed: 1 };
export type Live2DIdleRig = {
  motion: Live2DMotion;
  tracks: Record<string, string[]>;
  physics: Record<string, string[]>;
  groupNames?: Record<string, string>;
};

export function live2DIdleGroups(rig: Live2DIdleRig): string[] {
  return [...new Set([...Object.keys(rig.tracks), ...Object.keys(rig.physics)])].filter(id => id !== 'base' && id !== 'speed');
}

export type Live2DDisplayEntry = { id: string; name?: string; groupId?: string };
export type Live2DDisplayInfo = { parts: Live2DDisplayEntry[]; parameters: Live2DDisplayEntry[]; groups: Live2DDisplayEntry[] };
export type Live2DSoftShape = 'anchored' | 'seamed';
export type Live2DMotionTrack = { id: string; name: string; degrees?: number };
export type Live2DMotionGroup = { id: string; name: string; tracks: Live2DMotionTrack[] };
export type Live2DLayer = {
  id: string;
  name: string;
  group?: string;
  shape?: Live2DSoftShape;
  motion?: string[];
  sway?: string[];
};
export type Live2DLayerRig = {
  layers?: Live2DLayer[];
  motionGroups?: Live2DMotionGroup[];
  idle?: Live2DIdleRig;
  glassesParameter?: string;
  blink?: Live2DMotion;
};
export type Live2DLayerShape = { width: number; height: number; bend: number };
export type Live2DLayerSway = { amplitude: number; response: number };
export type Live2DTrackTuning = { amplitude: number; delay: number };
export const defaultLive2DLayerShape: Live2DLayerShape = { width: 1, height: 1, bend: 0 };
export const defaultLive2DLayerSway: Live2DLayerSway = { amplitude: 1, response: 1 };
export const defaultLive2DTrackTuning: Live2DTrackTuning = { amplitude: 1, delay: 0 };
export const live2DLayerLimits = {
  width: [0.9, 1.1], height: [0.9, 1.1], bend: [-0.12, 0.12],
  amplitude: live2DIdleLimits.amplitude, response: [0.75, 1.25], delay: [-0.4, 0.4],
} as const;

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
  layerShapes?: Record<string, Live2DLayerShape>;
  layerSway?: Record<string, Live2DLayerSway>;
  motionTracks?: Record<string, Live2DTrackTuning>;
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
  display?: Live2DDisplayInfo;
  layers?: Live2DLayer[];
  swayResponse?: string[];
  motionGroups?: Live2DMotionGroup[];
  idle?: Live2DIdleRig;
  glassesParameter?: string;
  blink?: Live2DMotion;
  warnings?: string[];
  style: Live2DStyle;
};

export function live2DTunableTracks(profile: Live2DProfile): string[] {
  if (!profile.idle) return [];
  const { base = [], ...groups } = profile.idle.tracks;
  const authored = new Set([
    ...(profile.motionGroups ?? []).flatMap(group => group.tracks.map(track => track.id)),
    ...(profile.layers ?? []).flatMap(layer => layer.motion ?? []),
  ]);
  return [...Object.values(groups).flat(), ...base.filter(id => authored.has(id))];
}

export function live2DSetting<T>(values: Readonly<Record<string, T>> | undefined, id: string): T | undefined {
  return values && Object.hasOwn(values, id) ? values[id] : undefined;
}
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
