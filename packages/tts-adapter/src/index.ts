import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

export type VoiceInfo = { id: string; name: string; version: 'v2'; defaultReferenceId: string; references: { id: string; name: string }[] };
export type VoiceSelection = { voiceId: string; referenceId: string; voiceRevision: number };
export type TtsStatus = { state: 'starting' | 'loading' | 'warming' | 'switching' | 'ready' | 'error' | 'stopped'; code?: string } & Partial<VoiceSelection>;
export type SynthesisRequest = VoiceSelection & { sessionId: string; turnId: string; generationId: number; segmentId: string;
  text: string; language: 'all_zh' | 'all_ja' | 'en'; speed?: number };
export type PCMChunk = Omit<SynthesisRequest, 'text' | 'language' | 'speed'> & { requestId: string; chunkSeq: number;
  sampleRate: number; channels: 1; format: 'pcm_s16le'; samples: number; pcm: Uint8Array };
export type SynthesisResult = { chunks: number; samples: number; canceled: boolean; elapsedSeconds?: number; firstPCMSeconds?: number };
type Frame = Record<string, unknown>;
type Pending = { resolve: (frame: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; terminal: string[] };
const identities = ['sessionId', 'turnId', 'generationId', 'voiceRevision', 'segmentId', 'voiceId', 'referenceId'] as const;
const safeInt = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128;

export function validateRequest(request: SynthesisRequest): void {
  if (!['sessionId', 'turnId', 'segmentId', 'voiceId', 'referenceId'].every((key) => identifier(request[key as keyof SynthesisRequest])) ||
      !safeInt(request.generationId) || !safeInt(request.voiceRevision) || typeof request.text !== 'string' ||
      !request.text.trim() || request.text.trim().length > 600 || !['all_zh', 'all_ja', 'en'].includes(request.language) ||
      (request.speed !== undefined && (!Number.isFinite(request.speed) || request.speed < 0.5 || request.speed > 2))) throw new Error('INVALID_TTS_REQUEST');
}

/** Validate before exposing any audio; header length and payload are independently bounded. */
export function decodePCMFrame(raw: Uint8Array, requestId: string, expected: SynthesisRequest, sequence: number): PCMChunk {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (bytes.length < 4) throw new Error('INVALID_TTS_PCM');
  const length = bytes.readUInt32LE(0);
  if (length < 2 || length > 8192 || length + 4 > bytes.length) throw new Error('INVALID_TTS_PCM');
  let header: Frame;
  try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + length))) as Frame; }
  catch { throw new Error('INVALID_TTS_PCM'); }
  if (!header || typeof header !== 'object' || header.v !== 1 || header.event !== 'audio.chunk' || header.requestId !== requestId ||
      !identities.every((key) => header[key] === expected[key]) || header.chunkSeq !== sequence ||
      ![32000, 48000].includes(header.sampleRate as number) || header.channels !== 1 || header.format !== 'pcm_s16le' ||
      !safeInt(header.samples) || (header.samples as number) < 1 || (header.samples as number) > (header.sampleRate as number) * 30 ||
      bytes.length - 4 - length !== (header.samples as number) * 2) throw new Error('INVALID_TTS_PCM');
  return { ...header, pcm: Uint8Array.from(bytes.subarray(4 + length)) } as PCMChunk;
}

function parseRegistry(value: unknown): VoiceInfo[] {
  if (!Array.isArray(value) || value.length !== 10) throw new Error('INVALID_TTS_REGISTRY');
  const ids = new Set<string>();
  for (const row of value) {
    if (!row || !identifier(row.id) || ids.has(row.id) || typeof row.name !== 'string' || row.version !== 'v2' ||
        !Array.isArray(row.references) || !row.references.length || row.references.length > 100 ||
        row.references.some((r: { id?: unknown; name?: unknown }) => !r || !identifier(r.id) || typeof r.name !== 'string') ||
        new Set(row.references.map((r: { id: string }) => r.id)).size !== row.references.length ||
        !row.references.some((r: { id: string }) => r.id === row.defaultReferenceId)) throw new Error('INVALID_TTS_REGISTRY');
    ids.add(row.id);
  }
  if (!ids.has('nagato-normal-v2')) throw new Error('INVALID_TTS_REGISTRY');
  return value as VoiceInfo[];
}

/** A private authenticated worker per adapter. It never attaches to or kills an external service. */
export class LocalTtsService {
  private readonly root: string;
  private readonly onStatus: (status: TtsStatus) => void;
  private child?: ChildProcess;
  private socket?: WebSocket;
  private starting?: Promise<VoiceInfo[]>;
  private disposing?: Promise<void>;
  private stopped = false;
  private catalog: VoiceInfo[] = [];
  private current: TtsStatus = { state: 'stopped' };
  private pending = new Map<string, Pending>();
  private active?: { id: string; request: SynthesisRequest; canceled: boolean; chunks: number; samples: number;
    onPCM: (chunk: PCMChunk) => void; settled: Promise<Frame> };
  private switching?: Promise<VoiceSelection>;

  constructor(root: string, onStatus: (status: TtsStatus) => void = () => {}) { this.root = root; this.onStatus = onStatus; }
  getStatus(): TtsStatus { return { ...this.current }; }
  registry(): VoiceInfo[] { return structuredClone(this.catalog); }
  private status(status: TtsStatus): void { this.current = status; this.onStatus({ ...status }); }
  private update(frame: Frame): void {
    if (!['loading', 'warming', 'switching', 'ready', 'error'].includes(frame.state as string)) throw new Error('INVALID_TTS_STATUS');
    if (['ready', 'switching'].includes(frame.state as string) &&
        (!identifier(frame.voiceId) || !identifier(frame.referenceId) || !safeInt(frame.voiceRevision))) throw new Error('INVALID_TTS_STATUS');
    this.status({ state: frame.state as TtsStatus['state'], voiceId: frame.voiceId as string,
      referenceId: frame.referenceId as string, voiceRevision: frame.voiceRevision as number,
      ...(typeof frame.error === 'string' ? { code: frame.error } : {}) });
  }
  start(): Promise<VoiceInfo[]> {
    if (this.stopped) return Promise.reject(new Error('TTS_STOPPED'));
    return this.starting ??= this.initialize().catch(async (error: unknown) => {
      if (!this.stopped) this.status({ state: 'error', code: error instanceof Error ? error.message : 'TTS_START_FAILED' });
      await this.dispose(); throw error;
    });
  }
  private async initialize(): Promise<VoiceInfo[]> {
    this.status({ state: 'starting' });
    const assetRoot = path.resolve(process.env.DESKAI_ASSET_ROOT ?? this.root);
    const python = process.env.DESKAI_TTS_PYTHON ?? path.join(assetRoot, '.conda/gsv-v5/python.exe');
    const worker = path.join(this.root, 'services/tts/worker.py');
    await Promise.all([access(python), access(worker)]);
    const stateDir = path.join(this.root, '.cache/desktop-voice/tts');
    await mkdir(stateDir, { recursive: true });
    if (this.stopped) throw new Error('TTS_STOPPED');
    const token = randomBytes(32).toString('hex');
    const child = spawn(python, ['-u', worker, '--state-dir', stateDir], { cwd: this.root, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DESKAI_ASSET_ROOT: assetRoot,
        DESKAI_TTS_TOKEN: token, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    this.child = child;
    // Third party logs may contain supplied text: drain without logging or persisting.
    child.stderr?.resume();
    const endpoint = await new Promise<{ host: string; port: number }>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => finish(new Error('TTS_START_TIMEOUT')), 20_000);
      const finish = (error?: Error, value?: { host: string; port: number }) => {
        clearTimeout(timer); child.stdout?.off('data', ingest); child.off('error', failed); child.off('exit', exited);
        if (error) reject(error); else resolve(value!);
      };
      const failed = () => finish(new Error('TTS_SPAWN_FAILED'));
      const exited = () => finish(new Error('TTS_EXITED_DURING_START'));
      const ingest = (data: Buffer) => {
        buffer += data.toString('utf8');
        if (buffer.length > 4096) return finish(new Error('INVALID_TTS_ENDPOINT'));
        const end = buffer.indexOf('\n'); if (end < 0) return;
        try {
          const frame = JSON.parse(buffer.slice(0, end));
          if (frame.v !== 1 || frame.event !== 'listening' || frame.host !== '127.0.0.1' ||
              !Number.isInteger(frame.port) || frame.port < 1 || frame.port > 65535) throw new Error();
          finish(undefined, frame);
        } catch { finish(new Error('INVALID_TTS_ENDPOINT')); }
      };
      child.stdout?.on('data', ingest); child.once('error', failed); child.once('exit', exited);
    });
    child.stdout?.resume();
    child.on('exit', () => { if (!this.stopped) this.fail(new Error('TTS_EXITED')); });
    if (this.stopped || child.exitCode !== null) throw new Error('TTS_STOPPED');
    const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}`, { maxPayload: 4 * 1024 * 1024, handshakeTimeout: 10_000 });
    this.socket = socket;
    socket.on('error', () => { if (!this.stopped) this.fail(new Error('TTS_DISCONNECTED')); });
    socket.on('close', () => { if (!this.stopped) this.fail(new Error('TTS_DISCONNECTED')); });
    const authenticated = this.waitFor('authentication', ['authenticated'], 10_000);
    socket.on('message', (raw, binary) => this.receive(raw, binary));
    socket.once('open', () => socket.send(JSON.stringify({ v: 1, token })));
    this.update(await authenticated);
    const deadline = Date.now() + 240_000;
    while (this.current.state !== 'ready') {
      if (this.current.state === 'error') throw new Error(this.current.code ?? 'TTS_LOAD_FAILED');
      if (Date.now() > deadline) throw new Error('TTS_LOAD_TIMEOUT');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (this.stopped) throw new Error('TTS_STOPPED');
      this.update(await this.call('status', {}, ['status'], 10_000));
    }
    this.catalog = parseRegistry((await this.call('registry', {}, ['registry'], 10_000)).voices);
    return this.registry();
  }
  private waitFor(id: string, terminal: string[], timeout: number): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('TTS_REQUEST_TIMEOUT')); this.fail(new Error('TTS_REQUEST_TIMEOUT')); }, timeout);
      this.pending.set(id, { resolve, reject, timer, terminal });
    });
  }
  private call(op: string, payload: object, terminal: string[], timeout = 120_000): Promise<Frame> {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('TTS_DISCONNECTED'));
    const id = randomUUID();
    const waiting = this.waitFor(id, terminal, timeout);
    this.send({ v: 1, op, requestId: id, ...payload });
    return waiting;
  }
  private send(frame: object): void {
    if (this.socket?.readyState !== WebSocket.OPEN) { this.fail(new Error('TTS_DISCONNECTED')); return; }
    this.socket.send(JSON.stringify(frame));
  }
  private receive(raw: WebSocket.RawData, binary: boolean): void {
    if (this.stopped) return;
    try {
      if (binary) {
        const active = this.active;
        if (!active || active.canceled) return;
        const buffer = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
        const chunk = decodePCMFrame(buffer, active.id, active.request, active.chunks);
        active.chunks++; active.samples += chunk.samples;
        if (active.samples > chunk.sampleRate * 30) throw new Error('INVALID_TTS_PCM');
        active.onPCM(chunk); return;
      }
      const frame = JSON.parse(raw.toString()) as Frame;
      if (!frame || frame.v !== 1 || typeof frame.event !== 'string') throw new Error('INVALID_TTS_FRAME');
      if (frame.event === 'voice.switching') this.update(frame);
      const id = frame.event === 'authenticated' ? 'authentication' : frame.requestId as string;
      const pending = this.pending.get(id);
      if (!pending) return;
      const failed = ['rejected', 'synthesis.failed', 'voice.failed'].includes(frame.event);
      if (!failed && !pending.terminal.includes(frame.event)) return;
      clearTimeout(pending.timer); this.pending.delete(id);
      if (frame.event === 'voice.failed') this.update(frame);
      if (failed) pending.reject(new Error(typeof frame.code === 'string' ? frame.code : 'TTS_FAILED'));
      else pending.resolve(frame);
    } catch (error) { this.fail(error instanceof Error ? error : new Error('INVALID_TTS_FRAME')); }
  }
  private fail(error: Error): void {
    if (this.stopped) return;
    this.status({ ...this.current, state: 'error', code: error.message });
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    void this.dispose();
  }
  selectVoice(voiceId: string, referenceId?: string): Promise<VoiceSelection> {
    if (this.switching) return Promise.reject(new Error('TTS_SWITCH_BUSY'));
    return this.switching = this.select(voiceId, referenceId).finally(() => { this.switching = undefined; });
  }
  private async select(voiceId: string, referenceId?: string): Promise<VoiceSelection> {
    await this.start();
    const voice = this.catalog.find((v) => v.id === voiceId);
    const ref = referenceId ?? voice?.defaultReferenceId;
    if (!voice || !voice.references.some((r) => r.id === ref)) throw new Error('UNKNOWN_TTS_VOICE_OR_REFERENCE');
    await this.cancel();
    const result = await this.call('selectVoice', { voiceId, referenceId: ref }, ['voice.selected'], 240_000);
    this.update(result);
    if (result.voiceId !== voiceId || result.referenceId !== ref || !safeInt(result.voiceRevision)) throw new Error('INVALID_TTS_SELECTION');
    return { voiceId, referenceId: ref!, voiceRevision: result.voiceRevision as number };
  }
  async synthesize(request: SynthesisRequest, onPCM: (chunk: PCMChunk) => void, signal?: AbortSignal): Promise<SynthesisResult> {
    signal?.throwIfAborted(); await this.start(); signal?.throwIfAborted(); validateRequest(request);
    if (this.switching || this.active) throw new Error('TTS_BUSY');
    if (identities.filter((key) => ['voiceId', 'referenceId', 'voiceRevision'].includes(key)).some((key) => request[key] !== this.current[key as keyof TtsStatus])) throw new Error('STALE_VOICE_SELECTION');
    const id = randomUUID();
    const settled = this.waitFor(id, ['synthesis.completed'], 120_000);
    const active = { id, request: { ...request }, canceled: false, chunks: 0, samples: 0, onPCM, settled };
    this.active = active;
    const aborted = () => { void this.cancel().catch(() => {}); };
    signal?.addEventListener('abort', aborted, { once: true });
    this.send({ v: 1, op: 'synthesize', requestId: id, ...request });
    try {
      const result = await settled;
      if (signal?.aborted) signal.throwIfAborted();
      if (!identities.slice(0, 5).every((key) => result[key] === request[key]) || !safeInt(result.chunks) || !safeInt(result.samples) ||
          typeof result.canceled !== 'boolean' || (!active.canceled && (!active.chunks || result.chunks !== active.chunks || result.samples !== active.samples))) {
        this.fail(new Error('INVALID_TTS_COMPLETION')); throw new Error('INVALID_TTS_COMPLETION');
      }
      return { chunks: result.chunks as number, samples: result.samples as number, canceled: active.canceled || result.canceled,
        elapsedSeconds: result.elapsedSeconds as number | undefined, firstPCMSeconds: result.firstPCMSeconds as number | undefined };
    } finally { signal?.removeEventListener('abort', aborted); if (this.active === active) this.active = undefined; }
  }
  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (!active.canceled) {
      active.canceled = true; // suppress all PCM before the cancel handshake
      await this.call('cancel', { targetRequestId: active.id }, ['cancel.accepted'], 10_000);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([active.settled.catch(() => {}), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { const error = new Error('TTS_CANCEL_TIMEOUT'); this.fail(error); reject(error); }, 15_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  dispose(): Promise<void> { return this.disposing ??= this.disposeOwned(); }
  private async disposeOwned(): Promise<void> {
    this.stopped = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('TTS_STOPPED')); }
    this.pending.clear();
    this.socket?.terminate();
    const child = this.child;
    if (child?.pid && child.exitCode === null) {
      if (process.platform === 'win32') await new Promise<void>((resolve) => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
        const done = () => { clearTimeout(timer); resolve(); };
        killer.once('exit', done); killer.once('error', () => { child.kill(); done(); });
      });
      else child.kill('SIGTERM');
    }
    if (this.current.state !== 'error') this.status({ state: 'stopped' });
  }
}
