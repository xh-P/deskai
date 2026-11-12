import type { CharacterLookupSummary, CharacterReference } from './character-reference.ts';
import type { DeliveryMode } from './delivery.ts';
import type { ChatPersonaId, RelationshipMode } from './persona-catalog.ts';
import type { Persona, ReplyLanguage } from './prompts.ts';
import type { GestureName } from './gesture.ts';

export interface ChatTurnInput {
  requestId?: string;
  text: string;
  personaId?: ChatPersonaId;
  persona?: Persona;
  relationshipMode?: RelationshipMode;
  visibleHistory?: readonly unknown[];
  deliveryState?: unknown;
  mode?: DeliveryMode;
  replyLanguage?: ReplyLanguage;
  hostContext?: unknown;
  characterKnowledge?: boolean;
  characterReference?: readonly CharacterReference[];
  gestureActions?: readonly GestureName[];
}

export type ChatEvent =
  | { type: 'attempt-start'; attemptId: string; revision: number }
  | { type: 'text'; attemptId: string; index: number; revision: number; text: string }
  | { type: 'attempt-end'; attemptId: string; outcome: 'committed' | 'abandoned'; eventType?: string }
  | { type: 'usage'; usage: unknown }
  | { type: 'error'; code: string };

export interface ChatSettlement { sessionId: string; status: 'completed' | 'cancelled' | 'failed'; code?: string }
export interface ChatAccepted { accepted: true; sessionId: string; completed: Promise<ChatSettlement>; knowledge?: CharacterLookupSummary }

export interface DialoguePort {
  runTurn(input: ChatTurnInput, event: (event: ChatEvent) => void): Promise<ChatAccepted>;
  cancel(): Promise<ChatSettlement | undefined>;
}
