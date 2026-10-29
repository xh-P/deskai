import type { Segment } from './index.ts';

const RATE = 16000;

/** Owns the only replaceable acoustic interval. Candidate ASR is speculative;
 * publication freezes it. Text is never used to repair/overlap-deduplicate PCM.
 * At most one max-sized snapshot is retained, in addition to the ASR queue. */
export class InputEndpoint {
  readonly candidateSamples = 9600;
  readonly commitSamples: number;
  readonly unfinishedSamples: number;
  private tail?: Segment;

  constructor(continuationWindowMs = 600) {
    if (!Number.isFinite(continuationWindowMs) || continuationWindowMs < 600 || continuationWindowMs > 3000) {
      throw new RangeError('continuationWindowMs must be between 600 and 3000');
    }
    this.commitSamples = Math.ceil(continuationWindowMs * RATE / 1000);
    this.unfinishedSamples = Math.max(this.commitSamples, 19200);
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
