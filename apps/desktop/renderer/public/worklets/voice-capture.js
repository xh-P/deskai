import { instantiate } from './aec-core.js'

class VoiceCapture extends AudioWorkletProcessor {
  constructor({ processorOptions: options }) {
    super()
    this.decimation = sampleRate / options.inputRate
    this.frameSamples = options.frameSamples
    this.aec = options.module && instantiate(options.module).create({ sampleRate, noiseSuppression: options.noiseSuppression })
    const latency = this.aec?.latencySamples ?? 0
    this.rawDelay = new Float32Array(latency)
    this.referenceDelay = new Float32Array(latency)
    this.delayOffset = 0
    this.warmup = latency
    this.samples = 0
    this.decimationOffset = 0
    this.micSum = this.rawSum = this.referenceSum = 0
    this.zeroReference = new Float32Array(0)
    this.residual = new Float32Array(0)
    this.frames = this.referenceFrames = this.measuredSamples = 0
    this.rawPower = this.residualPower = this.referencePower = 0
    this.allocateFrame()
  }

  allocateFrame() {
    this.frameOffset = 0
    this.processedFrame = new Float32Array(this.frameSamples)
    this.referenceFrame = new Float32Array(this.frameSamples)
    this.rawFrame = this.aec && new Float32Array(this.frameSamples)
  }

  process(inputs) {
    const mic = inputs[0]?.[0]
    if (!mic) return true
    if (this.zeroReference.length !== mic.length) {
      this.zeroReference = new Float32Array(mic.length)
      this.residual = new Float32Array(mic.length)
    }
    const reference = inputs[1]?.[0] ?? this.zeroReference
    try {
      if (this.aec) {
        this.aec.cancel(mic, reference, this.residual)
        this.measure(mic, reference)
      }
      const processed = this.aec ? this.residual : mic
      const latency = this.rawDelay.length
      for (let i = 0; i < mic.length; i++) {
        let raw = mic[i]
        let played = reference[i]
        if (latency) {
          const at = this.delayOffset
          raw = this.rawDelay[at]
          played = this.referenceDelay[at]
          this.rawDelay[at] = mic[i]
          this.referenceDelay[at] = reference[i]
          this.delayOffset = (at + 1) % latency
          if (this.warmup) { this.warmup--; continue }
        }
        // Average each group on the same clock before assembling Silero frames.
        this.micSum += processed[i]
        this.rawSum += raw
        this.referenceSum += played
        if (++this.decimationOffset !== this.decimation) continue
        const offset = this.frameOffset++
        this.processedFrame[offset] = this.micSum / this.decimation
        if (this.rawFrame) this.rawFrame[offset] = this.rawSum / this.decimation
        this.referenceFrame[offset] = this.referenceSum / this.decimation
        this.decimationOffset = this.micSum = this.rawSum = this.referenceSum = 0
        if (this.frameOffset !== this.frameSamples) continue
        const frame = {
          type: 'frame', samples: this.processedFrame, reference: this.referenceFrame,
          sampleStart: this.samples, contextFrameEnd: currentFrame + i + 1 - latency,
        }
        const transfer = [frame.samples.buffer, frame.reference.buffer]
        if (this.rawFrame) { frame.raw = this.rawFrame; transfer.push(frame.raw.buffer) }
        this.port.postMessage(frame, transfer)
        this.samples += this.frameSamples
        this.allocateFrame()
      }
    } catch (error) {
      this.port.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'CAPTURE_PROCESS_FAILED' })
      return false
    }
    return true
  }

  measure(mic, reference) {
    this.frames++
    let hasReference = false
    for (let i = 0; i < mic.length; i++) {
      this.rawPower += mic[i] * mic[i]
      this.referencePower += reference[i] * reference[i]
      this.residualPower += this.residual[i] * this.residual[i]
      hasReference ||= reference[i] !== 0
    }
    if (hasReference) this.referenceFrames++
    this.measuredSamples += mic.length
    if (this.measuredSamples < sampleRate) return
    this.port.postMessage({
      type: 'stats', frames: this.frames, referenceFrames: this.referenceFrames,
      rawRms: Math.sqrt(this.rawPower / this.measuredSamples),
      referenceRms: Math.sqrt(this.referencePower / this.measuredSamples),
      residualRms: Math.sqrt(this.residualPower / this.measuredSamples),
      latencyMs: this.aec.latencySamples * 1000 / sampleRate,
      ...this.aec.stats(),
    })
    this.rawPower = this.referencePower = this.residualPower = this.measuredSamples = 0
  }
}

registerProcessor('deskai-voice-capture', VoiceCapture)
