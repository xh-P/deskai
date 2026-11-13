import type { Live2DDisplayEntry, Live2DDisplayInfo, Live2DIdleRig, Live2DLayer, Live2DLayerRig,
  Live2DMotion, Live2DMotionGroup, Live2DMotionTrack } from '../../../packages/desktop-pet/src/live2d.ts';

export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
export const ids = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.flatMap(item => text(item) ?? []))] : [];

function entries<T extends { id: string }>(value: unknown, parse: (entry: Record<string, unknown>) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  const result = new Map<string, T>();
  for (const item of value) {
    const entry = parse(object(item));
    if (entry && !result.has(entry.id)) result.set(entry.id, entry);
  }
  return [...result.values()];
}

export function displayInfo(value: unknown): Live2DDisplayInfo {
  const { Version, Parts, Parameters, ParameterGroups } = object(value);
  if (Version !== 3) throw new Error('无效的 Cubism 显示信息。');
  const parse = (item: Record<string, unknown>): Live2DDisplayEntry | undefined => {
    const id = text(item.Id);
    return id ? { id, name: text(item.Name), groupId: text(item.GroupId) } : undefined;
  };
  return { parts: entries(Parts, parse), parameters: entries(Parameters, parse), groups: entries(ParameterGroups, parse) };
}

function motion(value: unknown): Live2DMotion | undefined {
  const { group, index } = object(value);
  if (typeof group === 'string' && typeof index === 'number' && Number.isInteger(index) && index >= 0) return { group, index };
}

export function idleRig(value: unknown): Live2DIdleRig | undefined {
  const raw = object(value);
  const clip = motion(raw.motion);
  if (!clip) return;
  const channels = (value: unknown, reserved: string[]) => {
    const assigned = new Set<string>();
    return Object.fromEntries(Object.entries(object(value)).flatMap(([key, item]) => {
      if (!key.trim() || reserved.includes(key)) return [];
      const channels = ids(item).filter(id => !assigned.has(id));
      channels.forEach(id => assigned.add(id));
      return channels.length ? [[key, channels] as const] : [];
    }));
  };
  const groupNames = Object.fromEntries(Object.entries(object(raw.groupNames)).flatMap(([id, name]) => {
    const label = text(name);
    return label ? [[id, label] as const] : [];
  }));
  return { motion: clip, tracks: channels(raw.tracks, ['speed']), physics: channels(raw.physics, ['base', 'speed']), groupNames };
}

export function idleTrackIds(value: unknown): Set<string> {
  const { Meta, Curves } = object(value);
  const duration = object(Meta).Duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || !Array.isArray(Curves) ||
      !Curves.length || Curves.some(curve => object(curve).Target !== 'Parameter')) {
    throw new Error('调校待机需要有时长且只包含参数曲线的动作。');
  }
  const parameters = ids(Curves.map(curve => object(curve).Id));
  if (parameters.length !== Curves.length) throw new Error('待机动作的参数 ID 无效或重复。');
  return new Set(parameters);
}

export function physicsOutputs(value: unknown): { outputs: Set<string>; response: string[] } {
  const { PhysicsSettings } = object(value);
  const groups = Array.isArray(PhysicsSettings) ? PhysicsSettings.map(setting => {
    const { Output } = object(setting);
    return ids(Array.isArray(Output) ? Output.map(output => object(object(output).Destination).Id) : []);
  }) : [];
  const shared = new Set(groups.filter(group => group.length > 1).flat());
  const outputs = new Set(groups.flat());
  return { outputs, response: [...outputs].filter(id => !shared.has(id)) };
}

export function layerRig(value: unknown): Live2DLayerRig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的图层调校清单。');
  const { layers, motionGroups, idle, glassesParameter, blink } = object(value);
  const authoredIdle = idleRig(idle);
  if ((layers !== undefined && !Array.isArray(layers)) || (motionGroups !== undefined && !Array.isArray(motionGroups)) ||
      (idle !== undefined && !authoredIdle)) throw new Error('无效的图层调校清单。');
  const parseLayer = (item: Record<string, unknown>): Live2DLayer | undefined => {
    const id = text(item.id);
    if (!id) return;
    return { id, name: text(item.name) ?? id, group: text(item.group), motion: ids(item.motion), sway: ids(item.sway),
      shape: item.shape === 'anchored' || item.shape === 'seamed' ? item.shape : undefined };
  };
  const parseTrack = (item: Record<string, unknown>): Live2DMotionTrack | undefined => {
    const id = text(item.id);
    if (!id) return;
    const degrees = typeof item.degrees === 'number' && Number.isFinite(item.degrees) && item.degrees > 0 ? item.degrees : undefined;
    return { id, name: text(item.name) ?? id, degrees };
  };
  const parseGroup = (item: Record<string, unknown>): Live2DMotionGroup | undefined => {
    const id = text(item.id);
    const tracks = entries(item.tracks, parseTrack);
    return id && tracks.length ? { id, name: text(item.name) ?? id, tracks } : undefined;
  };
  return { layers: entries(layers, parseLayer), motionGroups: entries(motionGroups, parseGroup), idle: authoredIdle,
    glassesParameter: text(glassesParameter), blink: motion(blink) };
}
