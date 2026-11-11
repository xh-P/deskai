import { INPUT_RATE, VAD_FRAME_SAMPLES, type EndpointConfig, type InterruptionConfig } from '../../../../packages/voice-core/src/input-config.ts'
import { EchoGuard, rms } from './echo-guard.ts'

export type CaptureAudio = {
  sampleStart: number
  contextFrameEnd: number
  samples: Float32Array
  raw?: Float32Array
  reference: Float32Array
}

export type VadFrame = Pick<CaptureAudio, 'samples' | 'sampleStart'> & {
  probability: number
  interruptGeneration?: number
}

type Playback = { start: number; lastReferenceEnd: number; generation?: number; admittedUntil: number; interrupted: boolean }
type Analysed = { audio: CaptureAudio; samples: Float32Array; probability: number; voiced: boolean }
type Candidate = { playback: Playback; confirmAt: number; frames: Analysed[] }

const toSamples = (ms: number) => Math.ceil(ms * INPUT_RATE / 1000)
const silence = new Float32Array(VAD_FRAME_SAMPLES)

function join(frames: readonly Float32Array[]): Float32Array {
  const result = new Float32Array(frames.reduce((sum, frame) => sum + frame.length, 0))
  let offset = 0
  for (const frame of frames) {
    result.set(frame, offset)
    offset += frame.length
  }
  return result
}

/** Owns the short admission window during playback and hands continuous PCM to the endpoint. */
export class BargeInDetector {
  private readonly config: InterruptionConfig
  private readonly echo: EchoGuard
  private readonly lookback: number
  private readonly historyLength: number
  private readonly leadFrames: number
  private readonly threshold: number
  private readonly release: number
  private readonly confirm: number
  private readonly startDelay: number
  private readonly minVoiced: number
  private history: { start: number; samples: Float32Array }[] = []
  private lead: Analysed[] = []
  private playback?: Playback
  private candidate?: Candidate

  constructor(config: InterruptionConfig, endpoint: Pick<EndpointConfig, 'candidateWindowMs' | 'vadThreshold'>) {
    this.config = config
    this.echo = new EchoGuard(config.echo)
    this.lookback = toSamples(config.referenceLookbackMs)
    this.confirm = toSamples(config.confirmMs)
    this.startDelay = toSamples(config.startDelayMs)
    this.minVoiced = toSamples(config.minVoicedMs)
    this.leadFrames = Math.ceil(toSamples(config.preRollMs) / VAD_FRAME_SAMPLES)
    this.historyLength = this.lookback + Math.max(this.confirm, this.startDelay) + (this.leadFrames + 1) * VAD_FRAME_SAMPLES
    this.threshold = Math.max(config.vadThreshold, endpoint.vadThreshold)
    this.release = toSamples(endpoint.candidateWindowMs)
  }

  async process(audio: CaptureAudio, generation: number | undefined, infer: (samples: Float32Array) => Promise<number>): Promise<VadFrame[]> {
    const end = audio.sampleStart + audio.samples.length
    this.history.push({ start: audio.sampleStart, samples: audio.reference })
    while (this.history[0].start < end - this.historyLength) this.history.shift()
    const playback = this.observePlayback(audio, end, generation)
    const level = rms(audio.samples)
    const raw = playback && audio.raw
    const samples = raw && level < this.config.minRms && rms(raw) >= this.config.minRms * this.config.rawMinRmsMultiplier
      ? raw : audio.samples
    const probability = await infer(samples)
    const voiced = probability >= this.threshold && (samples !== audio.samples || level >= this.config.minRms)
    const frame = { audio, samples, probability, voiced }

    if (!this.candidate) {
      if (!playback) return [...this.takeLead(false), this.forward(frame)]
      if (audio.sampleStart < playback.admittedUntil) {
        if (voiced) playback.admittedUntil = end + this.release
        return [this.forward(frame)]
      }
      if (!voiced) {
        this.lead.push(frame)
        if (this.lead.length > this.leadFrames) return [this.mute(this.lead.shift()!)]
        return []
      }
      this.candidate = {
        playback, frames: [],
        confirmAt: Math.max(audio.sampleStart + this.confirm, playback.start + this.startDelay),
      }
    }

    this.candidate.frames.push(frame)
    return end >= this.candidate.confirmAt ? this.finishCandidate(this.candidate, end) : []
  }

  private observePlayback(audio: CaptureAudio, end: number, generation?: number): Playback | undefined {
    if (rms(audio.reference) >= this.config.minReferenceRms) {
      if (!this.playback || generation !== undefined && this.playback.generation !== undefined && generation !== this.playback.generation) {
        this.playback = { start: audio.sampleStart, lastReferenceEnd: end, generation, admittedUntil: 0, interrupted: false }
      }
      this.playback.generation ??= generation
      this.playback.lastReferenceEnd = end
    }
    if (this.playback && audio.sampleStart - this.playback.lastReferenceEnd < this.lookback) return this.playback
  }

  private finishCandidate({ frames, playback }: Candidate, end: number): VadFrame[] {
    this.candidate = undefined
    const voicedSamples = frames.reduce((sum, frame) => sum + (frame.voiced ? frame.samples.length : 0), 0)
    if (voicedSamples < this.minVoiced) return [...this.takeLead(false), ...frames.map(frame => this.mute(frame))]

    const first = frames[0].audio
    const reference = this.referenceWindow(first.sampleStart - this.lookback, end)
    const raw = first.raw && join(frames.map(frame => frame.audio.raw!))
    const usesRaw = frames.some(frame => frame.samples !== frame.audio.samples)
    const isEcho = usesRaw ? this.echo.matchesRaw(reference, raw!)
      : this.echo.matches(reference, join(frames.map(frame => frame.audio.samples)), raw)
    if (isEcho) {
      return [...this.takeLead(false), ...frames.map(frame => this.mute(frame))]
    }

    playback.admittedUntil = end + this.release
    const admitted = frames.map(frame => this.forward(frame))
    if (!playback.interrupted && playback.generation !== undefined) {
      playback.interrupted = true
      admitted[0].interruptGeneration = playback.generation
    }
    return [...this.takeLead(true, usesRaw), ...admitted]
  }

  private referenceWindow(start: number, end: number): Float32Array {
    const reference = new Float32Array(end - start)
    for (const frame of this.history) {
      const from = Math.max(start, frame.start)
      const to = Math.min(end, frame.start + frame.samples.length)
      if (from < to) reference.set(frame.samples.subarray(from - frame.start, to - frame.start), from - start)
    }
    return reference
  }

  private takeLead(admit: boolean, usesRaw = false): VadFrame[] {
    const lead = this.lead
    this.lead = []
    if (!admit) return lead.map(frame => this.mute(frame))
    let recoverRaw = false
    if (usesRaw && lead.length) {
      const start = lead[0].audio.sampleStart
      const raw = join(lead.map(frame => frame.audio.raw!))
      const reference = this.referenceWindow(start - this.lookback, start + raw.length)
      recoverRaw = !this.echo.matchesRaw(reference, raw)
    }
    return lead.map(({ audio }) => ({
      sampleStart: audio.sampleStart, samples: recoverRaw ? audio.raw! : audio.samples, probability: 0,
    }))
  }

  private forward(frame: Analysed): VadFrame {
    return { sampleStart: frame.audio.sampleStart, samples: frame.samples, probability: frame.probability }
  }

  private mute(frame: Analysed): VadFrame {
    return { sampleStart: frame.audio.sampleStart, samples: silence, probability: 0 }
  }
}
