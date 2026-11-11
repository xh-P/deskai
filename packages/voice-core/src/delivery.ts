export type DeliveryMode = 'voice' | 'text';
export type PendingQuestion = { questionId: string; turnId: string; text: string; presentedAt: number; status: 'awaiting' | 'stale' };
export type DeliveryAttempt = {
  attemptId: string; turnId: string; deliveryMode: DeliveryMode; generated: string;
  displayed: string; fullyPlayedSegments: { segmentId: string; text: string; rawStart: number; rawEnd: number }[];
  partiallyPlayedSegment?: { segmentId: string };
  unplayed: string; interrupted: boolean;
};
type Candidate = { questionId: string; text: string; segmentId?: string };
type MutableAttempt = DeliveryAttempt & { expectsReply: boolean; candidate?: Candidate };

/** Separate user-visible and estimated-playback history from the unchanged dsh audit log. */
export class DeliveryLedger {
  private readonly attempts = new Map<string, MutableAttempt>();
  private pending?: PendingQuestion;
  private readonly maxAttempts: number;
  private readonly maxText: number;

  constructor(options: { maxAttempts?: number; maxText?: number } = {}) {
    this.maxAttempts = options.maxAttempts ?? 32;
    this.maxText = options.maxText ?? 32768;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || !Number.isSafeInteger(this.maxText) || this.maxText < 1) throw new RangeError('invalid ledger bounds');
  }

  startAttempt(attemptId: string, turnId: string, deliveryMode: DeliveryMode, expectsReply: boolean): void {
    if (!attemptId || !turnId || this.attempts.has(attemptId)) throw new Error('invalid or duplicate attempt');
    if (this.attempts.size >= this.maxAttempts) this.attempts.delete(this.attempts.keys().next().value!);
    this.attempts.set(attemptId, { attemptId, turnId, deliveryMode, expectsReply, generated: '', displayed: '',
      fullyPlayedSegments: [], unplayed: '', interrupted: false });
  }

  appendGenerated(attemptId: string, text: string): void {
    const item = this.get(attemptId);
    if (item.interrupted) throw new Error('attempt interrupted');
    if (item.generated.length + text.length > this.maxText) throw new RangeError('generated text limit');
    item.generated += text;
    this.recomputeUnplayed(item);
  }

  recordDisplayed(attemptId: string, text: string, at = Date.now()): void {
    const item = this.get(attemptId);
    if (!item.generated.startsWith(item.displayed + text)) throw new Error('display must follow generated prefix');
    item.displayed += text;
    this.recomputeUnplayed(item);
    if (item.deliveryMode === 'text') this.maybePresent(item, at);
  }

  /** Source offsets, rather than cleaned character counts, reconcile the generated reply. */
  recordMappedPlayback(attemptId: string, segment: { segmentId: string; text: string; rawText: string; rawStart: number; rawEnd: number }, completed: boolean, at = Date.now()): void {
    const item = this.get(attemptId);
    if (item.deliveryMode !== 'voice' || item.interrupted) return;
    if (item.fullyPlayedSegments.some(s => s.segmentId === segment.segmentId)) return;
    const consumed = item.fullyPlayedSegments.at(-1)?.rawEnd ?? 0;
    if (segment.rawStart < consumed || segment.rawEnd <= segment.rawStart || segment.rawEnd > item.generated.length
      || item.generated.slice(segment.rawStart, segment.rawEnd) !== segment.rawText) throw new Error('invalid speech source span');
    if (completed) {
      item.fullyPlayedSegments.push({ segmentId: segment.segmentId, text: segment.text, rawStart: segment.rawStart, rawEnd: segment.rawEnd });
      item.partiallyPlayedSegment = undefined;
      this.maybePresent(item, at);
    } else item.partiallyPlayedSegment = { segmentId: segment.segmentId };
    this.recomputeUnplayed(item);
  }

  setFinalSegment(attemptId: string, segmentId: string): void {
    const item = this.get(attemptId);
    if (item.candidate && !item.interrupted) { item.candidate.segmentId = segmentId; this.maybePresent(item, Date.now()); }
  }
  speechFallback(attemptId: string): void {
    const item = this.get(attemptId);
    item.deliveryMode = 'text'; item.candidate = undefined;
    this.recomputeUnplayed(item);
  }

  setQuestionCandidate(attemptId: string, questionId: string, text: string, segmentId?: string, at = Date.now()): void {
    const item = this.get(attemptId);
    if (!item.expectsReply || !questionId || !text || !item.generated.trimEnd().endsWith(text.trimEnd())) throw new Error('declared question must end generated reply');
    item.candidate = { questionId, text, segmentId };
    this.maybePresent(item, at);
  }

  interrupt(attemptId: string): void { this.get(attemptId).interrupted = true; }
  markQuestionResolved(): void {
    this.pending = undefined;
    // A late display/playback acknowledgment for an older question must not
    // resurrect it after an answer, topic change or persona switch.
    for (const item of this.attempts.values()) item.candidate = undefined;
  }
  expirePendingQuestion(now: number, maxAgeMs: number): void {
    if (this.pending?.status === 'awaiting' && now - this.pending.presentedAt >= maxAgeMs) this.pending.status = 'stale';
  }
  getPendingQuestion(): PendingQuestion | undefined { return this.pending ? { ...this.pending } : undefined; }
  snapshot(): DeliveryAttempt[] { return [...this.attempts.values()].map(item => ({ attemptId: item.attemptId, turnId: item.turnId,
    deliveryMode: item.deliveryMode, generated: item.generated, displayed: item.displayed,
    fullyPlayedSegments: item.fullyPlayedSegments.map(s => ({ ...s })),
    ...(item.partiallyPlayedSegment ? { partiallyPlayedSegment: { ...item.partiallyPlayedSegment } } : {}),
    unplayed: item.unplayed, interrupted: item.interrupted })); }

  private get(id: string): MutableAttempt { const item = this.attempts.get(id); if (!item) throw new Error('unknown attempt'); return item; }
  private recomputeUnplayed(item: MutableAttempt): void {
    const delivered = item.deliveryMode === 'voice' ? item.fullyPlayedSegments.at(-1)?.rawEnd ?? 0 : item.displayed.length;
    item.unplayed = item.generated.slice(delivered);
  }
  private maybePresent(item: MutableAttempt, at: number): void {
    const candidate = item.candidate;
    if (!candidate) return;
    const presented = item.deliveryMode === 'text' ? item.displayed.trimEnd().endsWith(candidate.text.trimEnd())
      : !!candidate.segmentId && item.fullyPlayedSegments.at(-1)?.segmentId === candidate.segmentId
        && item.fullyPlayedSegments.map(s => s.text).join('').trimEnd().endsWith(candidate.text.trimEnd());
    if (presented) { this.pending = { questionId: candidate.questionId, turnId: item.turnId, text: candidate.text, presentedAt: at, status: 'awaiting' }; item.candidate = undefined; }
  }
}
