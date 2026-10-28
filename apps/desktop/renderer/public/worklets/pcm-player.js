class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.generationId = -1
    this.queue = []
    this.offset = 0
    this.rate = 16000
    this.queuedSamples = 0
    this.renderedSamples = 0
    this.paused = false
    this.final = false
    this.tick = 0
    this.port.onmessage = ({ data }) => this.command(data)
  }

  command(data) {
    if (data.type === 'clear') {
      if (data.generationId < this.generationId) return
      this.generationId = data.generationId
      this.queue = []
      this.offset = 0
      this.queuedSamples = 0
      this.renderedSamples = 0
      this.final = false
      this.paused = false
      this.port.postMessage({ type: 'state', generationId: this.generationId, playing: false, paused: false, renderedSamples: 0, queuedSamples: 0, sampleRate: this.rate })
      return
    }
    if (data.generationId < this.generationId) return
    if (data.type === 'pause' || data.type === 'resume') {
      if (data.generationId !== this.generationId) return
      this.paused = data.type === 'pause'
      this.report()
      return
    }
    if (data.type !== 'enqueue') return
    if (!(data.samples instanceof Float32Array) || !Number.isFinite(data.sampleRate) || data.sampleRate < 8000 || data.sampleRate > 192000) return
    if (data.generationId > this.generationId) {
      this.command({ type: 'clear', generationId: data.generationId })
    }
    if (data.generationId !== this.generationId || data.sampleRate !== this.rate && this.queuedSamples > 0) return
    if (this.queuedSamples + data.samples.length > data.sampleRate * 6) {
      this.port.postMessage({ type: 'overflow', generationId: this.generationId })
      return
    }
    this.rate = data.sampleRate
    if (data.samples.length > 0) {
      this.queue.push(data.samples)
      this.queuedSamples += data.samples.length
    }
    if (data.final) this.final = true
    this.report()
  }

  report(completed = false) {
    this.port.postMessage({ type: 'state', generationId: this.generationId, playing: !this.paused && this.queuedSamples > 0, paused: this.paused, completed, renderedSamples: Math.floor(this.renderedSamples), queuedSamples: Math.max(0, this.queuedSamples - this.offset), sampleRate: this.rate })
  }

  process(_input, output) {
    const channel = output[0]?.[0]
    if (!channel) return true
    channel.fill(0)
    if (this.paused) return true
    const step = this.rate / sampleRate
    for (let i = 0; i < channel.length && this.queue.length; i++) {
      const head = this.queue[0]
      const at = Math.floor(this.offset)
      const frac = this.offset - at
      const first = head[at] ?? 0
      const second = head[at + 1] ?? this.queue[1]?.[0] ?? first
      channel[i] = first + (second - first) * frac
      this.offset += step
      this.renderedSamples += step
      while (this.queue.length && this.offset >= this.queue[0].length) {
        this.offset -= this.queue[0].length
        this.queuedSamples -= this.queue[0].length
        this.queue.shift()
      }
    }
    this.tick += channel.length
    if (this.final && this.queue.length === 0) {
      this.final = false
      this.report(true)
    } else if (this.tick >= sampleRate / 5) {
      this.tick = 0
      this.report()
    }
    return true
  }
}

registerProcessor('deskai-pcm-player', PcmPlayer)
