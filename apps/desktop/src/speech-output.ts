import { SentenceStream, type SpeechBoundaries, type SpokenSentence } from '../../../packages/voice-core/src/sentences.ts';
import type { DialogueEvent } from '../../../packages/voice-core/src/dialogue.ts';
import type { LocalTtsService, VoiceSelection } from '../../../packages/tts-adapter/src/index.ts';

type Identity = { sessionId: string; turnId: string; attemptId: string; generationId: number; voiceRevision: number; segmentId: string };
type Selection = VoiceSelection & { language?: 'auto' | 'zh' | 'ja' | 'all_zh' | 'all_ja' | 'en'; speed?: number };
export type SpeechPort = Pick<LocalTtsService, 'synthesize'>;
export type SpeechPlaybackReport = { sessionId: string; generationId: number; turnId?: string; attemptId?: string; voiceRevision?: number; segmentId?: string; chunkSeq?: number;
  queuedSeconds?: number; playing: boolean; paused: boolean; completed?: boolean; chunkAccepted?: boolean;
  segmentStarted?: boolean; segmentCompleted?: boolean; errorCode?: string };
export type SpeechProgress = SpokenSentence & { turnId: string; attemptId: string; generationId: number; segmentId: string; completed: boolean };
export type SpeechOutputEvent =
  | (Identity & { type: 'audio-chunk'; samples: Float32Array; sampleRate: number; channels: 1; format: 'pcm_f32'; chunkSeq: number; segmentFinal: boolean; final: boolean })
  | (Identity & { type: 'audio-discard' })
  | { type: 'output-command'; sessionId: string; command: 'clear' | 'pause' | 'resume'; generationId: number }
  | { type: 'speech-state'; sessionId: string; state: 'idle' | 'buffering' | 'playing' | 'paused' | 'error'; code?: string };
type Segment = SpokenSentence & Identity & { chunks: Float32Array[]; tail: Float32Array; rate: number; samples: number; complete: boolean; sent: number; received: Set<number> };
type PhraseWait = { until: number; expired: boolean; timer: ReturnType<typeof setTimeout> };
type Attempt = { turnId: string; attemptId: string; generationId: number; stream: SentenceStream; ended: boolean; serial: number;
  lastId?: string; finalReported: boolean; wait?: PhraseWait; failure?: string };
type Language = ReturnType<typeof synthesisLanguage>;
type Options = { sessionId: string; selection: Selection; port: SpeechPort; emit: (event: SpeechOutputEvent) => void;
  onSegment?: (progress: SpeechProgress) => void; onFinalSegment?: (attemptId: string, segmentId: string) => void;
  onError?: (code: string, attemptId?: string) => void };

const tailSeconds = 0.020;
// Leave time for playback reporting and the handoff of the first PCM block.
const synthesisReserveSeconds = 0.100;

function synthesisLanguage(text: string, language: Selection['language']) {
  if (language === 'zh' || language === 'all_zh') return 'all_zh';
  if (language === 'ja' || language === 'all_ja') return 'all_ja';
  if (language === 'en') return 'en';
  return /[\u3040-\u30ff]/u.test(text) ? 'all_ja' : /\p{Script=Han}/u.test(text) ? 'all_zh' : 'en';
}

/** One CUDA request, two bounded phrases, and <=3s acknowledged renderer lookahead. */
export class SpeechOutput {
  private selection: Selection;
  private attempt?: Attempt;
  private generation = 0;
  private segments: Segment[] = [];
  private running?: { controller: AbortController; settled: Promise<void> };
  private awaiting?: { segmentId: string; chunkSeq: number };
  private paused = false;
  private queuedSeconds = 0;
  private queueObservedAt = 0;
  private firstAudioTimings = new Map<Language, { characters: number; seconds: number }>();
  private closed = false;
  private sources = new Map<string, 'voice' | 'text'>();
  private invalidated = new Set<string>();
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
    this.selection = { ...options.selection };
  }

  setSelection(selection: Selection): void {
    const voiceChanged = selection.voiceRevision !== this.selection.voiceRevision || selection.voiceId !== this.selection.voiceId ||
      selection.referenceId !== this.selection.referenceId;
    if (voiceChanged) this.clear(this.generation);
    if (voiceChanged || selection.speed !== this.selection.speed) this.firstAudioTimings.clear();
    this.selection = { ...selection };
  }
  handle(event: DialogueEvent): void {
    if (this.closed) return;
    if (event.type === 'user') {
      this.sources.set(event.turnId, event.source);
      if (this.sources.size > 24) this.sources.delete(this.sources.keys().next().value!);
    } else if (event.type === 'output-clear') this.clear(event.generationId);
    else if (event.type === 'assistant-delta') {
      if (event.source === 'text' || this.sources.get(event.turnId) === 'text' || event.generationId < this.generation || this.invalidated.has(event.attemptId)) return;
      if (event.generationId > this.generation || this.attempt?.attemptId !== event.attemptId) {
        this.clear(event.generationId);
        this.attempt = { turnId: event.turnId, attemptId: event.attemptId, generationId: event.generationId,
          stream: new SentenceStream(), ended: false, serial: 0, finalReported: false };
        this.state('buffering');
      }
      if (this.attempt!.failure) return;
      try { this.attempt!.stream.append(event.text); this.schedule(); }
      catch { this.fail('TTS_TEXT_LIMIT'); }
    } else if (event.type === 'assistant-state' && this.attempt && event.attemptId === this.attempt.attemptId) {
      if (event.state === 'complete') { this.attempt.ended = true; this.attempt.stream.finish(); this.schedule(); }
      else this.clear(this.generation);
    }
  }
  command(command: 'pause' | 'resume' | 'clear', generationId = this.generation): void {
    if (command === 'clear') { this.clear(generationId); return; }
    if (generationId !== this.generation) return;
    const now = performance.now();
    this.queuedSeconds = this.playbackCover(now);
    this.queueObservedAt = now;
    this.paused = command === 'pause';
    this.options.emit({ type: 'output-command', sessionId: this.options.sessionId, generationId, command });
    this.state(this.paused ? 'paused' : 'buffering');
    if (!this.paused) { this.pump(); this.schedule(); }
  }
  playback(report: SpeechPlaybackReport): void {
    if (this.closed || report.sessionId !== this.options.sessionId || report.generationId !== this.generation) return;
    const segment = this.segments.find(item => item.segmentId === report.segmentId && item.attemptId === report.attemptId
      && item.turnId === report.turnId && item.voiceRevision === report.voiceRevision);
    if (report.errorCode && (segment || !report.segmentId)) { this.fail(report.errorCode); return; }
    // Clear/fixture acknowledgments carry no sentence identity and cannot deliver prose.
    if (!segment) return;
    const accepted = report.chunkAccepted && this.awaiting?.segmentId === segment.segmentId && this.awaiting.chunkSeq === report.chunkSeq;
    if (report.chunkAccepted && !accepted && !report.segmentCompleted) return;
    if (Number.isFinite(report.queuedSeconds)) {
      this.queuedSeconds = Math.max(0, Math.min(6, report.queuedSeconds!));
      this.queueObservedAt = performance.now();
    }
    if (accepted) this.awaiting = undefined;
    if (report.segmentCompleted && segment.complete && segment.sent === segment.chunks.length && report.chunkSeq === segment.chunks.length - 1) {
      this.progress(segment, true);
      this.segments = this.segments.filter(item => item !== segment);
    } else if (!this.paused && report.playing && report.segmentStarted) this.progress(segment, false);
    this.state(this.paused || report.paused ? 'paused' : report.playing ? 'playing' : 'buffering');
    this.pump(); this.schedule();
  }
  private schedule(): void {
    const attempt = this.attempt;
    if (!attempt || this.closed) return;
    if (attempt.failure) {
      if (!this.segments.length) {
        this.invalidateAttempt();
        this.reportFailure(attempt.failure, attempt.attemptId);
      }
      return;
    }
    if (this.paused || this.running || this.segments.length >= 2 || this.queuedSeconds > 3) return;
    const sentence = this.nextPhrase(attempt);
    if (!sentence) {
      if (attempt.ended && attempt.lastId && !attempt.finalReported) {
        attempt.finalReported = true; this.options.onFinalSegment?.(attempt.attemptId, attempt.lastId);
      }
      if (attempt.ended && !this.segments.length) this.state('idle');
      return;
    }
    const segment: Segment = { ...sentence, sessionId: this.options.sessionId, turnId: attempt.turnId, attemptId: attempt.attemptId,
      generationId: attempt.generationId, voiceRevision: this.selection.voiceRevision, segmentId: `${attempt.attemptId}-s${++attempt.serial}`,
      chunks: [], tail: new Float32Array(0), rate: 0, samples: 0, complete: false, sent: 0, received: new Set() };
    attempt.lastId = segment.segmentId;
    this.segments.push(segment);
    const controller = new AbortController();
    const selection = { ...this.selection };
    this.state('buffering');
    const language = synthesisLanguage(sentence.text, selection.language);
    if ((!selection.language || selection.language === 'auto') && /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hangul}]/u.test(sentence.text)) {
      this.synthesisFailed(attempt, segment, 'UNSUPPORTED_SPEECH_LANGUAGE'); return;
    }
    const startedAt = performance.now();
    let firstAudioSeconds: number | undefined;
    const settled = Promise.resolve().then(() => { if (controller.signal.aborted) return;
      return this.options.port.synthesize({ sessionId: segment.sessionId, turnId: segment.turnId, generationId: segment.generationId,
      voiceRevision: segment.voiceRevision, segmentId: segment.segmentId, voiceId: selection.voiceId, referenceId: selection.referenceId,
      text: segment.text, language, speed: selection.speed }, pcm => {
      if (controller.signal.aborted || this.attempt !== attempt || segment.complete) return;
      if (segment.received.has(pcm.chunkSeq)) return;
      if (!Number.isSafeInteger(pcm.chunkSeq) || pcm.chunkSeq !== segment.received.size || pcm.channels !== 1
        || !Number.isInteger(pcm.sampleRate) || pcm.sampleRate < 8000 || pcm.sampleRate > 192000 || pcm.pcm.length % 2
        || (segment.rate && segment.rate !== pcm.sampleRate)) throw new Error('TTS_PCM_FORMAT');
      segment.received.add(pcm.chunkSeq); segment.rate = pcm.sampleRate;
      const view = new DataView(pcm.pcm.buffer, pcm.pcm.byteOffset, pcm.pcm.byteLength);
      segment.samples += view.byteLength / 2;
      if (segment.samples > segment.rate * 30) throw new Error('TTS_AUDIO_LIMIT');
      this.appendPcm(segment, view);
      if (segment.chunks.length) firstAudioSeconds ??= (performance.now() - startedAt) / 1000;
      this.pump();
    }, controller.signal); }).then(result => {
      if (controller.signal.aborted || this.attempt !== attempt) return;
      if (result?.canceled) throw new Error('TTS_CANCELED');
      if (!segment.samples) throw new Error('TTS_EMPTY_AUDIO');
      if (selection.speed === this.selection.speed) {
        const seconds = firstAudioSeconds ?? (performance.now() - startedAt) / 1000;
        this.firstAudioTimings.set(language, { characters: sentence.text.length, seconds });
      }
      segment.chunks.push(segment.tail);
      segment.complete = true;
    }).catch(error => {
      if (controller.signal.aborted || this.attempt !== attempt) return;
      controller.abort();
      this.synthesisFailed(attempt, segment, error instanceof Error ? error.message : 'TTS_FAILED');
    })
      .finally(() => { this.running = undefined; this.pump(); this.schedule(); });
    this.running = { controller, settled };
  }
  private nextPhrase(attempt: Attempt): SpokenSentence | undefined {
    const select = attempt.serial ? (bounds: SpeechBoundaries) => this.laterPhrase(attempt, bounds) : undefined;
    let phrase: SpokenSentence | undefined;
    do {
      phrase = attempt.stream.next(select);
      if (phrase) {
        clearTimeout(attempt.wait?.timer);
        attempt.wait = undefined;
      }
    } while (phrase && !phrase.text);
    return phrase;
  }
  private laterPhrase(attempt: Attempt, { sentence, clause }: SpeechBoundaries): SpokenSentence | undefined {
    if (!clause || (sentence && !attempt.wait)) return sentence;
    const now = performance.now();
    const budget = this.playbackCover(now) - synthesisReserveSeconds;
    const clauseCost = this.firstAudioEstimate(clause);
    if (sentence) return this.firstAudioEstimate(sentence) <= Math.max(budget, clauseCost) ? sentence : clause;
    const spare = budget - clauseCost;
    if (spare <= 0 || attempt.wait?.expired) return clause;
    const until = now + spare * 1000;
    if (!attempt.wait || until < attempt.wait.until) {
      clearTimeout(attempt.wait?.timer);
      const timer = setTimeout(() => {
        attempt.wait!.expired = true;
        this.schedule();
      }, Math.ceil(until - now));
      attempt.wait = { until, timer, expired: false };
    }
  }
  private playbackCover(now: number): number {
    const elapsed = this.paused ? 0 : (now - this.queueObservedAt) / 1000;
    return Math.max(0, this.queuedSeconds - elapsed);
  }
  private firstAudioEstimate(phrase: SpokenSentence): number {
    const timing = this.firstAudioTimings.get(synthesisLanguage(phrase.text, this.selection.language));
    return timing ? timing.seconds * Math.max(1, phrase.text.length / timing.characters) : Infinity;
  }
  private appendPcm(segment: Segment, pcm: DataView): void {
    const previous = segment.tail.length;
    const floats = new Float32Array(previous + pcm.byteLength / 2);
    floats.set(segment.tail);
    for (let i = previous; i < floats.length; i++) floats[i] = pcm.getInt16((i - previous) * 2, true) / 32768;
    // Release the speech body immediately and retain a short block for the end marker.
    const bodyEnd = Math.max(0, floats.length - Math.ceil(segment.rate * tailSeconds));
    for (let i = 0; i < bodyEnd; i += segment.rate) segment.chunks.push(floats.subarray(i, Math.min(bodyEnd, i + segment.rate)));
    segment.tail = floats.slice(bodyEnd);
  }
  private pump(): void {
    if (this.closed || this.paused || this.awaiting) return;
    const segment = this.segments.find(item => item.sent < item.chunks.length);
    if (!segment) return;
    const samples = segment.chunks[segment.sent];
    if (this.queuedSeconds + samples.length / segment.rate > 3.01) return;
    const chunkSeq = segment.sent++;
    this.awaiting = { segmentId: segment.segmentId, chunkSeq };
    this.options.emit({ type: 'audio-chunk', sessionId: segment.sessionId, turnId: segment.turnId, attemptId: segment.attemptId,
      generationId: segment.generationId, voiceRevision: segment.voiceRevision, segmentId: segment.segmentId,
      chunkSeq, samples: new Float32Array(samples), sampleRate: segment.rate, channels: 1, format: 'pcm_f32',
      segmentFinal: segment.complete && segment.sent === segment.chunks.length, final: segment.complete && segment.sent === segment.chunks.length });
  }
  private clear(generationId: number): void {
    if (generationId < this.generation) return;
    this.invalidateAttempt();
    // Keep the synthesis slot until the aborted worker call settles.
    this.running?.controller.abort();
    this.generation = generationId; this.segments = []; this.awaiting = undefined;
    this.paused = false; this.queuedSeconds = 0;
    this.options.emit({ type: 'output-command', sessionId: this.options.sessionId, command: 'clear', generationId });
    this.state('idle');
  }
  private invalidateAttempt(): void {
    if (!this.attempt) return;
    clearTimeout(this.attempt.wait?.timer);
    this.invalidated.add(this.attempt.attemptId);
    if (this.invalidated.size > 24) this.invalidated.delete(this.invalidated.values().next().value!);
    this.attempt = undefined;
  }
  private synthesisFailed(attempt: Attempt, segment: Segment, code: string): void {
    attempt.failure = code;
    clearTimeout(attempt.wait?.timer);
    this.segments = this.segments.filter(item => item !== segment);
    if (this.awaiting?.segmentId === segment.segmentId) this.awaiting = undefined;
    if (segment.sent) {
      const { sessionId, turnId, attemptId, generationId, voiceRevision, segmentId } = segment;
      this.options.emit({ type: 'audio-discard', sessionId, turnId, attemptId, generationId, voiceRevision, segmentId });
    }
    this.pump();
    this.schedule();
  }
  private fail(code: string): void {
    const attemptId = this.attempt?.attemptId;
    this.clear(this.generation);
    this.reportFailure(code, attemptId);
  }
  private reportFailure(code: string, attemptId?: string): void {
    this.state('error', code);
    this.options.onError?.(code, attemptId);
  }
  private progress(segment: Segment, completed: boolean): void {
    this.options.onSegment?.({ turnId: segment.turnId, attemptId: segment.attemptId, generationId: segment.generationId,
      segmentId: segment.segmentId, text: segment.text, rawText: segment.rawText, rawStart: segment.rawStart, rawEnd: segment.rawEnd, completed });
  }
  private state(state: Extract<SpeechOutputEvent, { type: 'speech-state' }>['state'], code?: string): void {
    this.options.emit({ type: 'speech-state', sessionId: this.options.sessionId, state, ...(code ? { code } : {}) });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.clear(this.generation);
    await this.running?.settled;
  }
}
