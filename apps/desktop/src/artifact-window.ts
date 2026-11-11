import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { HostClient } from '../../host/src/client.ts';
import type { Artifact } from '../../../packages/app-core/src/index.ts';

const escape = (text: string) => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!);
export class ArtifactWindows {
  private windows = new Set<BrowserWindow>();
  async open(host: HostClient, artifactId: string, interact: boolean) {
    const launch = interact ? await host.command<{ url: string }>({ type: 'artifact-launch', artifactId }) : undefined;
    const preview = interact ? undefined : await host.command<{ artifact: Artifact; base64: string }>({ type: 'artifact-preview', artifactId });
    const title = preview?.artifact.relativePath ?? host.cached()?.artifacts.find(artifact => artifact.id === artifactId)?.relativePath ?? 'DeskAI';
    const partition = `artifact-${randomUUID()}`;
    const isolated = session.fromPartition(partition);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    const window = new BrowserWindow({ width: 1000, height: 720, title, show: false,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    this.windows.add(window); window.once('closed', () => this.windows.delete(window));
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    try {
      if (launch) await window.loadURL(launch.url);
      else {
        const { artifact, base64 } = preview!;
        const extension = path.extname(artifact.relativePath).toLowerCase();
        const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' } as Record<string, string>)[extension];
        const body = mime ? `<img style="max-width:100%" src="data:${mime};base64,${base64}">` : `<pre style="white-space:pre-wrap">${escape(Buffer.from(base64, 'base64').toString('utf8').slice(0, 200000))}</pre>`;
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escape(artifact.relativePath)}</title>${body}`)}`);
      }
      window.show();
      return { opened: true, artifactId, interactionRequested: interact };
    } catch (error) { window.destroy(); throw error; }
  }
  close() { for (const window of this.windows) window.destroy(); this.windows.clear(); }
}
