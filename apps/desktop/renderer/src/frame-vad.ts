import * as ort from 'onnxruntime-web/wasm'
import { Silero } from '@ricky0123/vad-web/dist/models/silero'
import type { SpeechProbabilities } from '@ricky0123/vad-web/dist/models/common'
import { FrameQueue } from './frame-queue'

type Options = {
  context: AudioContext
  getStream: () => Promise<MediaStream>
  onFrameProcessed: (probabilities: SpeechProbabilities, frame: Float32Array) => void
  onError: (error: unknown) => void
}

/** Frame-only adapter; intentionally does not instantiate MicVAD's audioBuffer. */
export class FrameVAD {
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private stream: MediaStream | null = null
  private queue: FrameQueue
  private closed = false

  private constructor(private model: Awaited<ReturnType<typeof Silero.new>>, private options: Options) {
    this.queue = new FrameQueue(async frame => {
      const probabilities = await this.model.process(frame)
      if (!this.closed) this.options.onFrameProcessed(probabilities, frame)
    }, error => {
      // Stop acquisition immediately; release the current ONNX call when it settles.
      this.stream?.getTracks().forEach(track => track.stop())
      this.options.onError(error)
    })
  }

  static async new(options: Options): Promise<FrameVAD> {
    ort.env.wasm.wasmPaths = new URL('./vad/', document.baseURI).href
    ort.env.wasm.numThreads = 1
    ort.env.wasm.proxy = false
    ort.env.logLevel = 'error'
    const model = await Silero.new(ort, async () => {
      const response = await fetch(new URL('./vad/silero_vad_v5.onnx', document.baseURI))
      if (!response.ok) throw new Error('Silero VAD模型资源加载失败')
      return response.arrayBuffer()
    })
    const vad = new FrameVAD(model, options)
    try {
      // Initialize worklet before requesting audio so the first speech frames survive.
      await options.context.audioWorklet.addModule(new URL('./vad/vad.worklet.bundle.min.js', document.baseURI))
      vad.node = new AudioWorkletNode(options.context, 'vad-helper-worklet', {
        processorOptions: { frameSamples: 512 }, channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1]
      })
      vad.node.port.onmessage = ({ data }) => {
        if (vad.closed || data?.message !== 'AUDIO_FRAME' || !(data.data instanceof ArrayBuffer)) return
        const frame = new Float32Array(data.data)
        if (frame.length !== 512) { options.onError(new Error('VAD帧长不符合512样本契约')); return }
        vad.queue.push(frame)
      }
      vad.node.onprocessorerror = () => options.onError(new Error('麦克风AudioWorklet失败，请重新开始会话'))
      vad.node.connect(options.context.destination)
      vad.stream = await options.getStream()
      vad.source = options.context.createMediaStreamSource(vad.stream)
      vad.source.connect(vad.node)
      return vad
    } catch (error) { await vad.destroy(); throw error }
  }

  async destroy(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = null
    this.source?.disconnect()
    this.source = null
    this.node?.port.postMessage('SPEECH_STOP')
    this.node?.disconnect()
    this.node?.port.close()
    this.node = null
    await this.queue.close()
    await this.model.release()
  }
}
