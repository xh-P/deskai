import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import type { HostClient } from '../../host/src/client.ts';
import type { WorkRuntimeStatus, WorkWindowConnection } from '../../../packages/dsh-adapter/src/work-runtime.ts';

/** The desktop owns the native UI window while the Host owns its dsh process. */
export class WorkWindow {
  private window?: BrowserWindow;
  private connection?: WorkWindowConnection;

  async open(host: HostClient, sessionId?: string): Promise<WorkRuntimeStatus> {
    try {
      const connection = await host.command<WorkWindowConnection>({ type: 'native-window' });
      const window = await this.show(connection);
      if (sessionId && !await this.selectSession(window, sessionId)) return { state: 'error', code: 'WORK_SESSION_UI_NOT_FOUND' };
      return { state: 'ready' };
    } catch (error) {
      return { state: 'error', code: error instanceof Error ? error.message : 'WORK_WINDOW_FAILED' };
    }
  }

  private async show(connection: WorkWindowConnection): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed() && this.connection?.origin === connection.origin && this.connection.cookie === connection.cookie) {
      this.window.show(); this.window.focus(); return this.window;
    }
    this.close();
    const { origin, cookie } = connection;
    const separator = cookie.indexOf('=');
    const partition = `work-${randomUUID()}`;
    const isolated = session.fromPartition(partition);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    await isolated.cookies.set({ url: origin, name: cookie.slice(0, separator), value: cookie.slice(separator + 1), httpOnly: true, sameSite: 'lax' });
    const window = new BrowserWindow({ width: 1200, height: 800, minWidth: 700, minHeight: 500,
      title: 'DeskAI · 任务工作台', autoHideMenuBar: true, show: false,
      webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
    this.window = window; this.connection = connection;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, destination) => { if (new URL(destination).origin !== origin) event.preventDefault(); });
    window.on('close', event => { event.preventDefault(); window.hide(); });
    try { await window.loadURL(origin); }
    catch (error) { window.destroy(); throw error; }
    window.show(); return window;
  }

  private async selectSession(window: BrowserWindow, sessionId: string): Promise<boolean> {
    const selected = await window.webContents.executeJavaScript(`(async () => {
      const target = ${JSON.stringify(`session:${sessionId}`)};
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        const row = [...document.querySelectorAll('[data-row-key]')].find(el => el.getAttribute('data-row-key') === target);
        if (row) {
          if (row.getAttribute('aria-selected') === 'true') return true;
          row.click();
        } else {
          const group = document.querySelector('[data-row-key^="workspace:"][aria-expanded="false"]');
          const more = document.querySelector('[data-row-key^="overflow:"][aria-expanded="false"]');
          (group ?? more)?.click();
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return false;
    })()`, true).catch(() => false);
    return selected === true;
  }

  close() { this.window?.destroy(); this.window = undefined; this.connection = undefined; }
}
