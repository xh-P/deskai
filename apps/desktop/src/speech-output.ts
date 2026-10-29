import { SentenceStream, type SpokenSentence } from '../../../packages/voice-core/src/sentences.ts';
import type { DialogueEvent } from '../../../packages/voice-core/src/dialogue.ts';
import type { LocalTtsService } from '../../../packages/tts-adapter/src/index.ts';

type Identity = { sessionId: string; turnId: string; attemptId: string; generationId: number; voiceRevision: number; segmentId: string };
type Selection = { voiceId: string; referenceId?: string; voiceRevision: number; language?: 'auto' | 'zh' | 'ja' | 'all_zh' | 'all_ja' | 'en'; speed?: number };
export type SpeechPort = Pick<LocalTtsService, 'synthesize' | 'cancel'>;
export type SpeechPlaybackReport = { sessionId: string; generationId: number; turnId?: string; attemptId?: string; voiceRevision?: number; segmentId?: string; chunkSeq?: number;
  queuedSeconds?: number; playing: boolean; paused: boolean; completed?: boolean; chunkAccepted?: boolean; segmentCompleted?: boolean; errorCode?: string };
export type SpeechProgress = SpokenSentence & { turnId: string; attemptId: string; generationId: number; segmentId: string; completed: boolean };
export type SpeechOutputEvent =
  | (Identity & { type: 'audio-chunk'; samples: Float32Array; sampleRate: number; channels: 1; format: 'pcm_f32'; chunkSeq: number; segmentFinal: boolean; final: boolean })
  | { type: 'output-command'; sessionId: string; command: 'clear' | 'pause' | 'resume'; generationId: number }
  | { type: 'speech-state'; sessionId: string; state: 'idle' | 'buffering' | 'playing' | 'paused' | 'error'; code?: string };
type Segment = SpokenSentence & Identity & { chunks: Float32Array[]; rate: number; samples: number; complete: boolean; sent: number; received: Set<number> };
type Attempt = { turnId: string; attemptId: string; generationId: number; stream: SentenceStream; ended: boolean; serial: number; lastId?: string; finalReported: boolean };
type Options = { sessionId: string; port: SpeechPort; emit: (event: SpeechOutputEvent) => void;
  onSegment?: (progress: SpeechProgress) => void; onFinalSegment?: (attemptId: string, segmentId: string) => void;
  onError?: (code: string, attemptId?: string) => void };

/** One CUDA request, at most two bounded sentences, and <=3s acknowledged renderer lookahead. */
export class SpeechOutput {
  private selection: Selection = { voiceId: 'nagato-normal-v2', voiceRevision: 0, language: 'auto', speed: 1 };
  private attempt?: Attempt;
  private generation = 0;
  private segments: Segment[] = [];
  private running?: AbortController;
  private awaiting?: { segmentId: string; chunkSeq: number };
  private paused = false;
  private queuedSeconds = 0;
  private closed = false;
  private cancellation: Promise<void> = Promise.resolve();
  private sources = new Map<string, 'voice' | 'text'>();
  private invalidated = new Set<string>();
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }

  setSelection(selection: Selection): void {
    if (selection.voiceRevision !== this.selection.voiceRevision || selection.voiceId !== this.selection.voiceId) this.clear(this.generation);
    this.selection = { ...this.selection, ...selection };
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
      }
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
    if (Number.isFinite(report.queuedSeconds)) this.queuedSeconds = Math.max(0, Math.min(6, report.queuedSeconds!));
    if (accepted) this.awaiting = undefined;
    if (report.segmentCompleted && segment.complete && segment.sent === segment.chunks.length && report.chunkSeq === segment.chunks.length - 1) {
      this.progress(segment, true);
      this.segments = this.segments.filter(item => item !== segment);
    } else if (report.playing) this.progress(segment, false);
    this.state(report.paused ? 'paused' : report.playing ? 'playing' : 'buffering');
    this.pump(); this.schedule();
  }
  private schedule(): void {
    const attempt = this.attempt;
    if (!attempt || this.closed || this.paused || this.running || this.segments.length >= 2 || this.queuedSeconds > 3) return;
    let sentence: SpokenSentence | undefined;
    do { sentence = attempt.stream.next(); } while (sentence && !sentence.text);
    if (!sentence) {
      if (attempt.ended && attempt.lastId && !attempt.finalReported) {
        attempt.finalReported = true; this.options.onFinalSegment?.(attempt.attemptId, attempt.lastId);
      }
      if (attempt.ended && !this.segments.length) this.state('idle');
      return;
    }
    const segment: Segment = { ...sentence, sessionId: this.options.sessionId, turnId: attempt.turnId, attemptId: attempt.attemptId,
      generationId: attempt.generationId, voiceRevision: this.selection.voiceRevision, segmentId: `${attempt.attemptId}-s${++attempt.serial}`,
      chunks: [], rate: 0, samples: 0, complete: false, sent: 0, received: new Set() };
    attempt.lastId = segment.segmentId;
    this.segments.push(segment);
    const controller = new AbortController(); this.running = controller;
    const selection = { ...this.selection };
    this.state('buffering');
    const language = selection.language === 'zh' || selection.language === 'all_zh' ? 'all_zh'
      : selection.language === 'ja' || selection.language === 'all_ja' ? 'all_ja'
      : selection.language === 'en' ? 'en' : /[\u3040-\u30ff]/u.test(sentence.text) ? 'all_ja' : /\p{Script=Han}/u.test(sentence.text) ? 'all_zh' : 'en';
    if ((!selection.language || selection.language === 'auto') && /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hangul}]/u.test(sentence.text)) {
      this.running = undefined; this.fail('UNSUPPORTED_SPEECH_LANGUAGE'); return;
    }
    void this.cancellation.then(() => { if (controller.signal.aborted) return;
      return this.options.port.synthesize({ sessionId: segment.sessionId, turnId: segment.turnId, generationId: segment.generationId,
      voiceRevision: segment.voiceRevision, segmentId: segment.segmentId, voiceId: selection.voiceId, referenceId: selection.referenceId ?? 'default',
      text: segment.text, language, speed: selection.speed }, pcm => {
      if (controller.signal.aborted || this.attempt !== attempt || this.generation !== segment.generationId) return;
      if (segment.received.has(pcm.chunkSeq)) return;
      if (!Number.isSafeInteger(pcm.chunkSeq) || pcm.chunkSeq !== segment.received.size || pcm.channels !== 1
        || !Number.isInteger(pcm.sampleRate) || pcm.sampleRate < 8000 || pcm.sampleRate > 192000 || pcm.pcm.length % 2
        || (segment.rate && segment.rate !== pcm.sampleRate)) throw new Error('TTS_PCM_FORMAT');
      segment.received.add(pcm.chunkSeq); segment.rate = pcm.sampleRate;
      const view = new DataView(pcm.pcm.buffer, pcm.pcm.byteOffset, pcm.pcm.byteLength);
      segment.samples += view.byteLength / 2;
      if (segment.samples > segment.rate * 30) throw new Error('TTS_AUDIO_LIMIT');
      const floats = new Float32Array(view.byteLength / 2);
      for (let i = 0; i < floats.length; i++) floats[i] = view.getInt16(i * 2, true) / 32768;
      for (let i = 0; i < floats.length; i += segment.rate) segment.chunks.push(floats.slice(i, i + segment.rate));
    }, controller.signal); }).then(result => {
      if (controller.signal.aborted || this.attempt !== attempt) return;
      if (result?.canceled) throw new Error('TTS_CANCELED');
      if (!segment.samples) throw new Error('TTS_EMPTY_AUDIO');
      segment.complete = true;
    }).catch(error => { if (!controller.signal.aborted && this.attempt === attempt) this.fail(error instanceof Error ? error.message : 'TTS_FAILED'); })
      .finally(() => { if (this.running === controller) this.running = undefined; this.pump(); this.schedule(); });
  }
  private pump(): void {
    if (this.closed || this.paused || this.awaiting) return;
    const segment = this.segments.find(item => item.complete && item.sent < item.chunks.length);
    if (!segment) return;
    const samples = segment.chunks[segment.sent];
    if (this.queuedSeconds + samples.length / segment.rate > 3.01) return;
    const chunkSeq = segment.sent++;
    this.awaiting = { segmentId: segment.segmentId, chunkSeq };
    this.queuedSeconds += samples.length / segment.rate;
    this.options.emit({ type: 'audio-chunk', sessionId: segment.sessionId, turnId: segment.turnId, attemptId: segment.attemptId,
      generationId: segment.generationId, voiceRevision: segment.voiceRevision, segmentId: segment.segmentId,
      chunkSeq, samples: new Float32Array(samples), sampleRate: segment.rate, channels: 1, format: 'pcm_f32',
      segmentFinal: segment.sent === segment.chunks.length, final: segment.sent === segment.chunks.length });
  }
  private clear(generationId: number): void {
    if (generationId < this.generation) return;
    if (this.attempt) {
      this.invalidated.add(this.attempt.attemptId);
      if (this.invalidated.size > 24) this.invalidated.delete(this.invalidated.values().next().value!);
    }
    const wasRunning = this.running;
    wasRunning?.abort(); this.running = undefined;
    if (wasRunning) this.cancellation = this.cancellation.then(() => this.options.port.cancel()).catch(() => {});
    this.generation = generationId; this.attempt = undefined; this.segments = []; this.awaiting = undefined;
    this.paused = false; this.queuedSeconds = 0;
    this.options.emit({ type: 'output-command', sessionId: this.options.sessionId, command: 'clear', generationId });
  }
  private fail(code: string): void {
    const attemptId = this.attempt?.attemptId;
    this.clear(this.generation); this.state('error', code); this.options.onError?.(code, attemptId);
  }
  private progress(segment: Segment, completed: boolean): void {
    this.options.onSegment?.({ turnId: segment.turnId, attemptId: segment.attemptId, generationId: segment.generationId,
      segmentId: segment.segmentId, text: segment.text, rawText: segment.rawText, rawStart: segment.rawStart, rawEnd: segment.rawEnd, completed });
  }
  private state(state: Extract<SpeechOutputEvent, { type: 'speech-state' }>['state'], code?: string): void {
    this.options.emit({ type: 'speech-state', sessionId: this.options.sessionId, state, ...(code ? { code } : {}) });
  }
  async close(): Promise<void> { this.clear(this.generation + 1); this.closed = true; await this.options.port.cancel(); }
}
