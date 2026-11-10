import { BrowserWindow, session } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

export type WorkStatus = { state: 'stopped' | 'starting' | 'ready' | 'error'; code?: string };
export async function loadWorkOptions(root: string): Promise<{ profile: string; cwd: string }> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path.join(root, 'config/work-runtime.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profile: 'web', cwd: root }; throw error; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_WORK_CONFIG');
  const config = value as Record<string, unknown>;
  if (typeof config.profile !== 'string' || !config.profile.trim() || typeof config.workspace !== 'string' || !config.workspace.trim()) throw new Error('INVALID_WORK_CONFIG');
  return { profile: config.profile.trim(), cwd: path.resolve(root, config.workspace) };
}

type RpcReply<T> = { rpcId: string; result?: { ok: boolean; value?: T; error?: { code?: string } } };
type FollowFrame = { type?: string; value?: unknown; error?: { code?: string } };

/** Owns one dsh Web Host, its authenticated API peer, and an optional native UI. */
export class WorkRuntime {
  private child?: ChildProcess;
  private window?: BrowserWindow;
  private starting?: Promise<WorkStatus>;
  private status: WorkStatus = { state: 'stopped' };
  private disposed = false;
  private origin = '';
  private apiCookie = '';
  private browserCookie = '';
  private partition = `work-${randomUUID()}`;
  private follows = new Set<() => void>();
  private socket?: WebSocket;
  private openingSocket?: Promise<WebSocket>;
  constructor(private readonly root: string, private readonly changed: (status: WorkStatus) => void,
    private readonly options: { profile?: string; cwd?: string } = {}) {}
  getStatus(): WorkStatus { return this.status; }
  private setStatus(status: WorkStatus) { this.status = status; this.changed(status); }

  /** Start the Host without opening or focusing its window. */
  ensureHost(): Promise<WorkStatus> {
    if (this.disposed) return Promise.resolve({ state: 'error', code: 'WORK_STOPPED' });
    if (this.status.state === 'ready' && this.child?.exitCode === null) return Promise.resolve(this.status);
    return this.starting ??= this.startHost().finally(() => { this.starting = undefined; });
  }

  /** Show the native dsh UI. Tasks continue while the window is hidden. */
  async open(): Promise<WorkStatus> {
    const status = await this.ensureHost();
    if (status.state !== 'ready') return status;
    try { await this.showWindow(); return this.status; }
    catch { return { state: 'error', code: 'WORK_WINDOW_FAILED' }; }
  }

  /** Select the exact native Session row so its pending interactions are visible. */
  async showSession(sessionId: string): Promise<WorkStatus> {
    if (!sessionId) return { state: 'error', code: 'WORK_SESSION_ID_REQUIRED' };
    const status = await this.open();
    if (status.state !== 'ready' || !this.window) return status;
    const target = `session:${sessionId}`;
    const selected = await this.window.webContents.executeJavaScript(`(async () => {
      const target = ${JSON.stringify(target)};
      const until = Date.now() + 20000;
      let expanded = 0;
      while (Date.now() < until) {
        const row = [...document.querySelectorAll('[data-row-key]')].find(el => el.getAttribute('data-row-key') === target);
        if (row) {
          row.click();
          await new Promise(resolve => setTimeout(resolve, 250));
          if (row.getAttribute('aria-selected') === 'true') return true;
        }
        const overflow = [...document.querySelectorAll('[data-row-key^="overflow:"]')].find(el => el.textContent && /展开|更多|show|more|expand/i.test(el.textContent));
        if (overflow && expanded < 50) { overflow.click(); expanded++; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return false;
    })()`, true).catch(() => false);
    this.window.show(); this.window.focus();
    return selected === true ? this.status : { state: 'error', code: 'WORK_SESSION_UI_NOT_FOUND' };
  }

  private async startHost(): Promise<WorkStatus> {
    this.setStatus({ state: 'starting' });
    try {
      const node = process.env.DESKAI_NODE_EXECUTABLE ?? (process.versions.electron ? undefined : process.execPath);
      if (!node) throw new Error('WORK_NODE_REQUIRED');
      const require = createRequire(import.meta.url);
      const entry = require.resolve('@deepseek-ai/dsh/lib/bin.js', { paths: [this.root] });
      const autoPatch = require.resolve('@deepseek-ai/dsh-experimental-auto-review/cordis.patch.yml', { paths: [this.root] });
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(node, [entry, '--profile', this.options.profile ?? 'web', '--patch', autoPatch, '--port', '0', '--no-open'], {
        cwd: this.options.cwd ?? this.root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
      this.child = child;
      const launch = await new Promise<URL>((resolve, reject) => {
        let buffer = '';
        const timeout = setTimeout(() => finish(new Error('WORK_START_TIMEOUT')), 90_000);
        const finish = (error?: Error, value?: URL) => {
          clearTimeout(timeout); child.stdout?.off('data', ingest); child.stderr?.off('data', ingest);
          child.off('error', failed); child.off('exit', exited); buffer = '';
          if (error) reject(error); else resolve(value!);
        };
        const failed = () => finish(new Error('WORK_SPAWN_FAILED'));
        const exited = () => finish(new Error('WORK_HOST_EXITED'));
        const ingest = (chunk: Buffer) => {
          buffer = (buffer + chunk.toString('utf8')).slice(-64_000);
          const match = buffer.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?\?token=[^\s'"<>]+/);
          if (match) finish(undefined, new URL(match[0].replace(/[),.;]+$/, '')));
        };
        child.stdout?.on('data', ingest); child.stderr?.on('data', ingest);
        child.once('error', failed); child.once('exit', exited);
      });
      child.stdout?.resume(); child.stderr?.resume();
      child.once('exit', () => {
        if (this.child !== child) return;
        this.child = undefined; this.origin = ''; this.apiCookie = ''; this.browserCookie = '';
        for (const close of this.follows) close();
        this.window?.destroy(); this.window = undefined;
        if (!this.disposed) this.setStatus({ state: 'error', code: 'WORK_HOST_EXITED' });
      });
      if (this.disposed || child.exitCode !== null) throw new Error('WORK_STOPPED');
      const token = launch.searchParams.get('token');
      if (!token) throw new Error('WORK_AUTH_FAILED');
      this.origin = launch.origin;
      this.apiCookie = await this.authCookie(`${launch.origin}/connect?token=${encodeURIComponent(token)}&interactions=none`, 302);
      this.browserCookie = await this.authCookie(`${launch.origin}/?token=${encodeURIComponent(token)}`, 303);
      if (this.disposed || this.child !== child) throw new Error('WORK_STOPPED');
      this.setStatus({ state: 'ready' });
      return this.status;
    } catch (error) {
      await this.stopHost();
      if (!this.disposed) this.setStatus({ state: 'error', code: error instanceof Error && /^WORK_[A-Z_]+$/.test(error.message) ? error.message : 'WORK_START_FAILED' });
      return this.status;
    }
  }

  private async authCookie(url: string, expectedStatus: number): Promise<string> {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    if (response.status !== expectedStatus || !cookie || cookie.indexOf('=') < 1) throw new Error('WORK_AUTH_FAILED');
    return cookie;
  }

  private async showWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return; }
    const cookie = this.browserCookie;
    const separator = cookie.indexOf('=');
    if (!this.origin || separator < 1) throw new Error('WORK_AUTH_FAILED');
    const workSession = session.fromPartition(this.partition);
    workSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    workSession.setPermissionCheckHandler(() => false);
    await workSession.cookies.set({ url: this.origin, name: cookie.slice(0, separator), value: cookie.slice(separator + 1), httpOnly: true, sameSite: 'lax' });
    const workWindow = new BrowserWindow({ width: 1200, height: 800, minWidth: 700, minHeight: 500,
      title: 'DeskAI · 任务工作台', autoHideMenuBar: true, show: false,
      webPreferences: { partition: this.partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
    this.window = workWindow;
    workWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    workWindow.webContents.on('will-navigate', (event, destination) => {
      try { if (new URL(destination).origin !== this.origin) event.preventDefault(); }
      catch { event.preventDefault(); }
    });
    workWindow.on('close', event => { if (!this.disposed) { event.preventDefault(); workWindow.hide(); } });
    try { await workWindow.loadURL(this.origin); }
    catch (error) { workWindow.destroy(); if (this.window === workWindow) this.window = undefined; throw error; }
    if (this.disposed) { workWindow.destroy(); throw new Error('WORK_STOPPED'); }
    workWindow.show();
  }

  async call<T>(endpoint: string, args: object, signal?: AbortSignal): Promise<T> {
    const status = await this.ensureHost();
    if (status.state !== 'ready') throw new Error(status.code ?? 'WORK_HOST_UNAVAILABLE');
    const rpcId = randomUUID();
    const response = await fetch(`${this.origin}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', Cookie: this.apiCookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      signal: AbortSignal.any([AbortSignal.timeout(180_000), ...(signal ? [signal] : [])])
    });
    if (!response.ok) throw new Error(`WORK_HTTP_${response.status}`);
    const reply = await response.json() as RpcReply<T>;
    if (reply.rpcId !== rpcId) throw new Error('WORK_RPC_ID_MISMATCH');
    if (!reply.result?.ok) throw new Error(reply.result?.error?.code ?? 'WORK_RPC_FAILED');
    return reply.result.value as T;
  }

  sessionCall<T>(endpoint: string, request: object, signal?: AbortSignal): Promise<T> {
    return this.call<T>(endpoint, { request }, signal);
  }

  private async mux(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    return this.openingSocket ??= (async () => {
      const socket = new WebSocket(this.origin.replace(/^http/, 'ws') + '/api/remote.mux', {
        headers: { Cookie: this.apiCookie }, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 15_000
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WORK_FOLLOW_TIMEOUT')), 15_000);
        socket.once('open', () => { clearTimeout(timer); resolve(); });
        socket.once('error', () => { clearTimeout(timer); reject(new Error('WORK_FOLLOW_FAILED')); });
      }).catch(error => { socket.close(); throw error; });
      this.socket = socket;
      socket.once('close', () => { if (this.socket === socket) this.socket = undefined; });
      return socket;
    })().finally(() => { this.openingSocket = undefined; });
  }

  async sessionFollow(request: object, onFrame: (frame: FollowFrame) => void): Promise<() => void> {
    const status = await this.ensureHost();
    if (status.state !== 'ready') throw new Error(status.code ?? 'WORK_HOST_UNAVAILABLE');
    const socket = await this.mux();
    const streamId = randomUUID();
    let closed = false;
    const receive = (raw: WebSocket.RawData) => {
      try { const frame = JSON.parse(raw.toString()) as FollowFrame & { streamId?: string }; if (frame.streamId === streamId) onFrame(frame); }
      catch { onFrame({ type: 'error', error: { code: 'WORK_INVALID_FOLLOW_FRAME' } }); }
    };
    const disconnected = () => { if (!closed) { onFrame({ type: 'error', error: { code: 'WORK_FOLLOW_CLOSED' } }); close(); } };
    const close = () => {
      if (closed) return;
      closed = true; this.follows.delete(disconnected);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId }));
      socket.off('message', receive); socket.off('close', disconnected); socket.off('error', disconnected);
    };
    this.follows.add(disconnected);
    socket.on('message', receive); socket.on('close', disconnected); socket.on('error', disconnected);
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request } } }));
    return close;
  }

  private async stopHost(): Promise<void> {
    const child = this.child; this.child = undefined;
    for (const close of this.follows) close();
    this.socket?.close(); this.socket = undefined;
    this.origin = ''; this.apiCookie = ''; this.browserCookie = '';
    if (!child?.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') await new Promise<void>(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); }); killer.once('exit', () => resolve());
    });
    else child.kill('SIGTERM');
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.window?.destroy(); this.window = undefined;
    await this.stopHost();
    await this.starting?.catch(() => {});
    this.setStatus({ state: 'stopped' });
  }
}
