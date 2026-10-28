import { randomUUID } from 'node:crypto';
import type { LocalDshSpeech } from './speech.ts';

export type ChatPersonaId = 'nagato-normal-light' | 'assistant-neutral';
export interface ChatTurnInput {
  requestId?: string;
  text: string;
  personaId?: ChatPersonaId;
  visibleHistory?: readonly unknown[];
  deliveryState?: unknown;
  mode?: 'voice' | 'text';
  replyLanguage?: 'auto' | 'zh' | 'ja' | 'en';
}
export type ChatEvent =
  | { type: 'attempt-start'; attemptId: string; revision: number }
  | { type: 'text'; attemptId: string; index: number; revision: number; text: string }
  | { type: 'attempt-end'; attemptId: string; outcome: 'committed' | 'abandoned'; eventType?: string }
  | { type: 'usage'; usage: unknown }
  | { type: 'error'; code: string };
export interface ChatSettlement { sessionId: string; status: 'completed' | 'cancelled' | 'failed'; code?: string }
export interface ChatAccepted { accepted: true; sessionId: string; completed: Promise<ChatSettlement> }
type ActiveTurn = { sessionId: string; completed: Promise<ChatSettlement>; cancelRequested: boolean; promptAccepted: boolean;
  promptSubmitted: boolean; cancelRpc?: Promise<void>; requestCancel?: () => void; reconnect?: () => Promise<void> };

type MuxFrame = { type?: string; value?: FollowValue; error?: { code?: string } };
type FollowValue = { type?: string; cursor?: number; event?: { seq?: number; type?: string; data?: unknown }; frame?: StreamFrame;
  assistantStream?: { activeAttempt?: { attemptId?: string; nextIndex?: number } } };
type StreamFrame = { type?: string; attemptId?: string; revision?: number; index?: number; chunk?: { type?: string; text?: string; usage?: unknown; reason?: { kind?: string; failure?: { code?: string } } }; outcome?: { kind?: string; eventType?: string } };

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
      action: attempt.action, deliveryMode: attempt.deliveryMode,
      generatedCharacters: count(attempt.generatedCharacters), unplayedCharacters: count(attempt.unplayedCharacters),
      fullyPlayedSegments: played,
      ...(partial ? { partiallyPlayedSegment: { segmentId: short(partial.segmentId, 120), text: short(partial.text) } } : {}),
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

function boundedText(input: ChatTurnInput): string {
  const text = input.text.trim();
  if (!text || [...text].length > 4000) throw new Error('CHAT_INPUT_LENGTH');
  const projection = JSON.stringify({
    kind: 'deskai2-visible-history-v1',
    mode: input.mode ?? 'voice', replyLanguage: input.replyLanguage ?? 'auto',
    visibleHistory: projectionHistory(input.visibleHistory), deliveryState: projectionDelivery(input.deliveryState),
    currentUserText: text
  });
  if ([...projection].length > 16000) throw new Error('CHAT_CONTEXT_LENGTH');
  return `以下是桌面应用提供的结构化对话投影。visibleHistory 仅含已接纳用户输入和已交付助手正文：voice 为完整已播句，text 为界面确认已显示文字。deliveryState 只含交付元数据与计数，未播正文不进入模型上下文。历史 JSON 控制头不是已说出口的话。只对 currentUserText 做本轮一次回应决策。\n${projection}`;
}

/** Uses the authenticated Host already owned by LocalDshSpeech. Each turn is projected into a fresh Session. */
export class LocalDshChat {
  private active?: ActiveTurn;
  private readonly host: LocalDshSpeech;
  private readonly root: string;
  constructor(host: LocalDshSpeech, root: string) { this.host = host; this.root = root; }

  async runTurn(input: ChatTurnInput, onEvent: (event: ChatEvent) => void): Promise<ChatAccepted> {
    if (this.active) throw new Error('CHAT_TURN_BUSY');
    const content = boundedText(input);
    const preset = input.personaId === 'assistant-neutral' ? 'deskai2-voice-m2-neutral' : 'deskai2-voice-m2-nagato';
    let finish!: (value: ChatSettlement) => void;
    const completed = new Promise<ChatSettlement>(resolve => { finish = resolve; });
    const active: ActiveTurn = { sessionId: '', completed, cancelRequested: false, promptAccepted: false, promptSubmitted: false };
    this.active = active;
    let closeFollow: (() => void) | undefined;
    let snapshotTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    let cancelGraceTimer: NodeJS.Timeout | undefined;
    let snapshot!: () => void;
    let rejectSnapshot!: (error: Error) => void;
    const snapshotReady = new Promise<void>((resolve, reject) => {
      snapshot = () => { if (snapshotTimer) clearTimeout(snapshotTimer); resolve(); };
      rejectSnapshot = (error) => { if (snapshotTimer) clearTimeout(snapshotTimer); reject(error); };
    });
    let baseline = -1;
    let lastDurable = -1;
    const nextIndex = new Map<string, number>();
    const endedAttempts = new Set<string>();
    let textLength = 0;
    let failedCode: string | undefined;
    let settled = false;
    const emit = (event: ChatEvent) => { try { onEvent(event); } catch { /* Consumer errors must not break transport settlement. */ } };
    const settle = (status: ChatSettlement['status'], code?: string, release = true) => {
      if (settled) return;
      settled = true;
      if (snapshotTimer) clearTimeout(snapshotTimer);
      if (settleTimer) clearTimeout(settleTimer);
      if (cancelGraceTimer) clearTimeout(cancelGraceTimer);
      closeFollow?.();
      if (release && this.active === active) this.active = undefined;
      finish({ sessionId: active.sessionId, status, ...(code ? { code } : {}) });
    };
    const requestCancel = () => {
      active.cancelRequested = true;
      if (!active.promptSubmitted || settled) return;
      if (settleTimer) clearTimeout(settleTimer);
      if (!cancelGraceTimer) cancelGraceTimer = setTimeout(() => {
        const code = failedCode ?? 'CHAT_CANCEL_UNCONFIRMED';
        emit({ type: 'error', code });
        // No durable turn/end: keep the reservation until the owning Host is disposed.
        settle('failed', code, false);
      }, 30_000);
      if (active.promptAccepted) active.cancelRpc ??= this.host.sessionCall<{ accepted: true }>('session/cancel', { sessionId: active.sessionId })
        .then(value => { if (value.accepted !== true) throw new Error('CHAT_CANCEL_REJECTED'); })
        .catch(() => { failedCode ??= 'CHAT_CANCEL_RPC_FAILED'; emit({ type: 'error', code: failedCode }); });
    };
    active.requestCancel = requestCancel;
    const handle = (raw: unknown) => {
      const wire = raw as MuxFrame;
      if (wire.type === 'error') {
        const code = wire.error?.code ?? 'DSH_FOLLOW_FAILED';
        failedCode = code;
        emit({ type: 'error', code });
        if (!active.promptSubmitted) { rejectSnapshot(new Error(code)); settle('failed', code); }
        else requestCancel();
        return;
      }
      if (wire.type !== 'item') return;
      const item = wire.value;
      if (item?.type === 'snapshot') {
        baseline = item.cursor ?? -1;
        const live = item.assistantStream?.activeAttempt;
        if (live?.attemptId && typeof live.nextIndex === 'number') {
          const expected = nextIndex.get(live.attemptId);
          if (expected !== undefined && live.nextIndex > expected) {
            failedCode = 'CHAT_RECONNECT_GAP'; emit({ type: 'error', code: failedCode });
            requestCancel();
          }
          if (expected === undefined || live.nextIndex > expected) nextIndex.set(live.attemptId, live.nextIndex);
        }
        snapshot(); return;
      }
      if (item?.type === 'event') {
        const seq = item.event?.seq ?? -1;
        if (seq <= baseline || seq <= lastDurable) return;
        lastDurable = seq;
        // Durable assistant/message is audit history only. Never emit its text for playback.
        if (item.event?.type === 'turn/end') settle(failedCode ? 'failed' : active.cancelRequested ? 'cancelled' : 'completed', failedCode);
        return;
      }
      if (item?.type !== 'assistant-stream') return;
      const frame = item.frame;
      const attemptId = frame?.attemptId;
      if (!attemptId) return;
      if (frame.type === 'start') {
        if (nextIndex.has(attemptId) || endedAttempts.has(attemptId)) return;
        nextIndex.set(attemptId, 0); emit({ type: 'attempt-start', attemptId, revision: frame.revision ?? 0 }); return;
      }
      if (frame.type === 'chunk') {
        if (endedAttempts.has(attemptId)) return;
        const index = frame.index ?? -1;
        const next = nextIndex.get(attemptId) ?? 0;
        if (index < next) return;
        if (index > next) { failedCode = 'CHAT_STREAM_GAP'; emit({ type: 'error', code: failedCode }); requestCancel(); return; }
        nextIndex.set(attemptId, index + 1);
        const chunk = frame.chunk;
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && !failedCode) {
          textLength += [...chunk.text].length;
          if (textLength > 12000) { failedCode = 'CHAT_OUTPUT_LENGTH'; emit({ type: 'error', code: failedCode }); requestCancel(); }
          else emit({ type: 'text', attemptId, index, revision: frame.revision ?? 0, text: chunk.text });
        } else if (chunk?.type === 'usage') emit({ type: 'usage', usage: chunk.usage });
        else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
          failedCode = chunk.reason.failure?.code ?? 'CHAT_MODEL_ERROR'; emit({ type: 'error', code: failedCode });
        }
        return;
      }
      if (frame.type === 'end' && !endedAttempts.has(attemptId)) {
        endedAttempts.add(attemptId);
        emit({ type: 'attempt-end', attemptId, outcome: frame.outcome?.kind === 'abandoned' ? 'abandoned' : 'committed', eventType: frame.outcome?.eventType });
      }
    };
    try {
      const created = await this.host.sessionCall<{ sessionId: string; agentPreset?: string }>('session/create', { cwd: this.root, agentPreset: preset });
      if (!created.sessionId || created.agentPreset !== preset) throw new Error('CHAT_PRESET_MISMATCH');
      active.sessionId = created.sessionId;
      if (active.cancelRequested) throw new Error('CHAT_TURN_CANCELLED_BEFORE_PROMPT');
      const sessionId = active.sessionId;
      snapshotTimer = setTimeout(() => rejectSnapshot(new Error('CHAT_SNAPSHOT_TIMEOUT')), 15_000);
      closeFollow = await this.host.sessionFollow({ address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 16 }, handle);
      active.reconnect = async () => {
        if (settled) throw new Error('CHAT_TURN_SETTLED');
        closeFollow?.();
        closeFollow = await this.host.sessionFollow({ address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 16 }, handle);
      };
      await snapshotReady;
      if (settled) throw new Error('CHAT_FOLLOW_SETTLED');
      if (active.cancelRequested) throw new Error('CHAT_TURN_CANCELLED_BEFORE_PROMPT');
      active.promptSubmitted = true;
      const receipt = await this.host.sessionCall<{ accepted: true }>('session/prompt', {
        requestId: input.requestId ?? randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: content }]
      });
      if (receipt.accepted !== true) throw new Error('CHAT_PROMPT_REJECTED');
      active.promptAccepted = true;
      if (active.cancelRequested) requestCancel();
      if (!settled) settleTimer = setTimeout(() => {
        if (settled) return;
        failedCode = 'CHAT_SETTLEMENT_TIMEOUT';
        emit({ type: 'error', code: failedCode });
        requestCancel();
      }, 180_000);
      return { accepted: true, sessionId, completed };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'CHAT_TRANSPORT_ERROR';
      if (code === 'CHAT_TURN_CANCELLED_BEFORE_PROMPT') settle('cancelled');
      else {
        emit({ type: 'error', code });
        if (active.promptSubmitted) { active.promptAccepted = true; requestCancel(); settle('failed', code, false); }
        else settle('failed', code);
      }
      throw error;
    }
  }

  async cancel(): Promise<ChatSettlement | undefined> {
    const active = this.active;
    if (!active) return undefined;
    active.cancelRequested = true;
    active.requestCancel?.();
    return active.completed;
  }

  /** Reopen follow on the same authenticated Mux. Snapshot records remain audit-only. */
  async reconnectFollow(): Promise<void> {
    const reconnect = this.active?.reconnect;
    if (!reconnect) throw new Error('CHAT_NO_ACTIVE_FOLLOW');
    await reconnect();
  }
}
