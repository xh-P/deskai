import { instantiate } from './aec-core.js'

class DeskaiAec extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.aec = instantiate(options.processorOptions.module).create({
      sampleRate,
      noiseSuppression: options.processorOptions.noiseSuppression === true,
    })
    this.mic = new Float32Array(128)
    this.reference = new Float32Array(128)
    this.frames = 0
    this.referenceFrames = 0
    this.tick = 0
    this.rawPower = 0
    this.referencePower = 0
    this.residualPower = 0
    this.measuredSamples = 0
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
      let hasReference = false
      for (let i = 0; i < out.length; i++) {
        this.rawPower += mic[i] * mic[i]
        this.referencePower += reference[i] * reference[i]
        this.residualPower += out[i] * out[i]
        if (Math.abs(reference[i]) > 0.00001) hasReference = true
      }
      if (hasReference) this.referenceFrames++
      this.measuredSamples += out.length
      this.tick += out.length
      if (this.tick >= sampleRate) {
        this.tick = 0
        const samples = this.measuredSamples
        this.port.postMessage({
          type: 'stats', frames: this.frames, referenceFrames: this.referenceFrames,
          rawRms: Math.sqrt(this.rawPower / samples),
          referenceRms: Math.sqrt(this.referencePower / samples),
          residualRms: Math.sqrt(this.residualPower / samples),
          latencyMs: this.aec.latencySamples * 1000 / sampleRate,
          ...this.aec.stats(),
        })
        this.rawPower = 0
        this.referencePower = 0
        this.residualPower = 0
        this.measuredSamples = 0
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
