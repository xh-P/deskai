import type { ChatTurnInput } from './chat-contract.ts';
import { buildPersonaContext, type Persona } from './prompts.ts';

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CHAT_CONTEXT_SHAPE');
  return value as Record<string, unknown>;
}
function short(value: unknown, max = 1200): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('CHAT_CONTEXT_LENGTH');
  return value;
}
function projectionHistory(value: readonly unknown[] | undefined): object[] {
  if (!value) return [];
  if (!Array.isArray(value) || value.length > 24) throw new Error('CHAT_CONTEXT_LENGTH');
  return value.map(item => {
    const entry = row(item);
    if (entry.role !== 'user' && entry.role !== 'assistant') throw new Error('CHAT_HISTORY_ROLE');
    return { role: entry.role, turnId: short(entry.turnId, 120), text: short(entry.text),
      ...(entry.role === 'assistant' ? { interrupted: entry.interrupted === true } : {}) };
  });
}
function projectionDelivery(value: unknown): object | null {
  if (value == null) return null;
  const data = row(value);
  const source = data.attempts ?? [];
  if (!Array.isArray(source) || source.length > 32) throw new Error('CHAT_CONTEXT_LENGTH');
  const attempts = source.map(item => {
    const attempt = row(item);
    const segments = attempt.fullyPlayedSegments ?? [];
    if (!Array.isArray(segments) || segments.length > 16) throw new Error('CHAT_CONTEXT_LENGTH');
    const played = segments.map(segment => { const s = row(segment); return { segmentId: short(s.segmentId, 120), text: short(s.text) }; });
    const partial = attempt.partiallyPlayedSegment == null ? undefined : row(attempt.partiallyPlayedSegment);
    const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 ? n : 0;
    return { attemptId: short(attempt.attemptId, 120), turnId: short(attempt.turnId, 120),
      deliveryMode: attempt.deliveryMode,
      generatedCharacters: count(attempt.generatedCharacters), unplayedCharacters: count(attempt.unplayedCharacters),
      fullyPlayedSegments: played,
      ...(partial ? { partiallyPlayedSegment: { segmentId: short(partial.segmentId, 120) } } : {}),
      ...(attempt.deliveryMode === 'text' ? { displayed: short(attempt.displayed ?? '') } : {}),
      interrupted: attempt.interrupted === true };
  });
  const question = data.pendingQuestion == null ? undefined : row(data.pendingQuestion);
  const submitted = data.submittedUtteranceIds;
  return { attempts,
    ...(question ? { pendingQuestion: { questionId: short(question.questionId, 120), turnId: short(question.turnId, 120),
      text: short(question.text, 512), status: question.status } } : {}),
    ...(Number.isSafeInteger(data.continuationOf) ? { continuationOf: data.continuationOf } : {}),
    ...(Array.isArray(submitted) ? { submittedUtteranceIds: submitted.filter(n => Number.isSafeInteger(n)).slice(0, 16) } : {}),
    ...(typeof data.promptVersion === 'string' ? { promptVersion: short(data.promptVersion, 80) } : {}) };
}

export function buildChatContent(input: ChatTurnInput, persona?: Persona): string {
  const text = input.text.trim();
  if (!text || [...text].length > 4000) throw new Error('CHAT_INPUT_LENGTH');
  const projection = JSON.stringify({
    kind: 'deskai2-visible-history-v1',
    mode: input.mode ?? 'voice', replyLanguage: input.replyLanguage ?? 'auto',
    visibleHistory: projectionHistory(input.visibleHistory), deliveryState: projectionDelivery(input.deliveryState),
    currentUserText: text,
    avatarGestures: input.gestureActions,
    hostContext: input.hostContext ?? null
  });
  if ([...projection].length > 16000) throw new Error('CHAT_CONTEXT_LENGTH');
  const role = persona ? { roleProfile: buildPersonaContext(persona, input.relationshipMode) } : {};
  const references = input.characterReference?.slice(0, 3).map(({ id, source, locator, text }) => ({ id, source, locator, text })) ?? [];
  return `以下是桌面应用提供的结构化对话投影。visibleHistory 仅含已接纳用户输入和已交付助手正文：voice 为完整已播句，text 为界面确认已显示文字。deliveryState 只含交付元数据与计数，未播正文不进入模型上下文。请直接回答 currentUserText。\n${projection}\n${JSON.stringify({ ...role, characterReference: references })}`;
}
