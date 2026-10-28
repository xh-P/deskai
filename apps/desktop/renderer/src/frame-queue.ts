/** Serialize stateful VAD inference without retaining a complete utterance. */
export class FrameQueue {
  private frames: Float32Array[] = []
  private running: Promise<void> | null = null
  private closed = false
  private processFrame: (frame: Float32Array) => Promise<void>
  private onError: (error: unknown) => void
  private readonly maxFrames: number

  constructor(processFrame: (frame: Float32Array) => Promise<void>, onError: (error: unknown) => void, maxFrames = 8) {
    this.processFrame = processFrame
    this.onError = onError
    this.maxFrames = maxFrames
  }

  push(frame: Float32Array): void {
    if (this.closed) return
    if (this.frames.length + Number(this.running !== null) >= this.maxFrames) {
      this.closed = true
      this.frames = []
      this.onError(new Error('VAD处理落后，已停止采集；请减少后台负载后重试。'))
      return
    }
    this.frames.push(frame.slice())
    this.drain()
  }

  private drain(): void {
    if (this.closed || this.running || this.frames.length === 0) return
    const frame = this.frames.shift()!
    this.running = Promise.resolve().then(() => this.processFrame(frame)).catch(error => {
      this.closed = true
      this.frames = []
      this.onError(error)
    }).finally(() => {
      this.running = null
      this.drain()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    this.frames = []
    await this.running
  }
}
