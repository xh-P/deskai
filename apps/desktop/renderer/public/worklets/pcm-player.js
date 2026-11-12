const maxPcmRate = 192000
const edgeFrameSeconds = .005
const onsetProbeSeconds = .120
const onsetPrerollSeconds = .020
const onsetFloor = 10 ** (-50 / 20)
const onsetPeak = 10 ** (-38 / 20)
const releaseMaxSeconds = .004

function quietFrame(samples, start, end, rmsLimit, peakLimit) {
  let energy = 0
  for (let index = start; index < end; index++) {
    const sample = samples[index]
    if (Math.abs(sample) >= peakLimit) return false
    energy += sample * sample
  }
  return energy < rmsLimit * rmsLimit * (end - start)
}

function firstOnset(samples, length, rate) {
  const frame = Math.round(rate * edgeFrameSeconds)
  for (let start = 0; start + frame <= length; start += frame) {
    if (!quietFrame(samples, start, start + frame, onsetFloor, onsetPeak)) return start
  }
  return -1
}

function segmentKey({ sessionId, turnId, attemptId, voiceRevision, segmentId }) {
  return JSON.stringify([sessionId, turnId, attemptId, voiceRevision, segmentId])
}

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.generationId = -1
    this.queue = []
    this.offset = 0
    this.renderedSamples = 0
    this.paused = false
    this.started = false
    this.release = undefined
    this.tick = 0
    this.sequences = new Map()
    this.nextHead = new Float32Array(Math.ceil(maxPcmRate * onsetProbeSeconds))
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
      this.release = undefined
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
    if (data.type === 'discard') {
      if (data.generationId !== this.generationId) return
      const key = segmentKey(data)
      this.sequences.set(key, null)
      const head = this.queue[0]
      this.queue = this.queue.filter(chunk => chunk.key !== key)
      if (this.queue[0] !== head) {
        this.offset = 0
        this.identity = {}
        this.resetMouth()
      }
      this.report(false, this.queue[0]?.identity ?? this.identity)
      return
    }
    if (data.type !== 'enqueue') return
    if (!(data.samples instanceof Float32Array) || !Number.isFinite(data.sampleRate) || data.sampleRate < 8000 || data.sampleRate > maxPcmRate || !data.samples.length) return
    if (data.generationId > this.generationId) this.command({ type: 'clear', generationId: data.generationId })
    const identity = {}
    for (const key of ['sessionId', 'turnId', 'attemptId', 'voiceRevision', 'segmentId', 'chunkSeq']) if (data[key] !== undefined) identity[key] = data[key]
    const key = data.segmentId === undefined ? undefined : segmentKey(data)
    if (key !== undefined) {
      const sequence = this.sequences.get(key)
      if (sequence === null) return
      const next = sequence ?? 0
      if (!Number.isSafeInteger(data.chunkSeq) || data.chunkSeq < 0) return
      if (data.chunkSeq < next) { this.report(false, identity, { chunkAccepted: true }); return }
      if (data.chunkSeq !== next || this.sequences.size > 1024) { this.report(false, identity, { errorCode: 'PLAYBACK_SEQUENCE' }); return }
    }
    if (this.queuedSeconds() + data.samples.length / data.sampleRate > 6) {
      this.port.postMessage({ type: 'overflow', generationId: this.generationId, ...identity, errorCode: 'PLAYBACK_OVERFLOW' })
      return
    }
    if (key !== undefined) this.sequences.set(key, data.chunkSeq + 1)
    this.queue.push({ samples: data.samples, sampleRate: data.sampleRate, final: data.final, segmentFinal: data.segmentFinal, identity, key })
    this.rate = data.sampleRate
    this.report(false, identity, { chunkAccepted: true })
  }

  followingOnset(current) {
    const next = this.queue[0]
    if (!next?.key || next.identity.attemptId !== current.identity.attemptId ||
        next.identity.voiceRevision !== current.identity.voiceRevision) return -1
    const limit = Math.round(next.sampleRate * onsetProbeSeconds)
    let length = 0
    for (let index = 0; index < this.queue.length && length < limit; index++) {
      const chunk = this.queue[index]
      if (chunk.key !== next.key) break
      const samples = chunk.samples.subarray(0, limit - length)
      this.nextHead.set(samples, length)
      length += samples.length
    }
    return firstOnset(this.nextHead, length, next.sampleRate)
  }

  finishSpeech(chunk, lastSample) {
    const next = this.queue[0]
    const onset = this.followingOnset(chunk)
    const preroll = onset > 0 ? Math.min(onset, Math.round(next.sampleRate * onsetPrerollSeconds)) : 0
    // Trim only confirmed silence in the following segment, after consuming the original tail.
    let skip = Math.max(0, onset - preroll)
    while (skip > 0) {
      const leading = this.queue[0]
      if (skip < leading.samples.length) {
        leading.samples = leading.samples.subarray(skip)
        break
      }
      skip -= leading.samples.length
      this.queue.shift()
    }
    if (lastSample === 0) return
    // Release the residual level after the last PCM sample, into quiet pre-roll when it fits.
    const seconds = Math.min(releaseMaxSeconds, .001 * Math.log2(1 + Math.abs(lastSample) / onsetFloor))
    const frames = Math.ceil(seconds * sampleRate)
    const intoNext = preroll > 0 && preroll - this.offset >= frames * next.sampleRate / sampleRate
    this.release = { from: lastSample, frames, position: 0, key: intoNext ? next.key : undefined }
  }

  releaseSample(sample = 0) {
    const release = this.release
    const weight = .5 + .5 * Math.cos(Math.PI * ++release.position / release.frames)
    if (release.position === release.frames) {
      this.release = undefined
      if (!this.queue.length) this.report(true)
    }
    return sample + (release.from - sample) * weight
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
      playing: !this.paused && (queuedSeconds > 0 || Boolean(this.release)), paused: this.paused, completed,
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
    for (let i = 0; i < channel.length; i++) {
      const head = this.queue[0]
      if (this.release && (!this.release.key || this.release.key !== head?.key)) {
        channel[i] = this.releaseSample()
        continue
      }
      if (!head) break
      const at = Math.floor(this.offset)
      const frac = this.offset - at
      const first = head.samples[at] ?? 0
      const second = head.samples[at + 1] ?? (head.segmentFinal ? first : this.queue[1]?.samples[0] ?? first)
      const interpolated = first + (second - first) * frac
      const sample = this.release ? this.releaseSample(interpolated) : interpolated
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
        if (head.segmentFinal) this.finishSpeech(head, sample)
        if (head.segmentFinal || !this.queue.length) this.emitMouth(currentFrame + i)
        if (!this.queue.length) {
          this.offset = 0
          this.resetMouth()
        }
        if (head.segmentFinal || head.final && !this.queue.length) this.report(!this.queue.length && !this.release, head.identity, { segmentCompleted: Boolean(head.segmentFinal) })
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
