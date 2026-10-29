import { DecisionStream, DeliveryLedger, PROMPT_VERSION } from './m2.ts';
import type { DecisionHeader, DeliveryMode, Persona, ReplyLanguage } from './m2.ts';
import { localDecision } from './policy.ts';
import { cleanSpeech } from './sentences.ts';
import type { ChatAccepted, ChatEvent, ChatPersonaId, ChatSettlement, ChatTurnInput } from '../../dsh-adapter/src/session.ts';

export type DialoguePort = { runTurn(input: ChatTurnInput, event: (event: ChatEvent) => void): Promise<ChatAccepted>; cancel(): Promise<ChatSettlement | undefined> };
export type DialoguePreferences = { personaId: ChatPersonaId; replyLanguage: ReplyLanguage; voiceId: string };
export type DialogueInput = { text: string; source: DeliveryMode; continuationOf?: number; utteranceIds?: number[];
  isEligible?: () => boolean; onAccepted?: () => void; noSpeech?: boolean; acousticEcho?: boolean; retryOf?: string };
export type DialogueEvent =
  | { type: 'user'; turnId: string; text: string; source: DeliveryMode }
  | { type: 'decision'; turnId: string; generationId: number; action: string; local: boolean }
  | { type: 'assistant-delta'; turnId: string; attemptId: string; generationId: number; text: string; source?: DeliveryMode }
  | { type: 'assistant-state'; turnId: string; attemptId?: string; generationId: number; state: 'complete' | 'interrupted' | 'error' }
  | { type: 'output-clear'; generationId: number }
  | { type: 'model-state'; state: 'idle' | 'generating' | 'cancelling' | 'waiting' | 'silent' | 'error'; code?: string }
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | { type: 'usage'; usage: unknown };
type UserHistory = { role: 'user'; turnId: string; text: string };
type Active = { id: string; epoch: number; generation: number; input: DialogueInput; accepted: boolean; canceled: boolean;
  parser?: DecisionStream; attemptId?: string; header?: DecisionHeader; failure?: string; finished?: boolean;
  attempts: string[]; completed?: Promise<ChatSettlement> };

/** One decision/generation request per admitted turn, with explicit delivery projection. */
export class DialogueController {
  readonly ledger = new DeliveryLedger({ maxAttempts: 16, maxText: 12000 });
  private port: DialoguePort;
  private preferences: DialoguePreferences;
  private emit: (event: DialogueEvent) => void;
  private active?: Active;
  private outputAttempt?: Active;
  private finalSegments = new Map<string, string>();
  private epoch = 0;
  private generation = 0;
  private serial = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private userHistory: UserHistory[] = [];
  private failedInput?: DialogueInput;
  private blocked?: string;
  private closed = false;
  private canceling?: Promise<void>;
  private counts = { modelRequests: 0, modelAttempts: 0, localFiltered: 0, protocolErrors: 0, usageEvents: 0 };
  private waitExpiresAt = 0;
  private waitTimer?: ReturnType<typeof setTimeout>;

  constructor(port: DialoguePort, preferences: DialoguePreferences, emit: (event: DialogueEvent) => void) {
    this.port = port; this.preferences = { ...preferences }; this.emit = emit;
  }

  get isGenerating(): boolean { return !!this.active && !this.active.finished && !this.active.canceled && !this.active.failure; }
  get generationId(): number { return this.generation; }
  get stats() { return { ...this.counts, promptVersion: PROMPT_VERSION, personaId: this.preferences.personaId }; }
  expectsReply(now = Date.now()): boolean {
    this.ledger.expirePendingQuestion(now, 120000);
    return this.ledger.getPendingQuestion()?.status === 'awaiting';
  }

  submit(input: DialogueInput): Promise<{ accepted: boolean; local?: string }> {
    if (this.closed) return Promise.resolve({ accepted: false });
    if (!input.text.trim() || input.text.length > 4000) return Promise.reject(new Error('INPUT_LENGTH'));
    if (this.queued >= 2) {
      this.emit({ type: 'error', code: 'INPUT_QUEUE_FULL', message: '已有输入正在处理，请稍后再试。', retryable: false });
      return Promise.resolve({ accepted: false });
    }
    const epoch = this.epoch;
    this.queued++;
    const work = this.queue.then(async () => {
      if (this.closed || epoch !== this.epoch || input.isEligible?.() === false) return { accepted: false };
      const pending = this.ledger.getPendingQuestion();
      this.clearWait();
      const local = localDecision(input.text, { outputPlaying: this.isGenerating || !!this.outputAttempt, expectsReply: this.expectsReply(),
        noSpeech: input.noSpeech, acousticEcho: input.acousticEcho });
      const turnId = input.retryOf ?? `turn-${++this.serial}`;
      if (local !== 'MODEL') {
        this.counts.localFiltered++;
        if (local === 'STOP') await this.cancel();
        if (local === 'SILENT' && pending?.status === 'awaiting' && /不用|不想|no thanks|答えたく|もういい/u.test(input.text)) this.ledger.markQuestionResolved();
        input.onAccepted?.();
        this.emit({ type: 'decision', turnId, generationId: this.generation, action: local, local: true });
        this.emit({ type: 'model-state', state: local === 'WAIT' ? 'waiting' : local === 'SILENT' ? 'silent' : 'idle' });
        if (local === 'WAIT') this.beginWait();
        return { accepted: true, local };
      }
      if (this.blocked) {
        this.failedInput = input;
        this.emit({ type: 'error', code: this.blocked, message: '模型账号尚未配置。请在 dsh 设置中配置后，点击重试。', retryable: true });
        return { accepted: false };
      }
      await this.cancel();
      if (this.closed || epoch !== this.epoch || input.isEligible?.() === false) return { accepted: false };
      const state: Active = { id: turnId, epoch, generation: ++this.generation, input, accepted: false,
        canceled: false, attempts: [] };
      this.active = state;
      this.emit({ type: 'model-state', state: 'generating' });
      const projection = this.projectHistory();
      const question = this.ledger.getPendingQuestion();
      try {
        this.counts.modelRequests++;
        const accepted = await this.port.runTurn({ requestId: `deskai-${epoch}-${this.serial}-${this.generation}`,
          text: input.text, personaId: this.preferences.personaId, mode: input.source, replyLanguage: this.preferences.replyLanguage,
          visibleHistory: projection.history, deliveryState: { attempts: projection.attempts,
            pendingQuestion: question, continuationOf: input.continuationOf,
            submittedUtteranceIds: input.utteranceIds ?? [], promptVersion: PROMPT_VERSION } }, event => this.onModelEvent(state, event));
        state.accepted = true;
        state.completed = accepted.completed;
        if (state.failure) this.failedInput = { ...state.input, retryOf: state.id };
        if (epoch === this.epoch && !this.closed) {
          try { input.onAccepted?.(); }
          catch { this.emit({ type: 'error', code: 'INPUT_RECEIPT_RECONCILED', message: '本轮输入已被模型接纳，后续识别片段失败；请继续说话。', retryable: false }); }
          if (!input.retryOf) {
            this.userHistory.push({ role: 'user', turnId, text: input.text });
            this.userHistory = this.userHistory.slice(-20);
            this.emit({ type: 'user', turnId, text: input.text, source: input.source });
          }
          // An explicit new request or answer resolves the previous question;
          // WAIT/SILENT alone never clears it.
          if (state.header?.action === 'SPEAK' && question) this.ledger.markQuestionResolved();
        }
        void accepted.completed.then(settlement => this.finish(state, settlement)).catch(() => this.fail(state, 'DELIVERY_STATE_ERROR'));
        return { accepted: true };
      } catch (error) {
        if (!state.canceled && epoch === this.epoch && !this.closed) this.fail(state, error instanceof Error ? error.message : 'MODEL_TRANSPORT');
        if (this.active === state) this.active = undefined;
        return { accepted: false };
      }
    }).finally(() => { this.queued--; });
    this.queue = work.catch(() => {});
    return work;
  }

  private onModelEvent(state: Active, event: ChatEvent): void {
    if (state.epoch !== this.epoch || state.canceled || state.finished || this.closed) return;
    if (event.type === 'error') { this.fail(state, event.code); return; }
    if (event.type === 'usage') { this.counts.usageEvents++; this.emit({ type: 'usage', usage: event.usage }); return; }
    if (event.type === 'attempt-start') {
      this.counts.modelAttempts++;
      if (state.attemptId && state.attemptId !== event.attemptId) this.abandon(state);
      state.attemptId = event.attemptId; state.parser = new DecisionStream(12000); state.header = undefined;
      return;
    }
    if (event.type === 'text') {
      if (event.attemptId !== state.attemptId || !state.parser || state.failure) return;
      this.consume(state, state.parser.push(event.text));
    } else if (event.type === 'attempt-end') {
      if (event.attemptId !== state.attemptId) return;
      if (event.outcome === 'abandoned') this.abandon(state);
      else if (state.parser) this.consume(state, state.parser.finish());
    }
  }

  private consume(state: Active, events: ReturnType<DecisionStream['push']>): void {
    for (const event of events) {
      if (state.failure || state.canceled || !state.attemptId) return;
      if (event.type === 'error') { this.counts.protocolErrors++; this.fail(state, 'PROTOCOL_FORMAT'); void this.port.cancel().catch(() => {}); return; }
      if (event.type === 'header') {
        state.header = event.header;
        state.attempts.push(state.attemptId);
        this.ledger.startAttempt(state.attemptId, state.id, event.header, state.input.source);
        if (event.header.action === 'SPEAK') this.ledger.markQuestionResolved();
        this.emit({ type: 'decision', turnId: state.id, generationId: state.generation, action: event.header.action, local: false });
        if (event.header.action !== 'SPEAK') {
          this.emit({ type: 'model-state', state: event.header.action === 'WAIT' ? 'waiting' : 'silent' });
          if (event.header.action === 'WAIT') this.beginWait();
        }
      } else if (event.type === 'body') {
        if (state.input.source === 'voice') this.outputAttempt = state;
        this.ledger.appendGenerated(state.attemptId, event.text);
        this.emit({ type: 'assistant-delta', turnId: state.id, attemptId: state.attemptId, generationId: state.generation, text: event.text, source: state.input.source });
      } else this.ledger.noteViolation(state.attemptId, event.reason);
    }
  }

  private abandon(state: Active): void {
    if (state.attemptId && state.attempts.includes(state.attemptId)) this.ledger.interrupt(state.attemptId);
    this.emit({ type: 'assistant-state', turnId: state.id, attemptId: state.attemptId, generationId: state.generation, state: 'interrupted' });
    state.generation = ++this.generation;
    this.emit({ type: 'output-clear', generationId: this.generation });
    state.parser = undefined;
  }

  private finish(state: Active, settlement: ChatSettlement): void {
    state.finished = true;
    if (state.epoch !== this.epoch || this.closed) return;
    if (!state.canceled && !state.failure && settlement.status === 'completed') {
      if (!state.header) this.fail(state, 'PROTOCOL_FORMAT');
      else if (state.header.action === 'SPEAK' && state.attemptId) {
        const attempt = this.ledger.snapshot().find(item => item.attemptId === state.attemptId);
        if (!attempt?.generated.trim()) this.fail(state, 'PROTOCOL_EMPTY_BODY');
        else {
          if (state.header.expectsReply) {
            const question = attempt.generated.match(/[^。.!！?？\n]*[?？]\s*$/u)?.[0]?.trim();
            if (question) this.ledger.setQuestionCandidate(state.attemptId, `question-${state.id}`, question,
              state.input.source === 'voice' ? this.finalSegments.get(state.attemptId) : undefined);
          }
          this.emit({ type: 'assistant-state', turnId: state.id, attemptId: state.attemptId, generationId: state.generation, state: 'complete' });
        }
      }
    } else if (!state.canceled && !state.failure) this.fail(state, settlement.code ?? 'MODEL_REQUEST_FAILED');
    if (this.active === state) this.active = undefined;
    if (this.outputAttempt === state && state.attemptId && !cleanSpeech(this.ledger.snapshot().find(item => item.attemptId === state.attemptId)?.unplayed ?? '')) this.outputAttempt = undefined;
    if (!state.failure && !state.canceled && state.header?.action === 'SPEAK') this.emit({ type: 'model-state', state: 'idle' });
  }

  private fail(state: Active, code: string): void {
    if (state.failure) return;
    state.failure = code;
    if (this.outputAttempt === state) this.outputAttempt = undefined;
    for (const attemptId of state.attempts) this.ledger.interrupt(attemptId);
    if (code === 'MISSING_CREDENTIAL' || code.includes('credentials-unavailable')) this.blocked = 'MISSING_CREDENTIAL';
    this.failedInput = { ...state.input, retryOf: state.accepted ? state.id : state.input.retryOf };
    this.emit({ type: 'assistant-state', turnId: state.id, attemptId: state.attemptId, generationId: state.generation, state: 'error' });
    this.emit({ type: 'model-state', state: 'error', code });
    this.emit({ type: 'error', code, message: this.blocked ? '模型账号未配置；请在 dsh 设置中配置后重试。'
      : /^PROTOCOL/.test(code) ? '本轮回复格式异常，可重试。' : '本轮模型请求失败，可重试。', retryable: true });
  }

  async cancel(): Promise<void> {
    if (this.canceling) return this.canceling;
    const state = this.active ?? this.outputAttempt;
    if (!state || state.canceled) return;
    state.canceled = true;
    ++this.generation;
    for (const attemptId of state.attempts) this.ledger.interrupt(attemptId);
    this.emit({ type: 'output-clear', generationId: this.generation });
    this.emit({ type: 'assistant-state', turnId: state.id, attemptId: state.attemptId, generationId: state.generation, state: 'interrupted' });
    this.emit({ type: 'model-state', state: 'cancelling' });
    this.outputAttempt = undefined;
    this.canceling = (state.finished ? Promise.resolve() : this.port.cancel()).then(() => {}).finally(() => {
      if (this.active === state) this.active = undefined;
      this.canceling = undefined;
      if (!this.closed) this.emit({ type: 'model-state', state: 'idle' });
    });
    return this.canceling;
  }

  async retry(): Promise<{ accepted: boolean; local?: string }> {
    const previous = this.failedInput;
    if (!previous) return { accepted: false };
    this.failedInput = undefined;
    this.blocked = undefined;
    return this.submit({ ...previous, isEligible: undefined, onAccepted: undefined });
  }

  async updatePreferences(preferences: DialoguePreferences): Promise<void> {
    await this.cancel();
    this.preferences = { ...preferences };
    this.clearWait();
    this.ledger.markQuestionResolved();
  }

  displayed(attemptId: string, characters: number): void {
    const item = this.ledger.snapshot().find(attempt => attempt.attemptId === attemptId);
    if (!item || !Number.isSafeInteger(characters) || characters < item.displayed.length || characters > item.generated.length) return;
    this.ledger.recordDisplayed(attemptId, item.generated.slice(item.displayed.length, characters));
  }

  recordPlayback(progress: { attemptId: string; generationId: number; segmentId: string; text: string; rawText: string; rawStart: number; rawEnd: number; completed: boolean }): void {
    if (progress.generationId !== this.generation) return;
    const item = this.ledger.snapshot().find(attempt => attempt.attemptId === progress.attemptId);
    if (!item || item.interrupted) return;
    this.ledger.recordMappedPlayback(progress.attemptId, progress, progress.completed);
    if (progress.completed && !cleanSpeech(item.generated.slice(progress.rawEnd)) && this.outputAttempt?.finished) this.outputAttempt = undefined;
  }
  finalSegment(attemptId: string, segmentId: string): void {
    if (!this.ledger.snapshot().some(item => item.attemptId === attemptId && !item.interrupted)) return;
    this.finalSegments.set(attemptId, segmentId);
    if (this.finalSegments.size > 16) this.finalSegments.delete(this.finalSegments.keys().next().value!);
    this.ledger.setFinalSegment(attemptId, segmentId);
  }
  speechFallback(attemptId: string): void {
    if (!this.ledger.snapshot().some(item => item.attemptId === attemptId)) return;
    this.ledger.speechFallback(attemptId);
    if (this.outputAttempt?.attemptId === attemptId) this.outputAttempt = undefined;
  }

  projectHistory(): { history: unknown[]; attempts: unknown[] } {
    // Never include unplayed/generated-only content in the next model request.
    const attempts = this.ledger.snapshot();
    const history: unknown[] = [];
    for (const user of this.userHistory.slice(-10)) {
      history.push(user);
      for (const attempt of attempts.filter(item => item.turnId === user.turnId && item.action === 'SPEAK')) {
        const text = attempt.deliveryMode === 'text' ? attempt.displayed : attempt.fullyPlayedSegments.map(segment => segment.text).join('');
        if (text) history.push({ role: 'assistant', turnId: user.turnId, text, interrupted: attempt.interrupted });
      }
    }
    const compact = attempts.slice(-8).map(attempt => ({ attemptId: attempt.attemptId, turnId: attempt.turnId,
      action: attempt.action, deliveryMode: attempt.deliveryMode, generatedCharacters: attempt.generated.length,
      unplayedCharacters: attempt.unplayed.length, fullyPlayedSegments: attempt.fullyPlayedSegments,
      partiallyPlayedSegment: attempt.partiallyPlayedSegment,
      ...(attempt.deliveryMode === 'text' ? { displayed: attempt.displayed } : {}), interrupted: attempt.interrupted }));
    // Keep a predictable projection budget; previous visible prose is compacted without another LLM.
    const result = { history: history.slice(-12).map(item => {
      const row = item as { text?: string }; return { ...row, text: row.text?.slice(-1200) };
    }), attempts: compact.map(item => ({ ...item, displayed: item.displayed?.slice(-1200),
      fullyPlayedSegments: item.fullyPlayedSegments.slice(-4).map(segment => ({ ...segment, text: segment.text.slice(-500) })) })) };
    while (JSON.stringify(result).length > 9000 && result.history.length) result.history.shift();
    while (JSON.stringify(result).length > 9000 && result.attempts.length) result.attempts.shift();
    return result;
  }

  async close(): Promise<void> {
    this.closed = true; this.epoch++;
    this.clearWait();
    await this.cancel();
    this.userHistory = [];
    this.failedInput = undefined;
    this.ledger.markQuestionResolved();
  }

  private beginWait(): void {
    this.clearWait();
    this.waitExpiresAt = Date.now() + 10000;
    this.waitTimer = setTimeout(() => this.tick(), 10000);
    this.waitTimer.unref?.();
  }
  private clearWait(): void {
    clearTimeout(this.waitTimer);
    this.waitTimer = undefined; this.waitExpiresAt = 0;
  }
  /** Local expiry only: no request, retry or spoken prompt is scheduled. */
  tick(now = Date.now()): void {
    if (this.waitExpiresAt && now >= this.waitExpiresAt) {
      this.clearWait(); this.emit({ type: 'model-state', state: 'idle' });
    }
    this.ledger.expirePendingQuestion(now, 120000);
  }
}
