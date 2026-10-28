class CaptureStatsProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 0;
    this.samples = 0;
    this.sumSquares = 0;
    this.peak = 0;
    this.framesSinceReport = 0;
    this.reportInterval = Math.max(128, Math.round(sampleRate / 12));
  }

  process(inputs, outputs) {
    const inputChannels = inputs[0] ?? [];
    const outputChannels = outputs[0] ?? [];
    for (const output of outputChannels) output.fill(0);

    if (inputChannels.length > 0) {
      const frameCount = inputChannels[0].length;
      this.frames += frameCount;
      this.framesSinceReport += frameCount;

      for (const channel of inputChannels) {
        for (let index = 0; index < channel.length; index += 1) {
          const value = channel[index];
          this.sumSquares += value * value;
          this.samples += 1;
          this.peak = Math.max(this.peak, Math.abs(value));
        }
      }

      if (this.framesSinceReport >= this.reportInterval) {
        this.framesSinceReport = 0;
        this.port.postMessage({
          type: 'capture-stats',
          frames: this.frames,
          sampleCount: this.samples,
          rms: this.samples ? Math.sqrt(this.sumSquares / this.samples) : 0,
          peak: this.peak
        });
      }
    }

    return true;
  }
}

class PcmOutputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.playing = false;
    this.pcmFrames = 0;
    this.renderFrames = 0;
    this.sumSquares = 0;
    this.samples = 0;
    this.peak = 0;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message?.type === 'play' && message.samples instanceof Float32Array) {
        this.queue.push(message.samples);
      } else if (message?.type === 'stop') {
        this.queue = [];
        this.offset = 0;
        this.playing = false;
        this.port.postMessage({ type: 'playback-stopped' });
      }
    };
  }

  process(_inputs, outputs) {
    const outputChannels = outputs[0] ?? [];
    if (outputChannels.length === 0) return true;
    const frameCount = outputChannels[0].length;
    for (const channel of outputChannels) channel.fill(0);
    this.renderFrames += frameCount;

    if (this.queue.length > 0 && !this.playing) {
      this.playing = true;
      this.port.postMessage({ type: 'playback-started', renderFrames: this.renderFrames });
    }

    let emittedFrames = 0;
    while (emittedFrames < frameCount && this.queue.length > 0) {
      const current = this.queue[0];
      const available = current.length - this.offset;
      const count = Math.min(available, frameCount - emittedFrames);
      for (let channelIndex = 0; channelIndex < outputChannels.length; channelIndex += 1) {
        const output = outputChannels[channelIndex];
        for (let index = 0; index < count; index += 1) {
          const value = current[this.offset + index];
          output[emittedFrames + index] = value;
          this.sumSquares += value * value;
          this.samples += 1;
          this.peak = Math.max(this.peak, Math.abs(value));
        }
      }
      this.offset += count;
      emittedFrames += count;
      this.pcmFrames += count;
      if (this.offset >= current.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    if (this.playing && this.queue.length === 0) {
      this.playing = false;
      this.port.postMessage({
        type: 'playback-finished',
        pcmFrames: this.pcmFrames,
        renderFrames: this.renderFrames,
        rms: this.samples ? Math.sqrt(this.sumSquares / this.samples) : 0,
        peak: this.peak
      });
    }

    return true;
  }
}

registerProcessor('m0-capture-stats', CaptureStatsProcessor);
registerProcessor('m0-pcm-output', PcmOutputProcessor);
