/** Stateful, band-limited resampling from a device clock to 16 kHz mono. */
export class StreamingResampler {
  readonly inputRate: number;
  readonly outputRate = 16000;
  private readonly step: number;
  private readonly radius: number;
  private readonly cutoff: number;
  private source: number[] = [];
  private base = 0;
  private next = 0;
  private received = 0;

  constructor(inputRate: number) {
    if (!Number.isFinite(inputRate) || inputRate < 16000) throw new RangeError('inputRate must be at least 16000');
    this.inputRate = inputRate;
    this.step = inputRate / 16000;
    this.radius = Math.ceil(24 * this.step);
    this.cutoff = Math.min(1, 16000 / inputRate) * 0.94;
  }

  push(samples: Float32Array): Float32Array {
    for (const sample of samples) this.source.push(Number.isFinite(sample) ? sample : 0);
    this.received += samples.length;
    return this.take(false);
  }

  flush(): Float32Array { return this.take(true); }

  reset(): void {
    this.source = [];
    this.base = 0;
    this.next = 0;
    this.received = 0;
  }

  private take(final: boolean): Float32Array {
    const output: number[] = [];
    while (this.next < this.received / this.step && (final || this.next * this.step + this.radius < this.received)) {
      const center = this.next * this.step;
      let sum = 0;
      let weightSum = 0;
      const lo = Math.ceil(center - this.radius);
      const hi = Math.floor(center + this.radius);
      for (let i = lo; i <= hi; i++) {
        if (i < 0 || i >= this.received) continue;
        const distance = i - center;
        const x = Math.PI * distance * this.cutoff;
        const sinc = Math.abs(x) < 1e-10 ? 1 : Math.sin(x) / x;
        const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / this.radius);
        const weight = sinc * window * this.cutoff;
        sum += (this.source[i - this.base] ?? 0) * weight;
        weightSum += weight;
      }
      output.push(weightSum ? sum / weightSum : 0);
      this.next++;
    }
    const keepFrom = Math.max(0, Math.floor(this.next * this.step) - this.radius - 1);
    if (keepFrom > this.base) {
      this.source.splice(0, keepFrom - this.base);
      this.base = keepFrom;
    }
    return Float32Array.from(output);
  }
}
