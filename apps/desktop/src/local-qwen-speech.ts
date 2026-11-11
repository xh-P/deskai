import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { QwenAsrDiagnostics } from '../../../packages/voice-core/src/diagnostics.ts';

export type QwenInferenceOptions = { engine: 'official' | 'cuda_graph'; flashAttention: boolean; graphCapacity: number };
export type QwenWorkerConfig = {
  python: string; model: string; device: string; inference: QwenInferenceOptions;
  startupTimeoutMs: number; requestTimeoutMs: number;
};
type Worker = {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  rejectReady: (error: Error) => void;
  pending: Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>;
};

/** Lazily starts one local ASR worker; no network listener or credentials. */
export class LocalQwenSpeech {
  private worker?: Worker;
  private nextId = 0;
  private runtime?: QwenAsrDiagnostics;
  constructor(root: string, options: QwenWorkerConfig) {
    this.root = root; this.options = options;
  }
  private readonly root: string;
  private readonly options: QwenWorkerConfig;
  prepare(): Promise<void> { return (this.worker ?? this.start()).ready; }
  diagnostics(): QwenAsrDiagnostics | undefined { return this.runtime; }
  async transcribe(wav: Uint8Array, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const worker = this.worker ?? this.start();
    await worker.ready;
    signal.throwIfAborted();
    if (this.worker !== worker) throw new Error('QWEN_ASR_WORKER_STOPPED');
    const id = ++this.nextId;
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.pending.delete(id);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => this.stop(worker, 'QWEN_ASR_INFERENCE_TIMEOUT'), this.options.requestTimeoutMs);
      worker.pending.set(id, {
        resolve: text => { cleanup(); resolve(text); },
        reject: error => { cleanup(); reject(error); },
      });
      signal.addEventListener('abort', abort, { once: true });
      worker.child.stdin.write(JSON.stringify({ id, wav: Buffer.from(wav).toString('base64') }) + '\n');
    });
  }
  dispose(): void { if (this.worker) this.stop(this.worker, 'QWEN_ASR_WORKER_STOPPED'); }

  private stop(worker: Worker, code: string): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.runtime = undefined;
    const error = new Error(code);
    worker.rejectReady(error);
    for (const item of worker.pending.values()) item.reject(error);
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
  }

  private start(): Worker {
    const { model, device, inference, startupTimeoutMs } = this.options;
    const python = path.resolve(process.env.DESKAI_ASSET_ROOT ?? this.root, this.options.python);
    const child = spawn(python, [path.join(this.root, 'services/asr/qwen_worker.py')], {
      cwd: this.root, windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
        DESKAI_QWEN_RUNTIME: JSON.stringify({ model, device, inference }) },
    });
    let resolveReady!: () => void;
    let rejectReady!: Worker['rejectReady'];
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const worker: Worker = { child, ready, rejectReady: error => { clearTimeout(timer); rejectReady(error); }, pending: new Map() };
    const timer = setTimeout(() => this.stop(worker, 'QWEN_ASR_START_TIMEOUT'), startupTimeoutMs);
    this.worker = worker;
    child.stderr.resume();
    child.stdin.on('error', () => this.stop(worker, 'QWEN_ASR_WORKER_WRITE_FAILED'));
    createInterface({ input: child.stdout }).on('line', line => {
      if (this.worker !== worker) return;
      try {
        const message = JSON.parse(line) as { id: number; text?: string; error?: string; ready?: boolean;
          startupError?: string; runtime?: QwenAsrDiagnostics['startup']; metrics?: QwenAsrDiagnostics['latest'] };
        if (message.startupError) { this.stop(worker, message.startupError); return; }
        if (message.ready && message.runtime) {
          clearTimeout(timer);
          this.runtime = { startup: message.runtime };
          resolveReady();
          return;
        }
        const item = worker.pending.get(message.id);
        if (!item) return;
        if (typeof message.text === 'string') {
          if (this.runtime) this.runtime.latest = message.metrics;
          item.resolve(message.text);
        } else item.reject(new Error(message.error ?? 'QWEN_ASR_INVALID_RESPONSE'));
      } catch { this.stop(worker, 'QWEN_ASR_INVALID_RESPONSE'); }
    });
    const stopped = () => this.stop(worker, 'QWEN_ASR_WORKER_STOPPED');
    child.once('error', stopped);
    child.once('close', stopped);
    return worker;
  }
}
