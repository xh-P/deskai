import { access, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PERSONA_ID, isPersonaId, isRelationshipMode, type ChatPersonaId, type RelationshipMode } from '../../../packages/voice-core/src/persona-catalog.ts';
import { AEC_MODES, type AecMode } from '../../../packages/voice-core/src/aec-mode.ts';

export type DesktopPreferences = {
  personaId: ChatPersonaId; relationshipMode: RelationshipMode; replyLanguage: 'auto' | 'zh' | 'ja' | 'en';
  voiceId: string; referenceId: string; inputDeviceId: string; outputDeviceId: string;
  volume: number; speed: number; closeToTray: boolean; wakePhrases: string[] | null;
  aecMode: AecMode | null;
  characterKnowledge: boolean;
};
export const defaultPreferences: DesktopPreferences = {
  personaId: DEFAULT_PERSONA_ID, relationshipMode: 'friend', replyLanguage: 'auto', voiceId: 'nagato-normal-v2', referenceId: '',
  inputDeviceId: '', outputDeviceId: '', volume: 0.8, speed: 1, closeToTray: true, wakePhrases: null, aecMode: null, characterKnowledge: false,
};
/** Only supported UI values are persisted; no arbitrary paths, prompts or credentials. */
export function mergePreferences(previous: DesktopPreferences, value: unknown): DesktopPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_PREFERENCES');
  const patch = value as Record<string, unknown>;
  const next = { ...previous };
  for (const [key, item] of Object.entries(patch)) {
    if (!(key in defaultPreferences)) throw new Error('INVALID_PREFERENCES');
    if (key === 'wakePhrases') {
      if (item !== null && (!Array.isArray(item) || item.length === 0 || item.length > 50 || item.some(p => typeof p !== 'string' || !p.trim() || p.length > 100 || /[\x00-\x1f]/u.test(p)))) throw new Error('INVALID_WAKE_PHRASES');
      Object.assign(next, { wakePhrases: item === null ? null : [...new Set((item as string[]).map(p => p.trim()))] });
      continue;
    } else if (key === 'aecMode') {
      if (item !== null && (typeof item !== 'string' || !(AEC_MODES as readonly string[]).includes(item))) throw new Error('INVALID_AEC_CONFIG');
    } else if (key === 'personaId') {
      if (!isPersonaId(item)) throw new Error('INVALID_PERSONA');
    } else if (key === 'relationshipMode') {
      if (!isRelationshipMode(item)) throw new Error('INVALID_RELATIONSHIP');
    } else if (key === 'replyLanguage') {
      if (!['auto', 'zh', 'ja', 'en'].includes(String(item))) throw new Error('INVALID_LANGUAGE');
    } else if (key === 'volume' || key === 'speed') {
      if (typeof item !== 'number' || !Number.isFinite(item) || item < (key === 'volume' ? 0 : 0.6) || item > (key === 'volume' ? 1 : 1.6)) throw new Error('INVALID_AUDIO_SETTING');
    } else if (key === 'closeToTray' || key === 'characterKnowledge') {
      if (typeof item !== 'boolean') throw new Error('INVALID_PREFERENCES');
    } else if (typeof item !== 'string' || item.length > 256 || /[\x00-\x1f]/u.test(item)) throw new Error('INVALID_SETTING');
    Object.assign(next, { [key]: item });
  }
  return next;
}
export async function loadPreferences(directory: string): Promise<DesktopPreferences> {
  try { return mergePreferences(defaultPreferences, JSON.parse(await readFile(path.join(directory, 'voice-preferences.json'), 'utf8'))); }
  catch { return { ...defaultPreferences }; }
}
export async function savePreferences(directory: string, preferences: DesktopPreferences): Promise<void> {
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, 'voice-preferences.json');
  const temporary = destination + '.tmp';
  await writeFile(temporary, JSON.stringify(preferences, null, 2));
  await rename(temporary, destination);
}
export async function inspectAssets(assetRoot: string): Promise<{ ready: boolean; missing: string[] }> {
  const required = ['.conda/gsv-v5/python.exe', 'runtime/GPT-SoVITS/GPT_SoVITS/TTS_infer_pack/TTS.py',
    'assets/凉宫春日模型包.part1/GPT_weights_v2/characters.json', 'assets/凉宫春日参考语音包'];
  const missing: string[] = [];
  for (const relative of required) {
    try { await access(path.join(assetRoot, relative)); } catch { missing.push(relative); }
  }
  return { ready: missing.length === 0, missing };
}
