import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { QwenAsrDiagnostics } from '../../../packages/voice-core/src/diagnostics.ts';

export type QwenInferenceOptions = { engine: 'official' | 'cuda_graph'; flashAttention: boolean; graphCapacity: number };
type Options = { python?: string; model?: string; device?: string; inference?: QwenInferenceOptions };

/** Lazily starts one local ASR worker; no network listener or credentials. */
export class LocalQwenSpeech {
  private child?: ChildProcessWithoutNullStreams;
  private readiness?: Promise<void>;
  private nextId = 0;
  private pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();
  private runtime?: QwenAsrDiagnostics;
  constructor(privateRoot: string, options: Options = {}) {
    this.root = privateRoot; this.options = options;
  }
  private readonly root: string;
  private readonly options: Options;
  prepare(): Promise<void> { if (!this.child) this.start(); return this.readiness!; }
  diagnostics(): QwenAsrDiagnostics | undefined { return this.runtime; }
  async transcribe(wav: Uint8Array, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    await this.prepare();
    signal.throwIfAborted();
    const child = this.child!;
    const id = ++this.nextId;
    return new Promise<string>((resolve, reject) => {
      const abort = () => { this.pending.delete(id); reject(signal.reason); };
      this.pending.set(id, { resolve: text => { signal.removeEventListener('abort', abort); resolve(text); }, reject: error => { signal.removeEventListener('abort', abort); reject(error); } });
      signal.addEventListener('abort', abort, { once: true });
      child.stdin.write(JSON.stringify({ id, wav: Buffer.from(wav).toString('base64') }) + '\n', error => {
        if (error) { this.pending.get(id)?.reject(new Error('QWEN_ASR_WORKER_WRITE_FAILED')); this.pending.delete(id); }
      });
    });
  }
  dispose(): void { this.child?.kill(); this.child = undefined; this.runtime = undefined; this.failAll(); }
  private failAll(): void { for (const item of this.pending.values()) item.reject(new Error('QWEN_ASR_WORKER_STOPPED')); this.pending.clear(); }
  private start(): ChildProcessWithoutNullStreams {
    const python = this.options.python ?? path.join(process.env.DESKAI_ASSET_ROOT ?? this.root, '.conda/qwen-asr/Scripts/python.exe');
    const child = spawn(python, [path.join(this.root, 'services/asr/qwen_worker.py')], {
      cwd: this.root, windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
        ...(this.options.model ? { DESKAI_QWEN_MODEL: this.options.model } : {}),
        ...(this.options.device ? { DESKAI_QWEN_DEVICE: this.options.device } : {}),
        ...(this.options.inference ? { DESKAI_QWEN_INFERENCE: JSON.stringify(this.options.inference) } : {}) },
    });
    this.child = child;
    child.stderr.resume();
    child.stdin.on('error', () => {});
    let ready: () => void = () => {};
    let rejectReady: (error: Error) => void = () => {};
    this.readiness = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
    createInterface({ input: child.stdout }).on('line', line => {
      if (this.child !== child) return;
      try {
        const message = JSON.parse(line) as { id: number; text?: string; error?: string; ready?: boolean;
          startupError?: string; runtime?: QwenAsrDiagnostics['startup']; metrics?: QwenAsrDiagnostics['latest'] };
        if (message.startupError) { rejectReady(new Error(message.startupError)); return; }
        if (message.ready && message.runtime) { this.runtime = { startup: message.runtime }; ready(); return; }
        const item = this.pending.get(message.id); if (!item) return;
        this.pending.delete(message.id);
        if (typeof message.text === 'string') {
          if (this.runtime) this.runtime.latest = message.metrics;
          item.resolve(message.text);
        } else item.reject(new Error(message.error ?? 'QWEN_ASR_INVALID_RESPONSE'));
      } catch { /* Non-protocol output cannot settle a request. */ }
    });
    const stopped = () => {
      rejectReady(new Error('QWEN_ASR_WORKER_STOPPED'));
      if (this.child === child) { this.child = undefined; this.readiness = undefined; this.runtime = undefined; this.failAll(); }
    };
    child.on('error', stopped); child.on('exit', stopped);
    return child;
  }
}
