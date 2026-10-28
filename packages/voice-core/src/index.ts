export { StreamingResampler } from './resample.ts';
export { encodePcm16Wav } from './wav.ts';

export type Segment = { sessionId: string; utteranceId: number; inputRevision: number; startSample: number; endSample: number; samples: Float32Array; final: boolean };
export type InputState = 'OFF' | 'LISTENING' | 'CAPTURING' | 'TRANSCRIBING' | 'ACCUMULATING';
export type Ready = { sessionId: string; inputRevision: number; utteranceIds: number[]; text: string; continuationOf?: number };
export type Boundary = { type: 'ready' | 'revoked' | 'overflow' | 'discarded'; sessionId: string; inputRevision: number; utteranceIds: number[]; reason?: string };
export type Interruption = { type: 'candidate' | 'confirmed' | 'resume'; generationId: number; reason: string };
export type InputOptions = {
  transcribe?: (segment: Segment, signal: AbortSignal) => Promise<string>;
  onSegment?: (segment: Segment) => void;
  onInputState?: (state: InputState) => void;
  onInterruption?: (event: Interruption) => void;
  onBoundary?: (event: Boundary) => void;
  onReady?: (ready: Ready) => void;
  onError?: (error: unknown) => void;
  sampleRate?: 16000;
  maxSegmentSeconds?: number;
  maxQueuedSegments?: number;
  vadThreshold?: number;
};

const RATE = 16000;
const PREROLL = 4000;
const END_SILENCE = 9600;
const CANDIDATE = 3200;
const CONFIRM = 12800;
const UNFINISHED_WAIT = 19200;

function join(chunks: Float32Array[]): Float32Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return merged;
}

function unfinished(text: string): boolean {
  const value = text.trim();
  if (/[?？!！]$/u.test(value)) return false;
  // SenseVoice supplies punctuation, including periods after an unfinished
  // condition. A generated full stop is not reliable evidence of completion.
  const clauses = value.replace(/[\s,.，、…。.．]+$/u, '').split(/[,.。!?！？;；，、]/u);
  const tail = clauses.at(-1)?.trim() ?? '';
  if (/(?:那个|我想一下|让我想想|我还没说完|然后|的话|けど|けれど|ので|なら|たら)$/u.test(tail)) return true;
  if (/(?:吗|呢|就这样|就好了)$/u.test(tail)) return false;
  return /^(?:如果|要是|假如|因为|虽然|if\b|because\b|although\b|when\b|もし|だから)/iu.test(tail)
    && !/(?:就|那么|因此|所以|then\b)/iu.test(tail);
}

export function classifyLocalText(text: string, output: { playing: boolean; expectsReply: boolean }): 'stop' | 'backchannel' | 'forward' | 'empty' {
  const normalized = text.trim().replace(/[。！!，,、.\s]+$/u, '').toLocaleLowerCase();
  if (!normalized || /^[\p{P}\p{S}\s]*$/u.test(normalized)) return 'empty';
  if (/^(?:停一下|别说了|先别说了|停止播放|stop|stop speaking|ちょっと止めて|止めて|やめて)$/u.test(normalized)) return 'stop';
  if (output.playing && /^(?:不要停[，,\s]*接着说|まだ止めないで[、，,\s]*続けて|don(?:'|’)t stop[;,，\s]*keep going)$/u.test(normalized)) return 'backchannel';
  if (output.playing && !output.expectsReply && /^(?:嗯|嗯嗯|唔|哦|啊|uh-huh|mm-hm|mm-hmm|mhm|うん|へえ)$/u.test(normalized)) return 'backchannel';
  return 'forward';
}

export class InputController {
  private readonly options: InputOptions;
  private sessionId = '';
  private epoch = 0;
  private state: InputState = 'OFF';
  private cursor = 0;
  private revision = 0;
  private nextUtterance = 1;
  private lastSubmittedUtterance = 0;
  private continuationForRevision = 0;
  private preRoll: Float32Array[] = [];
  private preRollLength = 0;
  private active: Float32Array[] = [];
  private capturing = false;
  private activeLength = 0;
  private activeStart = 0;
  private lastSegmentEnd = 0;
  private silence = 0;
  private speechRun = 0;
  private lastSpeechEnd = 0;
  private pending = new Map<number, { text?: string; failed?: boolean }>();
  private hasGap = false;
  private queue: Segment[] = [];
  private working = false;
  private abortController = new AbortController();
  private readyRevision = -1;
  private output = { generationId: 0, playing: false, expectsReply: false };
  private interrupt: 'none' | 'candidate' | 'confirmed' = 'none';
  private readonly maxSamples: number;
  private readonly maxQueue: number;
  private readonly threshold: number;

  constructor(options: InputOptions = {}) {
    this.options = options;
    if (options.sampleRate && options.sampleRate !== RATE) throw new RangeError('InputController requires 16 kHz mono');
    this.maxSamples = Math.floor(Math.min(20, options.maxSegmentSeconds ?? 20) * RATE);
    if (this.maxSamples < RATE) throw new RangeError('maxSegmentSeconds must be at least one second');
    this.maxQueue = Math.max(1, Math.floor(options.maxQueuedSegments ?? 8));
    this.threshold = options.vadThreshold ?? 0.5;
  }

  start(sessionId: string): void {
    if (!sessionId) throw new Error('sessionId required');
    this.stop();
    this.sessionId = sessionId;
    this.cursor = this.revision = this.lastSegmentEnd = this.lastSpeechEnd = 0;
    this.nextUtterance = 1;
    this.lastSubmittedUtterance = 0;
    this.continuationForRevision = 0;
    this.pending.clear();
    this.hasGap = false;
    this.preRoll = []; this.preRollLength = 0;
    this.abortController = new AbortController();
    this.setState('LISTENING');
  }

  stop(): void {
    this.epoch++;
    this.abortController.abort();
    this.queue = [];
    this.active = []; this.activeLength = this.silence = this.speechRun = 0;
    this.preRoll = []; this.preRollLength = 0;
    this.capturing = false;
    this.pending.clear();
    this.hasGap = false;
    this.readyRevision = -1;
    this.interrupt = 'none';
    this.output = { ...this.output, playing: false, expectsReply: false };
    this.sessionId = '';
    this.setState('OFF');
  }

  setOutput(output: { generationId: number; playing: boolean; expectsReply: boolean }): void {
    if (output.generationId !== this.output.generationId) this.interrupt = 'none';
    this.output = { ...output };
  }

  pushFrame(frame: { samples: Float32Array; probability: number; sampleStart?: number }): void {
    if (!this.sessionId || !frame.samples.length) return;
    if (frame.samples.length > RATE) throw new RangeError('input frame exceeds one second');
    if (frame.sampleStart !== undefined && frame.sampleStart !== this.cursor) throw new RangeError('noncontiguous input samples');
    if (!Number.isFinite(frame.probability) || frame.probability < 0 || frame.probability > 1) throw new RangeError('invalid VAD probability');
    const samples = frame.samples.slice();
    const start = this.cursor;
    this.cursor += samples.length;
    const voiced = frame.probability >= this.threshold;
    if (!this.capturing && voiced) this.begin(start);
    if (this.capturing) {
      this.active.push(samples);
      this.activeLength += samples.length;
      if (voiced) {
        this.silence = 0;
        this.speechRun += samples.length;
        this.lastSpeechEnd = this.cursor;
        this.maybeInterrupt();
      } else {
        this.silence += samples.length;
        this.speechRun = 0;
      }
      if (this.activeLength >= this.maxSamples) this.emitSegment(false);
      else if (this.silence >= END_SILENCE) {
        this.emitSegment(true);
        if (this.interrupt === 'candidate' && !this.options.transcribe) this.resumeIfFalseAlarm();
      }
    } else this.addPreRoll(samples);
    this.maybeReady();
  }

  private begin(sampleStart: number): void {
    this.revokeReady('new onset');
    this.revision++;
    this.continuationForRevision = this.lastSubmittedUtterance && sampleStart - this.lastSpeechEnd <= UNFINISHED_WAIT
      ? this.lastSubmittedUtterance : 0;
    this.activeStart = Math.max(this.lastSegmentEnd, sampleStart - this.preRollLength);
    this.active = this.preRoll;
    this.capturing = true;
    this.activeLength = this.preRollLength;
    this.preRoll = []; this.preRollLength = 0;
    this.silence = this.speechRun = 0;
    this.setState('CAPTURING');
  }

  private addPreRoll(samples: Float32Array): void {
    this.preRoll.push(samples);
    this.preRollLength += samples.length;
    while (this.preRollLength > PREROLL) {
      const first = this.preRoll[0];
      const excess = this.preRollLength - PREROLL;
      if (first.length <= excess) { this.preRoll.shift(); this.preRollLength -= first.length; }
      else { this.preRoll[0] = first.slice(excess); this.preRollLength -= excess; }
    }
  }

  private emitSegment(final: boolean): void {
    if (!this.activeLength) return;
    const all = join(this.active);
    const count = Math.min(all.length, this.maxSamples);
    const segment: Segment = { sessionId: this.sessionId, utteranceId: this.nextUtterance++, inputRevision: this.revision,
      startSample: this.activeStart, endSample: this.activeStart + count, samples: all.slice(0, count), final };
    this.lastSegmentEnd = segment.endSample;
    this.options.onSegment?.(segment);
    if (this.hasGap || this.pending.size >= this.maxQueue || this.queue.length + Number(this.working) >= this.maxQueue) {
      if (!this.hasGap) this.options.onBoundary?.({ type: 'overflow', sessionId: this.sessionId, inputRevision: this.revision, utteranceIds: [segment.utteranceId], reason: 'ASR queue full' });
      this.hasGap = true;
    } else {
      this.pending.set(segment.utteranceId, {});
      this.queue.push(segment);
      this.drain();
    }
    this.active = count < all.length ? [all.slice(count)] : [];
    this.activeLength = all.length - count;
    this.activeStart = segment.endSample;
    if (final) {
      this.active = []; this.activeLength = this.silence = this.speechRun = 0;
      this.capturing = false;
      this.setState(this.working || this.queue.length ? 'TRANSCRIBING' : 'ACCUMULATING');
    }
  }

  private drain(): void {
    if (this.working || !this.queue.length || !this.sessionId) return;
    const segment = this.queue.shift()!;
    const epoch = this.epoch;
    this.working = true;
    const signal = this.abortController.signal;
    Promise.resolve().then(() => this.options.transcribe?.(segment, signal) ?? '').then(text => {
      if (epoch !== this.epoch || signal.aborted) return;
      const record = this.pending.get(segment.utteranceId);
      if (record) record.text = text.trim();
      this.maybeReady();
    }, error => {
      if (epoch !== this.epoch || signal.aborted) return;
      const record = this.pending.get(segment.utteranceId);
      if (record) record.failed = true;
      this.hasGap = true;
      this.options.onError?.(error);
      this.options.onBoundary?.({ type: 'discarded', sessionId: this.sessionId, inputRevision: this.revision, utteranceIds: [segment.utteranceId], reason: 'ASR failure' });
    }).finally(() => {
      this.working = false;
      this.drain();
      if (epoch === this.epoch) {
        this.maybeReady();
        if (!this.capturing) this.setState(this.queue.length || this.working ? 'TRANSCRIBING' : this.pending.size ? 'ACCUMULATING' : 'LISTENING');
      }
    });
  }

  private maybeReady(): void {
    if (!this.sessionId || this.capturing || this.readyRevision === this.revision) return;
    const records = [...this.pending.entries()].sort((a,b) => a[0] - b[0]);
    if (this.hasGap) {
      if (this.working || this.queue.length) return;
      const ids = records.map(([id]) => id);
      this.pending.clear();
      this.hasGap = false;
      this.resumeIfFalseAlarm();
      this.options.onBoundary?.({ type: 'discarded', sessionId: this.sessionId, inputRevision: this.revision, utteranceIds: ids, reason: 'incomplete ASR accumulation' });
      this.setState('LISTENING');
      return;
    }
    if (!records.length || records.some(([, record]) => record.text === undefined && !record.failed)) return;
    if (records.some(([, record]) => record.failed)) return;
    const text = records.map(([, record]) => record.text).filter(Boolean).join(' ').trim();
    if (!text) {
      for (const [id] of records) this.pending.delete(id);
      this.resumeIfFalseAlarm();
      this.options.onBoundary?.({ type: 'discarded', sessionId: this.sessionId, inputRevision: this.revision, utteranceIds: records.map(([id]) => id), reason: 'empty ASR' });
      this.setState('LISTENING');
      return;
    }
    if (unfinished(text) && this.cursor - this.lastSpeechEnd < UNFINISHED_WAIT) return;
    const ids = records.map(([id]) => id);
    const local = classifyLocalText(text, { playing: this.output.playing || this.interrupt === 'candidate', expectsReply: this.output.expectsReply });
    if (local === 'empty') {
      for (const [id] of records) this.pending.delete(id);
      this.resumeIfFalseAlarm();
      this.setState('LISTENING');
      return;
    }
    if (local === 'stop') {
      this.confirmInterruption('stop control');
      for (const [id] of records) this.pending.delete(id);
      this.options.onBoundary?.({ type: 'discarded', sessionId: this.sessionId, inputRevision: this.revision, utteranceIds: ids, reason: 'stop control' });
      this.setState('LISTENING');
      return;
    }
    if (local === 'backchannel') {
      for (const [id] of records) this.pending.delete(id);
      this.resumeIfFalseAlarm();
      this.options.onBoundary?.({ type: 'discarded', sessionId: this.sessionId, inputRevision: this.revision, utteranceIds: ids, reason: 'backchannel' });
      this.setState('LISTENING');
      return;
    }
    if (this.interrupt === 'candidate') this.confirmInterruption('recognized speech');
    this.readyRevision = this.revision;
    this.options.onBoundary?.({ type: 'ready', sessionId: this.sessionId, inputRevision: this.revision, utteranceIds: ids });
    this.options.onReady?.({ sessionId: this.sessionId, inputRevision: this.revision, utteranceIds: ids, text,
      ...(this.continuationForRevision ? { continuationOf: this.continuationForRevision } : {}) });
  }

  isEligible(inputRevision: number, utteranceIds: number[]): boolean {
    const pendingIds = [...this.pending.keys()];
    return !!this.sessionId && inputRevision === this.revision && inputRevision === this.readyRevision && !this.capturing &&
      utteranceIds.length > 0 && utteranceIds.length === pendingIds.length && utteranceIds.every((id, i) => id === pendingIds[i] &&
        this.pending.get(id)?.text !== undefined && !this.pending.get(id)?.failed);
  }

  markSubmitted(utteranceIds: number[]): void {
    if (!this.isEligible(this.revision, utteranceIds)) throw new Error('utterances are not eligible');
    for (const id of utteranceIds) this.pending.delete(id);
    this.lastSubmittedUtterance = Math.max(this.lastSubmittedUtterance, ...utteranceIds);
    this.readyRevision = -1;
    this.setState('LISTENING');
  }

  /** A prompt receipt can arrive after a newer onset. Consume only its exact
   * accepted prefix; do not resend those utterances as part of the next turn. */
  markAccepted(inputRevision: number, utteranceIds: number[]): void {
    const ids = [...this.pending.keys()];
    if (inputRevision > this.revision || utteranceIds.length === 0 ||
      !utteranceIds.every((id, i) => ids[i] === id && this.pending.get(id)?.text !== undefined)) throw new Error('accepted utterance prefix missing');
    for (const id of utteranceIds) this.pending.delete(id);
    this.lastSubmittedUtterance = Math.max(this.lastSubmittedUtterance, ...utteranceIds);
    this.readyRevision = -1;
    if (!this.capturing && !this.working && !this.queue.length) this.setState('LISTENING');
  }

  /** Rejected/offline input is explicitly discarded locally, never called submitted. */
  discardReady(utteranceIds: number[]): void {
    for (const id of utteranceIds) this.pending.delete(id);
    this.readyRevision = -1;
    if (!this.capturing && !this.working && !this.queue.length) this.setState('LISTENING');
  }

  /** Rebuild readiness after an asynchronous receipt consumed an older prefix. */
  reevaluateReady(): void {
    this.readyRevision = -1;
    this.maybeReady();
  }

  private maybeInterrupt(): void {
    if (this.interrupt === 'confirmed' || (!this.output.playing && this.interrupt === 'none')) return;
    if (this.speechRun >= CANDIDATE && this.interrupt === 'none') {
      this.interrupt = 'candidate';
      this.options.onInterruption?.({ type: 'candidate', generationId: this.output.generationId, reason: 'sustained near-end speech' });
    }
    if (this.speechRun >= CONFIRM) this.confirmInterruption('sustained near-end speech');
  }

  confirmInterruption(reason = 'confirmed by coordinator'): void {
    if (this.interrupt === 'confirmed') return;
    this.interrupt = 'confirmed';
    this.options.onInterruption?.({ type: 'confirmed', generationId: this.output.generationId, reason });
  }

  resumeIfFalseAlarm(): void {
    if (this.interrupt !== 'candidate') return;
    this.interrupt = 'none';
    this.options.onInterruption?.({ type: 'resume', generationId: this.output.generationId, reason: 'false alarm or backchannel' });
  }

  private revokeReady(reason: string): void {
    if (this.readyRevision < 0) return;
    const ids = [...this.pending.keys()];
    this.options.onBoundary?.({ type: 'revoked', sessionId: this.sessionId, inputRevision: this.readyRevision, utteranceIds: ids, reason });
    this.readyRevision = -1;
  }

  private setState(state: InputState): void {
    if (state !== this.state) { this.state = state; this.options.onInputState?.(state); }
  }
}

export function createInputController(options: InputOptions = {}): InputController { return new InputController(options); }
