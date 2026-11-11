import * as ort from 'onnxruntime-web/wasm'
import { Silero } from '@ricky0123/vad-web/dist/models/silero'
import { aecUsesWebRtc, aecWasmOptions, type AecMode } from '../../../../packages/voice-core/src/aec-mode'
import { INPUT_RATE, VAD_FRAME_SAMPLES, type EndpointConfig, type InterruptionConfig } from '../../../../packages/voice-core/src/input-config'
import { BargeInDetector, type CaptureAudio, type VadFrame } from './barge-in'
import { FrameQueue } from './frame-queue'

type AecStats = {
  frames: number; referenceFrames: number; delayMs: number | null; erleDb: number | null
  errors: number; rawRms: number; referenceRms: number; residualRms: number; latencyMs: number
  referenceDropped: number; referenceShort: number
}
type CaptureMessage = (CaptureAudio & { type: 'frame' }) | (AecStats & { type: 'stats' }) | { type: 'error'; message: string }
type Options = {
  context: AudioContext
  aecMode: AecMode
  referenceOutput: AudioNode
  playbackGeneration: (contextFrameEnd: number) => number | undefined
  interruption: InterruptionConfig
  endpoint: EndpointConfig
  getStream: () => Promise<MediaStream>
  onFrameProcessed: (frame: VadFrame) => void
  onAecStats?: (stats: AecStats) => void
  onError: (error: unknown) => void
}

/** Owns the capture graph and serializes Silero inference on synchronized frames. */
export class FrameVAD {
  private node: AudioWorkletNode | null = null
  private referenceConnected = false
  private source: MediaStreamAudioSourceNode | null = null
  private stream: MediaStream | null = null
  private queue: FrameQueue<{ audio: CaptureAudio; generation?: number }>
  private closed = false

  private constructor(private model: Awaited<ReturnType<typeof Silero.new>>, private options: Options) {
    const detector = new BargeInDetector(options.interruption, options.endpoint)
    const infer = async (samples: Float32Array) => (await this.model.process(samples)).isSpeech
    this.queue = new FrameQueue(async ({ audio, generation }) => {
      const frames = await detector.process(audio, generation, infer)
      if (!this.closed) for (const frame of frames) options.onFrameProcessed(frame)
    }, error => {
      this.stream?.getTracks().forEach(track => track.stop())
      options.onError(error)
    })
  }

  static async new(options: Options): Promise<FrameVAD> {
    const { context, aecMode } = options
    if (context.sampleRate !== 48000) throw new Error('语音采集需要 48 kHz AudioContext')
    ort.env.wasm.wasmPaths = new URL('./vad/', document.baseURI).href
    ort.env.wasm.numThreads = 1
    ort.env.wasm.proxy = false
    ort.env.logLevel = 'error'
    const model = await Silero.new(ort, async () => {
      const response = await fetch(new URL('./vad/silero_vad_v5.onnx', document.baseURI))
      if (!response.ok) throw new Error('Silero VAD 模型资源加载失败')
      return response.arrayBuffer()
    })
    const vad = new FrameVAD(model, options)
    try {
      let module: WebAssembly.Module | undefined
      if (aecUsesWebRtc(aecMode)) {
        const response = await fetch(new URL('./worklets/webrtc-audio-processing.wasm', document.baseURI))
        if (!response.ok) throw new Error('WebRTC AEC 模块资源加载失败')
        module = await WebAssembly.compile(await response.arrayBuffer())
      }
      await context.audioWorklet.addModule(new URL('./worklets/voice-capture.js', document.baseURI))
      const node = vad.node = new AudioWorkletNode(context, 'deskai-voice-capture', {
        numberOfInputs: 2, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
        processorOptions: { inputRate: INPUT_RATE, frameSamples: VAD_FRAME_SAMPLES, module, ...aecWasmOptions(aecMode) },
      })
      node.port.onmessage = ({ data }: MessageEvent<CaptureMessage>) => {
        if (vad.closed) return
        if (data.type === 'error') options.onError(new Error(data.message))
        else if (data.type === 'stats') options.onAecStats?.(data)
        else vad.queue.push({ audio: data, generation: options.playbackGeneration(data.contextFrameEnd) })
      }
      node.onprocessorerror = () => options.onError(new Error('麦克风 AudioWorklet 失败，请重新开始会话'))
      vad.stream = await options.getStream()
      vad.source = context.createMediaStreamSource(vad.stream)
      options.referenceOutput.connect(node, 0, 1)
      vad.referenceConnected = true
      vad.source.connect(node)
      node.connect(context.destination)
      return vad
    } catch (error) { await vad.destroy(); throw error }
  }

  async destroy(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stream?.getTracks().forEach(track => track.stop())
    this.source?.disconnect()
    if (this.node && this.referenceConnected) this.options.referenceOutput.disconnect(this.node)
    this.node?.disconnect()
    this.node?.port.close()
    await this.queue.close()
    await this.model.release()
  }
}
