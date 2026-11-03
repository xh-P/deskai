import { BrowserWindow, session } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

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

/** Owns only the Web host and window launched by this application. */
export class WorkRuntime {
  private child?: ChildProcess;
  private window?: BrowserWindow;
  private starting?: Promise<WorkStatus>;
  private status: WorkStatus = { state: 'stopped' };
  private disposed = false;
  constructor(private readonly root: string, private readonly changed: (status: WorkStatus) => void,
    private readonly options: { profile?: string; cwd?: string } = {}) {}
  getStatus(): WorkStatus { return this.status; }
  private setStatus(status: WorkStatus) { this.status = status; this.changed(status); }

  open(): Promise<WorkStatus> {
    if (this.disposed) return Promise.resolve({ state: 'error', code: 'WORK_STOPPED' });
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return Promise.resolve(this.status); }
    return this.starting ??= this.start().finally(() => { this.starting = undefined; });
  }

  private async start(): Promise<WorkStatus> {
    this.setStatus({ state: 'starting' });
    try {
      const node = process.env.DESKAI_NODE_EXECUTABLE ?? (process.versions.electron ? undefined : process.execPath);
      if (!node) throw new Error('WORK_NODE_REQUIRED');
      const require = createRequire(import.meta.url);
      const entry = require.resolve('@deepseek-ai/dsh/lib/bin.js', { paths: [this.root] });
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(node, [entry, '--profile', this.options.profile ?? 'web', '--port', '0', '--no-open'], {
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
        this.child = undefined;
        this.window?.destroy(); this.window = undefined;
        if (!this.disposed) this.setStatus({ state: 'error', code: 'WORK_HOST_EXITED' });
      });
      if (this.disposed || child.exitCode !== null) throw new Error('WORK_STOPPED');
      const token = launch.searchParams.get('token');
      if (!token) throw new Error('WORK_AUTH_FAILED');
      // The browser index uses a separate cookie from /connect's API operator.
      // The native browser client itself registers an interaction-capable peer.
      const response = await fetch(`${launch.origin}/?token=${encodeURIComponent(token)}`, {
        redirect: 'manual', signal: AbortSignal.timeout(15_000)
      });
      const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
      const separator = cookie?.indexOf('=') ?? -1;
      if (response.status !== 303 || !cookie || separator < 1) throw new Error('WORK_AUTH_FAILED');
      if (this.disposed || this.child !== child) throw new Error('WORK_STOPPED');
      const partition = `work-${randomUUID()}`;
      const workSession = session.fromPartition(partition);
      workSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      workSession.setPermissionCheckHandler(() => false);
      await workSession.cookies.set({ url: launch.origin, name: cookie.slice(0, separator), value: cookie.slice(separator + 1), httpOnly: true, sameSite: 'lax' });
      if (this.disposed || this.child !== child) throw new Error('WORK_STOPPED');
      const workWindow = new BrowserWindow({ width: 1200, height: 800, minWidth: 700, minHeight: 500,
        title: 'DeskAI · 任务工作台', autoHideMenuBar: true, show: false,
        webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
      this.window = workWindow;
      workWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      workWindow.webContents.on('will-navigate', (event, destination) => {
        try { if (new URL(destination).origin !== launch.origin) event.preventDefault(); }
        catch { event.preventDefault(); }
      });
      // Closing the surface must not interrupt the user's running Harness task.
      workWindow.on('close', event => { if (!this.disposed) { event.preventDefault(); workWindow.hide(); } });
      await workWindow.loadURL(launch.origin);
      if (this.disposed || this.window !== workWindow || this.child !== child) throw new Error('WORK_STOPPED');
      workWindow.show();
      this.setStatus({ state: 'ready' });
      return this.status;
    } catch (error) {
      this.window?.destroy(); this.window = undefined;
      await this.stopHost();
      if (!this.disposed) this.setStatus({ state: 'error', code: error instanceof Error && /^WORK_[A-Z_]+$/.test(error.message) ? error.message : 'WORK_START_FAILED' });
      return this.status;
    }
  }

  private async stopHost(): Promise<void> {
    const child = this.child; this.child = undefined;
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
