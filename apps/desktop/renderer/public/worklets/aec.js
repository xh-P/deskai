import { instantiate } from './aec-core.js'

class DeskaiAec extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.aec = instantiate(options.processorOptions.module).create({ sampleRate })
    this.mic = new Float32Array(128)
    this.reference = new Float32Array(128)
    this.frames = 0
    this.referenceFrames = 0
    this.tick = 0
  }

  process(inputs, outputs) {
    const out = outputs[0]?.[0]
    if (!out) return true
    const mic = inputs[0]?.[0] ?? this.mic
    const reference = inputs[1]?.[0] ?? this.reference
    if (inputs[0]?.[0] === undefined) this.mic.fill(0)
    if (inputs[1]?.[0] === undefined) this.reference.fill(0)
    try {
      this.aec.cancel(mic, reference, out)
      this.frames++
      if (reference.some(sample => Math.abs(sample) > 0.00001)) this.referenceFrames++
      this.tick += out.length
      if (this.tick >= sampleRate) {
        this.tick = 0
        this.port.postMessage({ type: 'stats', frames: this.frames, referenceFrames: this.referenceFrames, ...this.aec.stats() })
      }
    } catch (error) {
      out.fill(0)
      this.port.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'AEC_PROCESS_FAILED' })
      return false
    }
    return true
  }
}

registerProcessor('deskai-aec', DeskaiAec)
