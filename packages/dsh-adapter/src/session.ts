import { randomUUID } from 'node:crypto';
import type { LocalDshSpeech } from './speech.ts';
import type { ChatAccepted, ChatEvent, ChatSettlement, ChatTurnInput, DialoguePort } from '../../voice-core/src/chat-contract.ts';
import { DESKTOP_CHAT_PRESET } from '../../voice-core/src/prompts.ts';
import { buildChatContent } from '../../voice-core/src/chat-context.ts';
import { readBundledPersona } from '../../voice-core/src/persona-files.ts';
import type { DshEvent } from './session-feed.ts';
type ActiveTurn = { sessionId: string; completed: Promise<ChatSettlement>; cancelRequested: boolean; promptAccepted: boolean;
  promptSubmitted: boolean; cancelRpc?: Promise<void>; requestCancel?: () => void; reconnect?: () => Promise<void> };

type MuxFrame = { type?: string; value?: FollowValue; error?: { code?: string } };
type FollowValue = { type?: string; cursor?: number; event?: DshEvent; frame?: StreamFrame;
  assistantStream?: { activeAttempt?: { attemptId?: string; nextIndex?: number } } };
type StreamFrame = { type?: string; attemptId?: string; revision?: number; index?: number; chunk?: { type?: string; text?: string; usage?: unknown; reason?: { kind?: string; failure?: { code?: string } } }; outcome?: { kind?: string; eventType?: string } };

/** Uses the authenticated Host already owned by LocalDshSpeech. Each turn is projected into a fresh Session. */
export class LocalDshChat implements DialoguePort {
  private active?: ActiveTurn;
  private readonly host: LocalDshSpeech;
  private readonly root: string;
  private readonly options: { preset?: string; renderInput?: (input: ChatTurnInput) => string };
  constructor(host: LocalDshSpeech, root: string, options: { preset?: string; renderInput?: (input: ChatTurnInput) => string } = {}) {
    this.host = host; this.root = root; this.options = options;
  }

  async runTurn(input: ChatTurnInput, onEvent: (event: ChatEvent) => void,
      observe?: (sessionId: string, event: DshEvent) => void): Promise<ChatAccepted> {
    if (this.active) throw new Error('CHAT_TURN_BUSY');
    const preset = this.options.preset ?? DESKTOP_CHAT_PRESET;
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
        if (item.event) observe?.(active.sessionId, item.event);
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
      const content = this.options.renderInput?.(input) ?? buildChatContent(input, input.persona ?? await readBundledPersona(this.root, input.personaId));
      if (active.cancelRequested) throw new Error('CHAT_TURN_CANCELLED_BEFORE_PROMPT');
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
