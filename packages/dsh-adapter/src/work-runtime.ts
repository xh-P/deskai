import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import WebSocket from 'ws';
import { type DshFollowFrame, type DshWorkTransport, errorMessage, within } from './session-feed.ts';

export type WorkRuntimeStatus = { state: 'stopped' | 'starting' | 'ready' | 'error'; code?: string };
export type WorkWindowConnection = { origin: string; cookie: string };
export type WorkOptions = { profile: string; cwd: string };
type Connection = { origin: string; apiCookie: string; browserCookie: string; pid: number };
type Mux = { socket: WebSocket; streams: Map<string, (frame: DshFollowFrame) => void> };

export async function loadWorkOptions(root: string): Promise<WorkOptions> {
  try {
    const config = JSON.parse(await readFile(path.join(root, 'config/work-runtime.json'), 'utf8'));
    if (typeof config?.profile !== 'string' || !config.profile.trim() || typeof config.workspace !== 'string' || !config.workspace.trim())
      throw new Error('INVALID_WORK_CONFIG');
    return { profile: config.profile.trim(), cwd: path.resolve(root, config.workspace) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profile: 'web', cwd: root };
    throw error;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function authCookie(url: string, expectedStatus: number): Promise<string> {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (response.status !== expectedStatus || !cookie || cookie.indexOf('=') < 1) throw new Error('WORK_AUTH_FAILED');
  return cookie;
}

/** Native dsh process and authenticated transport for the Node Host. */
export class WorkRuntime implements DshWorkTransport {
  private readonly root: string;
  private readonly options: WorkOptions;
  private readonly descriptor: string;
  private readonly changed: () => void;
  private child?: ChildProcess;
  private connection?: Connection;
  private status: WorkRuntimeStatus = { state: 'stopped' };
  private starting?: Promise<WorkRuntimeStatus>;
  private mux?: Mux;
  private openingMux?: Promise<Mux>;
  private disposed = false;

  constructor(root: string, options: WorkOptions, descriptor: string, changed: () => void = () => {}) {
    this.root = root; this.options = options; this.descriptor = descriptor; this.changed = changed;
  }
  getStatus() { return this.status; }
  private setStatus(status: WorkRuntimeStatus) { this.status = status; this.changed(); }

  ensureHost(): Promise<WorkRuntimeStatus> {
    if (this.disposed) return Promise.resolve({ state: 'error', code: 'WORK_STOPPED' });
    if (this.connection && this.status.state === 'ready' && alive(this.connection.pid)) return Promise.resolve(this.status);
    return this.starting ??= this.startHost().finally(() => { this.starting = undefined; });
  }

  private async restore(): Promise<Connection | undefined> {
    let previous: Connection;
    try { previous = JSON.parse(await readFile(this.descriptor, 'utf8')) as Connection; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(previous.origin)) throw new Error('WORK_CONNECTION_INVALID');
    if (!alive(previous.pid)) return undefined;
    try { await this.rpc(previous, 'permissionPresets/catalog', {}, AbortSignal.timeout(5_000)); }
    catch { if (!alive(previous.pid)) return undefined; throw new Error('WORK_NATIVE_PROCESS_UNREACHABLE'); }
    return previous;
  }

  private async startHost(): Promise<WorkRuntimeStatus> {
    this.setStatus({ state: 'starting' });
    this.mux?.socket.close(); this.mux = undefined;
    try {
      this.connection = await this.restore() ?? await this.spawnHost();
      if (this.disposed || !alive(this.connection.pid)) throw new Error('WORK_STOPPED');
      this.setStatus({ state: 'ready' });
    } catch (error) {
      await this.stopChild();
      this.connection = undefined;
      const code = errorMessage(error);
      if (!this.disposed) this.setStatus({ state: 'error', code: /^WORK_[A-Z_]+$/.test(code) ? code : 'WORK_START_FAILED' });
    }
    return this.status;
  }

  private async spawnHost(): Promise<Connection> {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@deepseek-ai/dsh/lib/bin.js', { paths: [this.root] });
    const patch = require.resolve('@deepseek-ai/dsh-experimental-auto-review/cordis.patch.yml', { paths: [this.root] });
    const node = process.env.DESKAI_NODE_EXECUTABLE ?? (process.versions.electron ? undefined : process.execPath);
    if (!node) throw new Error('WORK_NODE_REQUIRED');
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(node, [entry, '--profile', this.options.profile, '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: this.options.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    this.child = child;
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = undefined; this.connection = undefined; this.mux?.socket.close();
      if (!this.disposed) this.setStatus({ state: 'error', code: 'WORK_HOST_EXITED' });
    });
    let buffer = '';
    let ingest!: (chunk: Buffer) => void;
    const launched = new Promise<URL>((resolve, reject) => {
      ingest = chunk => {
        buffer = (buffer + chunk.toString('utf8')).slice(-64_000);
        const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/?\?token=[^\s'"<>]+/);
        if (match) resolve(new URL(match[0].replace(/[),.;]+$/, '')));
      };
      child.stdout?.on('data', ingest); child.stderr?.on('data', ingest);
      child.once('error', () => reject(new Error('WORK_SPAWN_FAILED')));
      child.once('exit', () => reject(new Error('WORK_HOST_EXITED')));
    });
    const launch = await within(launched, 90_000, 'WORK_START_TIMEOUT').finally(() => {
      child.stdout?.off('data', ingest); child.stderr?.off('data', ingest);
      child.stdout?.resume(); child.stderr?.resume();
    });
    if (!child.pid || child.exitCode !== null || this.disposed) throw new Error('WORK_STOPPED');
    const token = encodeURIComponent(launch.searchParams.get('token')!);
    const apiCookie = await authCookie(`${launch.origin}/connect?token=${token}&interactions=none`, 302);
    const browserCookie = await authCookie(`${launch.origin}/?token=${token}`, 303);
    const connection = { origin: launch.origin, apiCookie, browserCookie, pid: child.pid };
    const temp = `${this.descriptor}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(connection), { mode: 0o600, flush: true });
    await rename(temp, this.descriptor);
    return connection;
  }

  private async ready(): Promise<Connection> {
    const status = await this.ensureHost();
    if (status.state !== 'ready' || !this.connection) throw new Error(status.code ?? 'WORK_HOST_UNAVAILABLE');
    return this.connection;
  }

  async windowConnection(): Promise<WorkWindowConnection> {
    const { origin, browserCookie: cookie } = await this.ready();
    return { origin, cookie };
  }

  private async rpc<T>(connection: Connection, endpoint: string, args: object, signal: AbortSignal): Promise<T> {
    const rpcId = randomUUID();
    const response = await fetch(`${connection.origin}/api/${endpoint}`, { method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', Cookie: connection.apiCookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }) });
    if (!response.ok) throw new Error(`WORK_HTTP_${response.status}`);
    const reply = await response.json() as { rpcId: string; result?: { ok: boolean; value?: T; error?: { code?: string } } };
    if (reply.rpcId !== rpcId) throw new Error('WORK_RPC_ID_MISMATCH');
    if (!reply.result?.ok) throw new Error(reply.result?.error?.code ?? 'WORK_RPC_FAILED');
    return reply.result.value as T;
  }

  async call<T>(endpoint: string, args: object, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(180_000);
    return this.rpc<T>(await this.ready(), endpoint, args, signal ? AbortSignal.any([signal, timeout]) : timeout);
  }
  sessionCall<T>(endpoint: string, request: object, signal?: AbortSignal): Promise<T> {
    return this.call<T>(endpoint, { request }, signal);
  }

  private async openMux(connection: Connection): Promise<Mux> {
    if (this.mux?.socket.readyState === WebSocket.OPEN) return this.mux;
    return this.openingMux ??= (async () => {
      const socket = new WebSocket(connection.origin.replace(/^http/, 'ws') + '/api/remote.mux', {
        headers: { Cookie: connection.apiCookie }, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 15_000
      });
      const mux: Mux = { socket, streams: new Map() };
      const failed = () => {
        if (this.mux === mux) this.mux = undefined;
        for (const receive of mux.streams.values()) receive({ type: 'error', error: { code: 'WORK_FOLLOW_CLOSED' } });
        mux.streams.clear();
      };
      socket.on('error', failed); socket.once('close', failed);
      socket.on('message', raw => {
        try {
          const frame = JSON.parse(raw.toString()) as DshFollowFrame & { streamId: string };
          mux.streams.get(frame.streamId)?.(frame);
        } catch { socket.close(1002); }
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', () => reject(new Error('WORK_FOLLOW_FAILED')));
        socket.once('close', () => reject(new Error('WORK_FOLLOW_CLOSED')));
      });
      if (this.disposed) { socket.close(); throw new Error('WORK_STOPPED'); }
      this.mux = mux; return mux;
    })().finally(() => { this.openingMux = undefined; });
  }

  async sessionFollow(request: object, onFrame: (frame: DshFollowFrame) => void): Promise<() => void> {
    const { socket, streams } = await this.openMux(await this.ready());
    const streamId = randomUUID(); streams.set(streamId, onFrame);
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request } } }));
    return () => {
      if (streams.delete(streamId) && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId }));
    };
  }

  private async stopChild(): Promise<void> {
    const child = this.child; this.child = undefined;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') await new Promise<void>(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); }); killer.once('exit', () => resolve());
    });
    else {
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      await within(exit, 5000, 'WORK_STOP_TIMEOUT').catch(async () => { child.kill('SIGKILL'); await exit; });
    }
    if (this.connection?.pid === child.pid && !alive(child.pid)) await rm(this.descriptor, { force: true });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.mux?.socket.close(); this.mux = undefined;
    await this.stopChild(); await this.starting;
    this.connection = undefined; this.setStatus({ state: 'stopped' });
  }
}
