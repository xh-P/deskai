import type { Segment } from './index.ts';

const RATE = 16000;

/** Owns the only replaceable acoustic interval. Candidate ASR is speculative;
 * publication freezes it. Text is never used to repair/overlap-deduplicate PCM.
 * At most one max-sized snapshot is retained, in addition to the ASR queue. */
export class InputEndpoint {
  readonly candidateSamples: number;
  readonly commitSamples: number;
  readonly unfinishedSamples: number;
  private tail?: Segment;

  constructor(continuationWindowMs = 600, candidateWindowMs = 600, unfinishedWindowMs = 1200) {
    if (![continuationWindowMs, candidateWindowMs, unfinishedWindowMs].every(value => Number.isFinite(value) && value > 0 && value <= 3000) || candidateWindowMs > continuationWindowMs || unfinishedWindowMs < continuationWindowMs) {
      throw new RangeError('invalid endpoint windows');
    }
    this.candidateSamples = Math.ceil(candidateWindowMs * RATE / 1000);
    this.commitSamples = Math.ceil(continuationWindowMs * RATE / 1000);
    this.unfinishedSamples = Math.ceil(unfinishedWindowMs * RATE / 1000);
  }

  remember(segment: Segment): void { this.tail = segment; }

  /** Returns the exact previous PCM only while no ready/accepted caller can
   * own it, and only if all samples since the snapshot are still available. */
  reopen(sampleStart: number, lastSpeechEnd: number, preRollLength: number,
    canReplace: (segment: Segment) => boolean): Segment | undefined {
    const tail = this.tail;
    this.tail = undefined;
    if (tail && sampleStart - lastSpeechEnd < this.commitSamples &&
      sampleStart - tail.endSample === preRollLength && canReplace(tail)) return tail;
    return undefined;
  }

  waiting(cursor: number, lastSpeechEnd: number, unfinished = false): boolean {
    return cursor - lastSpeechEnd < (unfinished ? this.unfinishedSamples : this.commitSamples);
  }

  seal(): void { this.tail = undefined; }
  discard(ids: number[]): void { if (this.tail && ids.includes(this.tail.utteranceId)) this.seal(); }
}
