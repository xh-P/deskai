import type { DecisionHeader } from './decision.ts';

export type DeliveryMode = 'voice' | 'text';
export type PendingQuestion = { questionId: string; turnId: string; text: string; presentedAt: number; status: 'awaiting' | 'stale' };
export type DeliveryAttempt = {
  attemptId: string; turnId: string; action: DecisionHeader['action']; deliveryMode: DeliveryMode; generated: string;
  displayed: string; fullyPlayedSegments: { segmentId: string; text: string; rawStart?: number; rawEnd?: number }[];
  partiallyPlayedSegment?: { segmentId: string; text: string };
  unplayed: string; interrupted: boolean; protocolViolations: string[];
};
type Candidate = { questionId: string; text: string; segmentId?: string };
type MutableAttempt = DeliveryAttempt & { mode: DeliveryMode; expectsReply: boolean; candidate?: Candidate };

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

  startAttempt(attemptId: string, turnId: string, header: DecisionHeader, mode: DeliveryMode): void {
    if (!attemptId || !turnId || this.attempts.has(attemptId)) throw new Error('invalid or duplicate attempt');
    if (this.attempts.size >= this.maxAttempts) this.attempts.delete(this.attempts.keys().next().value!);
    this.attempts.set(attemptId, { attemptId, turnId, action: header.action, deliveryMode: mode, mode, expectsReply: header.expectsReply, generated: '', displayed: '',
      fullyPlayedSegments: [], unplayed: '', interrupted: false, protocolViolations: [] });
  }

  appendGenerated(attemptId: string, text: string): void {
    const item = this.get(attemptId);
    if (item.action !== 'SPEAK') throw new Error('body forbidden for WAIT/SILENT');
    if (item.interrupted) throw new Error('attempt interrupted');
    if (item.generated.length + text.length > this.maxText) throw new RangeError('generated text limit');
    item.generated += text;
    this.recomputeUnplayed(item);
  }

  recordDisplayed(attemptId: string, text: string, at = Date.now()): void {
    const item = this.get(attemptId);
    if (item.action !== 'SPEAK' || !item.generated.startsWith(item.displayed + text)) throw new Error('display must follow generated prefix');
    item.displayed += text;
    this.recomputeUnplayed(item);
    if (item.mode === 'text') this.maybePresent(item, at);
  }

  recordFullyPlayed(attemptId: string, segmentId: string, text: string, at = Date.now()): void {
    const item = this.get(attemptId);
    if (item.mode !== 'voice' || item.action !== 'SPEAK' || item.interrupted) throw new Error('not a playable voice attempt');
    if (!segmentId || item.fullyPlayedSegments.some(s => s.segmentId === segmentId)) throw new Error('duplicate segment');
    const heard = item.fullyPlayedSegments.map(s => s.text).join('');
    if (!item.generated.startsWith(heard + text)) throw new Error('playback must follow generated prefix');
    item.fullyPlayedSegments.push({ segmentId, text });
    item.partiallyPlayedSegment = undefined;
    this.recomputeUnplayed(item);
    this.maybePresent(item, at);
  }

  recordPartiallyPlayed(attemptId: string, segmentId: string, text: string): void {
    const item = this.get(attemptId);
    if (item.mode !== 'voice' || item.action !== 'SPEAK' || item.interrupted) throw new Error('not a playable voice attempt');
    const heard = item.fullyPlayedSegments.map(s => s.text).join('');
    if (!segmentId || !item.generated.startsWith(heard + text)) throw new Error('partial playback must follow generated prefix');
    item.partiallyPlayedSegment = { segmentId, text };
    this.recomputeUnplayed(item);
  }

  /** Source offsets, rather than cleaned character counts, reconcile the generated reply. */
  recordMappedPlayback(attemptId: string, segment: { segmentId: string; text: string; rawText: string; rawStart: number; rawEnd: number }, completed: boolean, at = Date.now()): void {
    const item = this.get(attemptId);
    if (item.mode !== 'voice' || item.action !== 'SPEAK' || item.interrupted) return;
    if (item.fullyPlayedSegments.some(s => s.segmentId === segment.segmentId)) return;
    const previous = item.fullyPlayedSegments.at(-1);
    const consumed = previous?.rawEnd ?? item.fullyPlayedSegments.reduce((n, s) => n + s.text.length, 0);
    if (segment.rawStart < consumed || segment.rawEnd <= segment.rawStart || segment.rawEnd > item.generated.length
      || item.generated.slice(segment.rawStart, segment.rawEnd) !== segment.rawText) throw new Error('invalid speech source span');
    if (completed) {
      item.fullyPlayedSegments.push({ segmentId: segment.segmentId, text: segment.text, rawStart: segment.rawStart, rawEnd: segment.rawEnd });
      item.partiallyPlayedSegment = undefined;
      this.maybePresent(item, at);
    } else item.partiallyPlayedSegment = { segmentId: segment.segmentId, text: '' };
    this.recomputeUnplayed(item);
  }

  setFinalSegment(attemptId: string, segmentId: string): void {
    const item = this.get(attemptId);
    if (item.candidate && !item.interrupted) { item.candidate.segmentId = segmentId; this.maybePresent(item, Date.now()); }
  }
  speechFallback(attemptId: string): void {
    const item = this.get(attemptId);
    item.mode = 'text'; item.deliveryMode = 'text'; item.candidate = undefined;
    this.recomputeUnplayed(item);
  }

  setQuestionCandidate(attemptId: string, questionId: string, text: string, segmentId?: string, at = Date.now()): void {
    const item = this.get(attemptId);
    if (item.action !== 'SPEAK' || !item.expectsReply || !questionId || !text || !item.generated.trimEnd().endsWith(text.trimEnd())) throw new Error('declared question must end generated reply');
    item.candidate = { questionId, text, segmentId };
    this.maybePresent(item, at);
  }

  interrupt(attemptId: string): void { this.get(attemptId).interrupted = true; }
  noteViolation(attemptId: string, reason: string): void { const item = this.get(attemptId); if (item.protocolViolations.length < 8) item.protocolViolations.push(reason.slice(0, 200)); }
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
    action: item.action, deliveryMode: item.deliveryMode, generated: item.generated, displayed: item.displayed,
    fullyPlayedSegments: item.fullyPlayedSegments.map(s => ({ ...s })),
    ...(item.partiallyPlayedSegment ? { partiallyPlayedSegment: { ...item.partiallyPlayedSegment } } : {}),
    unplayed: item.unplayed, interrupted: item.interrupted, protocolViolations: [...item.protocolViolations] })); }
  runtimeState(): { deliveryState: DeliveryAttempt[]; pendingQuestion?: PendingQuestion } {
    return { deliveryState: this.snapshot(), ...(this.pending ? { pendingQuestion: { ...this.pending } } : {}) };
  }

  private get(id: string): MutableAttempt { const item = this.attempts.get(id); if (!item) throw new Error('unknown attempt'); return item; }
  private recomputeUnplayed(item: MutableAttempt): void {
    const heardLength = (item.fullyPlayedSegments.at(-1)?.rawEnd ?? item.fullyPlayedSegments.reduce((n, s) => n + s.text.length, 0)) + (item.partiallyPlayedSegment?.text.length ?? 0);
    item.unplayed = item.mode === 'voice' ? item.generated.slice(heardLength) : item.generated.slice(item.displayed.length);
  }
  private maybePresent(item: MutableAttempt, at: number): void {
    const candidate = item.candidate;
    if (!candidate) return;
    const presented = item.mode === 'text' ? item.displayed.trimEnd().endsWith(candidate.text.trimEnd())
      : !!candidate.segmentId && item.fullyPlayedSegments.at(-1)?.segmentId === candidate.segmentId
        && item.fullyPlayedSegments.map(s => s.text).join('').trimEnd().endsWith(candidate.text.trimEnd());
    if (presented) { this.pending = { questionId: candidate.questionId, turnId: item.turnId, text: candidate.text, presentedAt: at, status: 'awaiting' }; item.candidate = undefined; }
  }
}
