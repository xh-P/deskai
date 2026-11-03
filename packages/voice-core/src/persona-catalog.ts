/** Shared IDs bind settings, desktop choices and the generated dsh presets. */
export const PERSONA_PRESETS = {
  'nagato-normal-light': { default: 'deskai2-voice-m2-nagato' },
  'assistant-neutral': { default: 'deskai2-voice-m2-neutral' },
  'nagato-mainline-post-disappearance': {
    friend: 'deskai2-voice-nagato-mainline-friend',
    kyon: 'deskai2-voice-nagato-mainline-kyon',
  },
} as const;
export type ChatPersonaId = keyof typeof PERSONA_PRESETS;
export type RelationshipMode = 'friend' | 'kyon';
export const PERSONA_IDS = Object.keys(PERSONA_PRESETS) as ChatPersonaId[];
export function isPersonaId(value: unknown): value is ChatPersonaId {
  return typeof value === 'string' && Object.hasOwn(PERSONA_PRESETS, value);
}
export function isRelationshipMode(value: unknown): value is RelationshipMode { return value === 'friend' || value === 'kyon'; }
export function personaPreset(personaId: ChatPersonaId = 'nagato-normal-light', relationshipMode: RelationshipMode = 'friend'): string {
  if (!isPersonaId(personaId)) throw new Error('INVALID_PERSONA');
  if (!isRelationshipMode(relationshipMode)) throw new Error('INVALID_RELATIONSHIP');
  const presets = PERSONA_PRESETS[personaId];
  return 'default' in presets ? presets.default : presets[relationshipMode];
}
