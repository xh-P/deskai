import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { prepareChatPatch } from './chat-patch.ts';

export type Preparation = { phase: string; completedBytes?: number; totalBytes?: number; resource?: string };
export type SpeechCatalog = {
  providers: { id: string; name: string; location: string; languages: string[]; preparation: Preparation }[];
  selection: { providerId: string; language: string };
  maxAudioBytes: number;
  maxDurationSeconds: number;
};
export type SpeechStatus = { state: 'starting' | 'preparing' | 'ready' | 'error' | 'stopped'; phase?: string; completedBytes?: number; totalBytes?: number; code?: string };

/** Owns a separate dsh Web profile, never modifies the user's original entry. */
export class LocalDshSpeech {
  private readonly root: string;
  private readonly onStatus: (status: SpeechStatus) => void;
  private child?: ChildProcess;
  private socket?: WebSocket;
  private host = '';
  private cookie = '';
  private providerId = '';
  private catalog?: SpeechCatalog;
  private starting?: Promise<SpeechCatalog>;
  private readyWaiters = new Set<() => void>();
  private lifetime = new AbortController();
  private stopped = false;
  private disposing?: Promise<void>;

  constructor(root: string, onStatus: (status: SpeechStatus) => void = () => {}) {
    this.root = root;
    this.onStatus = onStatus;
  }

  start(): Promise<SpeechCatalog> {
    if (this.stopped || this.lifetime.signal.aborted) return Promise.reject(new Error('SPEECH_SERVICE_STOPPED'));
    return this.starting ??= this.initialize().catch(async (error) => {
      if (!this.stopped) this.onStatus({ state: 'error', code: error instanceof Error ? error.message : 'SPEECH_START_FAILED' });
      await this.dispose();
      throw error;
    });
  }

  private async initialize(): Promise<SpeechCatalog> {
    this.onStatus({ state: 'starting' });
    const nodeExecutable = process.env.DESKAI_NODE_EXECUTABLE ?? (process.versions.electron ? undefined : process.execPath);
    if (!nodeExecutable) throw new Error('STANDALONE_NODE_REQUIRED');
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const profileDir = path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'profiles/deskai2-voice-m1');
    const chatPatch = await prepareChatPatch(this.root);
    let initialize: string[] = [];
    try { await access(profileDir); } catch { initialize = ['--from-default-profile', 'web']; }
    this.lifetime.signal.throwIfAborted();
    const child = spawn(nodeExecutable, [path.join(this.root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      '--profile', 'deskai2-voice-m1', ...initialize, '--patch',
      path.join(this.root, 'config/voice/dsh-m0.patch.yml'), '--patch', chatPatch, '--port', '0', '--no-open'], {
      cwd: this.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv
    });
    this.child = child;
    // Capture only long enough to consume the one-time link; never log or persist it.
    const token = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      const timeout = setTimeout(() => finish(new Error('DSH_START_TIMEOUT')), 90_000);
      const finish = (error?: Error, value?: string) => {
        clearTimeout(timeout);
        child.stdout?.off('data', ingest); child.stderr?.off('data', ingest);
        child.off('error', onError); child.off('exit', onExit);
        buffer = '';
        if (error) reject(error); else resolve(value!);
      };
      const onError = () => finish(new Error('DSH_SPAWN_FAILED'));
      const onExit = () => finish(new Error('DSH_EXITED_DURING_START'));
      const ingest = (chunk: Buffer) => {
        buffer = (buffer + chunk.toString('utf8')).slice(-64_000);
        const match = buffer.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?\?token=[^\s'"<>]+/);
        if (!match) return;
        const url = new URL(match[0].replace(/[),.;]+$/, ''));
        this.host = url.origin;
        finish(undefined, url.searchParams.get('token')!);
      };
      child.stdout?.on('data', ingest); child.stderr?.on('data', ingest);
      child.once('error', onError); child.once('exit', onExit);
    });
    this.lifetime.signal.throwIfAborted();
    child.stdout?.resume(); child.stderr?.resume();
    child.on('exit', () => {
      if (!this.stopped) {
        this.lifetime.abort();
        this.onStatus({ state: 'error', code: 'DSH_EXITED' });
        for (const notify of this.readyWaiters) notify();
      }
    });
    const response = await fetch(`${this.host}/connect?token=${encodeURIComponent(token)}&interactions=none`,
      { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    this.cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    if (response.status !== 302 || !this.cookie) throw new Error('DSH_AUTH_FAILED');
    const catalog = await this.call<SpeechCatalog>('speech/catalog', {});
    this.lifetime.signal.throwIfAborted();
    const provider = catalog.providers.find((row) => row.location === 'host-local' && /sensevoice/i.test(row.id + row.name));
    if (!provider) throw new Error('LOCAL_SENSEVOICE_NOT_REGISTERED');
    this.providerId = provider.id;
    this.catalog = catalog;
    this.socket = new WebSocket(this.host.replace(/^http/, 'ws') + '/api/remote.mux', {
      headers: { Cookie: this.cookie }, maxPayload: 2 * 1024 * 1024
    });
    const socket = this.socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DSH_FOLLOW_TIMEOUT')), 15_000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('DSH_FOLLOW_FAILED')); });
    });
    const streamId = randomUUID();
    socket.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.streamId !== streamId || frame.type !== 'item') return;
        this.catalog = frame.value as SpeechCatalog;
        const state = this.catalog.providers.find((row) => row.id === this.providerId)?.preparation;
        if (state) this.onStatus({ state: ['ready', 'standby'].includes(state.phase) ? 'ready' : 'preparing',
          phase: state.phase, completedBytes: state.completedBytes, totalBytes: state.totalBytes });
        for (const notify of this.readyWaiters) notify();
      } catch { this.onStatus({ state: 'error', code: 'INVALID_SPEECH_STATUS' }); }
    });
    socket.on('error', () => this.onStatus({ state: 'error', code: 'DSH_FOLLOW_DISCONNECTED' }));
    socket.on('close', () => {
      if (!this.stopped) {
        this.lifetime.abort();
        this.onStatus({ state: 'error', code: 'DSH_FOLLOW_DISCONNECTED' });
        for (const notify of this.readyWaiters) notify();
      }
    });
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'speech/follow', payload: { args: {} } }));
    await this.call('speech/prepare', { providerId: this.providerId });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { dispose(); reject(new Error('SENSEVOICE_PREPARATION_TIMEOUT')); }, 15 * 60_000);
      const dispose = () => { clearTimeout(timeout); this.readyWaiters.delete(inspect); };
      const inspect = () => {
        const state = this.catalog?.providers.find((row) => row.id === this.providerId)?.preparation;
        if (this.lifetime.signal.aborted) { dispose(); reject(new Error('SPEECH_SERVICE_DISCONNECTED')); }
        else if (state && ['ready', 'standby'].includes(state.phase)) { dispose(); resolve(); }
        else if (state && ['failed', 'cancelled'].includes(state.phase)) { dispose(); reject(new Error('SENSEVOICE_PREPARATION_FAILED')); }
      };
      this.readyWaiters.add(inspect); inspect();
    });
    this.onStatus({ state: 'ready' });
    return this.catalog!;
  }

  private async call<T>(endpoint: string, args: object, signal?: AbortSignal): Promise<T> {
    const rpcId = randomUUID();
    const response = await fetch(`${this.host}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', Cookie: this.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(180_000), ...(signal ? [signal] : [])])
    });
    if (!response.ok) throw new Error(`DSH_HTTP_${response.status}`);
    const body = await response.json() as { rpcId: string; result: { ok: boolean; value?: T; error?: { code?: string } } };
    if (body.rpcId !== rpcId) throw new Error('DSH_RPC_ID_MISMATCH');
    if (!body.result?.ok) throw new Error(body.result?.error?.code ?? 'SPEECH_RPC_FAILED');
    return body.result.value as T;
  }

  /** Authenticated RPC on this service's owned Host; prompt receipts are not completion. */
  async sessionCall<T>(endpoint: string, request: object, signal?: AbortSignal): Promise<T> {
    await this.start();
    if (this.lifetime.signal.aborted) throw new Error('DSH_SERVICE_DISCONNECTED');
    return this.call<T>(endpoint, { request }, signal);
  }

  /** A Mux follow is independent of, but shares authentication with, speech/follow. */
  async sessionFollow(request: object, onFrame: (frame: unknown) => void): Promise<() => void> {
    await this.start();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('DSH_FOLLOW_DISCONNECTED');
    const streamId = randomUUID();
    let closed = false;
    const receive = (raw: WebSocket.RawData) => {
      try {
        const frame = JSON.parse(raw.toString()) as { streamId?: string };
        if (frame.streamId === streamId) onFrame(frame);
      } catch { onFrame({ type: 'error', streamId, error: { code: 'INVALID_DSH_MUX_FRAME' } }); }
    };
    const disconnected = () => onFrame({ type: 'error', streamId, error: { code: 'DSH_FOLLOW_DISCONNECTED' } });
    socket.on('message', receive);
    socket.on('close', disconnected);
    socket.on('error', disconnected);
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request } } }));
    return () => {
      if (closed) return;
      closed = true;
      socket.off('message', receive);
      socket.off('close', disconnected);
      socket.off('error', disconnected);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId }));
    };
  }

  async transcribe(wav: Uint8Array, signal: AbortSignal): Promise<{ text: string; audioSeconds: number; inferenceSeconds: number }> {
    signal.throwIfAborted();
    if (!this.catalog || this.lifetime.signal.aborted) throw new Error('SPEECH_NOT_READY');
    if (wav.byteLength > this.catalog.maxAudioBytes) throw new Error('SPEECH_WAV_TOO_LARGE');
    const result = await this.call<{ text: string; audioSeconds: number; inferenceSeconds: number }>('speech/transcribe',
      { request: { audioBase64: Buffer.from(wav).toString('base64'), providerId: this.providerId, language: 'auto' } }, signal);
    signal.throwIfAborted();
    if (typeof result.text !== 'string') throw new Error('INVALID_TRANSCRIPT');
    return result;
  }

  async dispose(): Promise<void> {
    return this.disposing ??= this.disposeOwned();
  }

  private async disposeOwned(): Promise<void> {
    this.stopped = true;
    this.lifetime.abort();
    for (const notify of this.readyWaiters) notify();
    this.socket?.close();
    this.cookie = '';
    const child = this.child;
    if (child?.pid && child.exitCode === null) {
      if (process.platform === 'win32') {
        // PID is the exact child created above; terminate its workers as one owned tree.
        await new Promise<void>((resolve) => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('exit', () => resolve()); killer.once('error', () => { child.kill(); resolve(); });
        });
      } else child.kill('SIGTERM');
    }
    this.onStatus({ state: 'stopped' });
  }
}
