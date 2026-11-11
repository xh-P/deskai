import { INPUT_RATE, type InterruptionConfig } from '../../../../packages/voice-core/src/input-config.ts'

const WINDOW = INPUT_RATE * 25 / 1000
const HOP = INPUT_RATE * 20 / 1000
const FFT_SIZE = 512
const BAND_EDGES = [80, 250, 500, 900, 1500, 2500, 3800, 5600, 7600]
const BAND_BINS = BAND_EDGES.map(hz => Math.ceil(hz * FFT_SIZE / INPUT_RATE))
const BAND_COUNT = BAND_BINS.length - 1
const hann = Float64Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WINDOW - 1)))
const cos = Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => Math.cos(-2 * Math.PI * i / FFT_SIZE))
const sin = Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => Math.sin(-2 * Math.PI * i / FFT_SIZE))
const reversed = new Uint16Array(FFT_SIZE)
for (let i = 1; i < FFT_SIZE; i++) reversed[i] = (reversed[i >> 1] >> 1) | ((i & 1) * FFT_SIZE / 2)

export function rms(samples: Float32Array): number {
  let power = 0
  for (const sample of samples) power += sample * sample
  return Math.sqrt(power / samples.length)
}

/** Amadeus-style log band power, compared at a lag supported by the waveform. */
export class EchoGuard {
  private readonly thresholds: InterruptionConfig['echo']
  private real = new Float64Array(FFT_SIZE)
  private imag = new Float64Array(FFT_SIZE)

  constructor(thresholds: InterruptionConfig['echo']) {
    this.thresholds = thresholds
  }

  matchesRaw(reference: Float32Array, raw: Float32Array): boolean {
    const playback = this.alignedFeatures(raw, reference)
    return playback !== undefined && this.correlation(this.features(raw), playback) >= this.thresholds.rawCorrelation
  }

  matches(reference: Float32Array, processed: Float32Array, raw?: Float32Array): boolean {
    const mic = raw ?? processed
    const playback = this.alignedFeatures(mic, reference)
    if (!playback) return false
    const rawScore = this.correlation(this.features(mic), playback)
    if (!raw) return rawScore >= this.thresholds.singleSignalCorrelation
    if (rawScore < this.thresholds.rawCorrelation) return false
    const residualScore = this.correlation(this.features(processed), playback)
    return (residualScore >= this.thresholds.residualCorrelation && rms(processed) <= rms(raw) * this.thresholds.residualRatio)
      || (rawScore >= this.thresholds.strongRawCorrelation && residualScore >= this.thresholds.strongRawResidualCorrelation)
  }

  private alignedFeatures(mic: Float32Array, reference: Float32Array): Float64Array | undefined {
    const offset = this.waveformOffset(mic, reference)
    if (offset !== undefined) return this.features(reference.subarray(offset, offset + mic.length))
  }

  private waveformOffset(mic: Float32Array, reference: Float32Array): number | undefined {
    // Sample the inner product at 4 kHz and search lags on the 16 kHz clock.
    // Similar spectra alone can match unrelated phrases from the same voice.
    const stride = INPUT_RATE / 4000
    let micPower = 0
    for (let i = 0; i < mic.length; i += stride) micPower += mic[i] ** 2
    if (micPower === 0) return
    let best = this.thresholds.waveformCorrelation ** 2
    let offset: number | undefined
    for (let lag = 0; lag <= reference.length - mic.length; lag++) {
      let dot = 0, refPower = 0
      for (let i = 0; i < mic.length; i += stride) {
        const ref = reference[lag + i]
        dot += mic[i] * ref
        refPower += ref * ref
      }
      const score = dot * dot / (micPower * refPower)
      if (score >= best) {
        best = score
        offset = lag
      }
    }
    return offset
  }

  private features(samples: Float32Array): Float64Array {
    const windows = Math.max(0, 1 + Math.floor((samples.length - WINDOW) / HOP))
    const features = new Float64Array(windows * BAND_COUNT)
    const { real, imag } = this
    for (let row = 0; row < windows; row++) {
      real.fill(0)
      imag.fill(0)
      for (let i = 0; i < WINDOW; i++) real[reversed[i]] = samples[row * HOP + i] * hann[i]
      for (let size = 2; size <= FFT_SIZE; size *= 2) {
        const half = size / 2
        for (let start = 0; start < FFT_SIZE; start += size) {
          for (let k = 0; k < half; k++) {
            const a = start + k, b = a + half, phase = k * FFT_SIZE / size
            const re = real[b] * cos[phase] - imag[b] * sin[phase]
            const im = real[b] * sin[phase] + imag[b] * cos[phase]
            real[b] = real[a] - re
            imag[b] = imag[a] - im
            real[a] += re
            imag[a] += im
          }
        }
      }
      for (let band = 0; band < BAND_COUNT; band++) {
        const first = BAND_BINS[band], end = BAND_BINS[band + 1]
        let power = 0
        for (let k = first; k < end; k++) power += real[k] ** 2 + imag[k] ** 2
        features[row * BAND_COUNT + band] = Math.log1p(power / (end - first))
      }
    }
    return features
  }

  private correlation(candidate: Float64Array, reference: Float64Array): number {
    const length = candidate.length
    const candidateMean = candidate.reduce((sum, value) => sum + value, 0) / length
    const referenceMean = reference.reduce((sum, value) => sum + value, 0) / length
    let candidatePower = 0, referencePower = 0, dot = 0
    for (let i = 0; i < length; i++) {
      const mic = candidate[i] - candidateMean
      const ref = reference[i] - referenceMean
      candidatePower += mic * mic
      referencePower += ref * ref
      dot += mic * ref
    }
    const power = candidatePower * referencePower
    return power > 0 ? dot / Math.sqrt(power) : 0
  }
}
