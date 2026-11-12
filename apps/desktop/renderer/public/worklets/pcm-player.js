class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.generationId = -1
    this.queue = []
    this.offset = 0
    this.renderedSamples = 0
    this.paused = false
    this.started = false
    this.tick = 0
    this.sequences = new Map()
    this.identity = {}
    this.rate = 16000
    this.visualSegment = undefined
    this.mouthCount = 0
    this.mouthEnergy = 0
    this.mouthBright = 0
    this.mouthLow = 0
    this.mouthFilter = 1 - Math.exp(-2 * Math.PI * 850 / sampleRate)
    this.port.onmessage = ({ data }) => this.command(data)
  }

  queuedSeconds() {
    return Math.max(0, this.queue.reduce((n, chunk) => n + chunk.samples.length / chunk.sampleRate, 0) - this.offset / (this.queue[0]?.sampleRate || this.rate))
  }

  command(data) {
    if (!Number.isSafeInteger(data.generationId) || data.generationId < this.generationId) return
    if (data.type === 'clear') {
      this.generationId = data.generationId
      this.queue = []
      this.offset = 0
      this.renderedSamples = 0
      this.paused = false
      this.started = false
      this.sequences.clear()
      this.identity = {}
      this.resetMouth()
      this.report()
      return
    }
    if (data.type === 'pause' || data.type === 'resume') {
      if (data.generationId !== this.generationId) return
      this.paused = data.type === 'pause'
      this.resetMouth()
      this.report()
      return
    }
    if (data.type !== 'enqueue') return
    if (!(data.samples instanceof Float32Array) || !Number.isFinite(data.sampleRate) || data.sampleRate < 8000 || data.sampleRate > 192000 || !data.samples.length) return
    if (data.generationId > this.generationId) this.command({ type: 'clear', generationId: data.generationId })
    const identity = {}
    for (const key of ['sessionId', 'turnId', 'attemptId', 'voiceRevision', 'segmentId', 'chunkSeq']) if (data[key] !== undefined) identity[key] = data[key]
    if (data.segmentId !== undefined) {
      const key = JSON.stringify([data.sessionId, data.turnId, data.attemptId, data.voiceRevision, data.segmentId])
      const next = this.sequences.get(key) || 0
      if (!Number.isSafeInteger(data.chunkSeq) || data.chunkSeq < 0) return
      if (data.chunkSeq < next) { this.report(false, identity, { chunkAccepted: true }); return }
      if (data.chunkSeq !== next || this.sequences.size > 1024) { this.report(false, identity, { errorCode: 'PLAYBACK_SEQUENCE' }); return }
      identity.sequenceKey = key
    }
    if (this.queuedSeconds() + data.samples.length / data.sampleRate > 6) {
      this.port.postMessage({ type: 'overflow', generationId: this.generationId, ...identity, errorCode: 'PLAYBACK_OVERFLOW' })
      return
    }
    if (identity.sequenceKey) this.sequences.set(identity.sequenceKey, data.chunkSeq + 1)
    delete identity.sequenceKey
    this.queue.push({ samples: data.samples, sampleRate: data.sampleRate, final: data.final, segmentFinal: data.segmentFinal, identity })
    this.rate = data.sampleRate
    this.report(false, identity, { chunkAccepted: true })
  }

  resetMouth() {
    this.visualSegment = undefined
    this.mouthCount = this.mouthEnergy = this.mouthBright = this.mouthLow = 0
  }

  emitMouth(frame) {
    if (!this.mouthCount) return
    const rms = Math.sqrt(this.mouthEnergy / this.mouthCount)
    const shape = this.mouthEnergy > 0 ? Math.max(-1, Math.min(1, (Math.sqrt(this.mouthBright / this.mouthEnergy) - 0.5) * 2.5)) : 0
    const { attemptId, segmentId } = this.identity
    this.port.postMessage({ type: 'mouth', generationId: this.generationId, attemptId, segmentId,
      frame, sampleRate, rms, shape })
    this.mouthCount = this.mouthEnergy = this.mouthBright = 0
  }

  report(completed = false, identity = this.identity, extra = {}) {
    const queuedSeconds = this.queuedSeconds()
    this.port.postMessage({ type: 'state', generationId: this.generationId, ...identity,
      playing: !this.paused && queuedSeconds > 0, paused: this.paused, completed,
      renderedSamples: Math.floor(this.renderedSamples), queuedSamples: Math.round(queuedSeconds * this.rate), queuedSeconds,
      sampleRate: this.rate, ...extra })
  }

  process(_input, output) {
    const channel = output[0]?.[0]
    if (!channel) return true
    channel.fill(0)
    if (this.paused) return true
    if (this.queue.length && !this.started) {
      this.started = true
      this.port.postMessage({ type: 'render-start', generationId: this.generationId, contextFrame: currentFrame })
    }
    for (let i = 0; i < channel.length && this.queue.length; i++) {
      const head = this.queue[0]
      const at = Math.floor(this.offset)
      const frac = this.offset - at
      const first = head.samples[at] ?? 0
      const second = head.samples[at + 1] ?? this.queue[1]?.samples[0] ?? first
      const sample = first + (second - first) * frac
      channel[i] = sample
      if (head.identity.segmentId !== this.visualSegment) {
        this.emitMouth(currentFrame + i)
        this.resetMouth()
        this.visualSegment = head.identity.segmentId
        if (this.visualSegment) this.report(false, head.identity, { segmentStarted: true })
      }
      const step = head.sampleRate / sampleRate
      this.offset += step
      this.renderedSamples += step
      this.identity = head.identity
      this.rate = head.sampleRate
      if (this.visualSegment) {
        this.mouthLow += (sample - this.mouthLow) * this.mouthFilter
        this.mouthEnergy += sample * sample
        const bright = sample - this.mouthLow
        this.mouthBright += bright * bright
        if (++this.mouthCount >= sampleRate / 34) this.emitMouth(currentFrame + i)
      }
      if (this.offset >= head.samples.length) {
        const overshootSeconds = (this.offset - head.samples.length) / head.sampleRate
        this.queue.shift()
        this.offset = overshootSeconds * (this.queue[0]?.sampleRate || head.sampleRate)
        if (head.segmentFinal || !this.queue.length) this.emitMouth(currentFrame + i)
        if (!this.queue.length) {
          this.offset = 0
          this.resetMouth()
        }
        if (head.segmentFinal || head.final && !this.queue.length) this.report(!this.queue.length, head.identity, { segmentCompleted: Boolean(head.segmentFinal) })
        else if (!this.queue.length) this.report(false, head.identity)
      }
    }
    this.tick += channel.length
    if (this.tick >= sampleRate / 5) {
      this.tick = 0
      this.report()
    }
    return true
  }
}

registerProcessor('deskai-pcm-player', PcmPlayer)
