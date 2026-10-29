import type { DeskaiEvent, PlaybackReport } from './bridge'

type AudioChunk = Extract<DeskaiEvent, { type: 'audio-chunk' }>
type OutputCommand = Extract<DeskaiEvent, { type: 'output-command' }>

/** The renderer owns one context for microphone VAD and all application playback. */
export class PcmPlayer {
  private node: AudioWorkletNode | null = null
  private gain: GainNode | null = null
  private volume = 1
  private generationId = -1
  private fixtureGeneration = 0
  private fixtureQueue: { chunks: Float32Array[]; sampleRate: number } | null = null
  private queuedEstimate = 0

  constructor(
    readonly context: AudioContext,
    private readonly sessionId: string,
    private readonly report: (state: PlaybackReport) => void,
    private readonly onError: (message: string) => void,
  ) {}

  async initialize(): Promise<void> {
    await this.context.audioWorklet.addModule(new URL('./worklets/pcm-player.js', document.baseURI).href)
    this.node = new AudioWorkletNode(this.context, 'deskai-pcm-player', { outputChannelCount: [1] })
    this.gain = this.context.createGain()
    this.gain.gain.value = this.volume
    this.node.connect(this.gain)
    this.gain.connect(this.context.destination)
    this.node.port.onmessage = ({ data }: MessageEvent) => {
      if (data.generationId !== this.generationId) return
      if (data.type === 'overflow') {
        this.onError('播放缓冲已满，后续音频块未入队。')
        this.report({ ...data, sessionId: this.sessionId, playing: false, paused: false, errorCode: 'PLAYBACK_OVERFLOW' })
        return
      }
      if (data.type === 'state') {
        this.queuedEstimate = Number.isFinite(data.queuedSamples) ? data.queuedSamples : 0
        this.report({
          ...data,
          sessionId: this.sessionId,
          generationId: data.generationId,
          playing: Boolean(data.playing),
          paused: Boolean(data.paused),
          completed: Boolean(data.completed),
          renderedSamples: data.renderedSamples,
          sampleRate: data.sampleRate,
        })
        this.pumpFixture()
      }
    }
  }

  command(command: OutputCommand): void {
    if (command.sessionId !== this.sessionId || !this.node) return
    if (command.generationId < this.generationId) return
    if (command.generationId > this.generationId && command.command !== 'clear') {
      this.node.port.postMessage({ type: 'clear', generationId: command.generationId })
    }
    if (command.command === 'clear' || command.generationId > this.generationId) this.fixtureQueue = null
    this.generationId = command.generationId
    this.node.port.postMessage({ type: command.command, generationId: command.generationId })
  }

  enqueue(chunk: AudioChunk): void {
    if (chunk.sessionId !== this.sessionId || !this.node || chunk.generationId < this.generationId) return
    if (chunk.generationId > this.generationId) {
      this.fixtureQueue = null
      this.generationId = chunk.generationId
      this.node.port.postMessage({ type: 'clear', generationId: chunk.generationId })
    }
    const samples = new Float32Array(chunk.samples)
    this.node.port.postMessage({
      type: 'enqueue', generationId: chunk.generationId, samples, sampleRate: chunk.sampleRate, final: chunk.final,
      sessionId: chunk.sessionId, turnId: chunk.turnId, attemptId: chunk.attemptId, voiceRevision: chunk.voiceRevision,
      segmentId: chunk.segmentId, chunkSeq: chunk.chunkSeq, segmentFinal: chunk.segmentFinal,
    }, [samples.buffer])
  }

  async playFixture(wav: Uint8Array): Promise<void> {
    if (!this.node) throw new Error('播放器未初始化')
    const bytes = new Uint8Array(wav)
    const audio = await this.context.decodeAudioData(bytes.buffer)
    if (audio.length === 0) throw new Error('测试音频为空')
    const mono = new Float32Array(audio.length)
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const channel = audio.getChannelData(c)
      for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / audio.numberOfChannels
    }
    this.fixtureGeneration = Math.max(this.fixtureGeneration + 1, this.generationId + 1)
    this.generationId = this.fixtureGeneration
    const chunkSize = Math.max(1, Math.floor(audio.sampleRate))
    const chunks: Float32Array[] = []
    for (let start = 0; start < mono.length; start += chunkSize) chunks.push(mono.slice(start, start + chunkSize))
    this.fixtureQueue = { chunks, sampleRate: audio.sampleRate }
    this.queuedEstimate = 0
    this.node.port.postMessage({ type: 'clear', generationId: this.generationId })
  }

  private pumpFixture(): void {
    if (!this.fixtureQueue || !this.node) return
    const { chunks, sampleRate } = this.fixtureQueue
    while (chunks.length && this.queuedEstimate + chunks[0].length <= sampleRate * 5.5) {
      const samples = chunks.shift()!
      this.queuedEstimate += samples.length
      const final = chunks.length === 0
      this.node.port.postMessage({ type: 'enqueue', generationId: this.generationId, samples, sampleRate, final }, [samples.buffer])
      if (final) this.fixtureQueue = null
    }
  }

  close(): void {
    this.fixtureQueue = null
    this.node?.port.postMessage({ type: 'clear', generationId: this.generationId + 1 })
    this.node?.disconnect()
    this.gain?.disconnect()
    this.gain = null
    this.node = null
  }

  setVolume(value: number): void {
    if (!Number.isFinite(value)) return
    this.volume = Math.max(0, Math.min(1, value))
    if (this.gain) this.gain.gain.setValueAtTime(this.volume, this.context.currentTime)
  }
}
