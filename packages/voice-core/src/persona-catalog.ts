export const DEFAULT_PERSONA_ID = 'nagato-normal-light';
export type ChatPersonaId = string;
export type RelationshipMode = 'friend' | 'kyon';

export function isPersonaId(value: unknown): value is ChatPersonaId {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
}

export function isRelationshipMode(value: unknown): value is RelationshipMode {
  return value === 'friend' || value === 'kyon';
}
