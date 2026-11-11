import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, realpath, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

export const HOST_DESCRIPTOR = 'local-api.json';
export type HostDescriptor = { url: string; token: string };

/** Local API clients have a separate bearer capability; application tickets cannot use it. */
export class HostApi {
  private server?: http.Server;
  private descriptor?: string;
  private readonly events = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private snapshot?: () => unknown;
  private activeCommands = new Set<Promise<unknown>>();
  private ready = false;
  private broadcasting = false;

  async start(directory: string, snapshot: () => unknown, command: (input: unknown) => Promise<unknown>, initialize: () => Promise<void> = async () => {}) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonical = await realpath(directory);
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    // The listening socket is the single-writer lock for this state directory.
    const port = 16_384 + createHash('sha256').update(key).digest().readUInt16BE() % 32_768;
    const token = randomBytes(32).toString('base64url');
    const expected = Buffer.from(`Bearer ${token}`);
    const authenticated = (request: http.IncomingMessage) => {
      const credential = Buffer.from(request.headers.authorization ?? '');
      return request.headers.origin === undefined && credential.length === expected.length && timingSafeEqual(credential, expected);
    };
    this.snapshot = snapshot;
    this.server = http.createServer(async (request, response) => {
      if (!authenticated(request)) { response.writeHead(401); response.end(); return; }
      if (!this.ready) { response.writeHead(503); response.end(); return; }
      response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
      try {
        if (request.method === 'GET' && request.url === '/snapshot') { response.end(JSON.stringify(snapshot())); return; }
        if (request.method !== 'POST' || request.url !== '/command') { response.writeHead(404); response.end(); return; }
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length; if (length > 1024 * 1024) { response.writeHead(413); response.end(); return; }
          chunks.push(chunk);
        }
        if (!this.ready) { response.writeHead(503); response.end(); return; }
        const pending = command(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        this.activeCommands.add(pending);
        try { response.end(JSON.stringify({ result: await pending ?? null })); }
        finally { this.activeCommands.delete(pending); }
      } catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
    });
    this.server.on('upgrade', (request, socket, head) => {
      if (!authenticated(request) || !this.ready || request.url !== '/events') { socket.destroy(); return; }
      this.events.handleUpgrade(request, socket, head, peer => {
        peer.on('error', () => peer.terminate());
        peer.send(JSON.stringify(snapshot()));
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(port, '127.0.0.1', resolve); });
      await initialize();
      const descriptor = path.join(canonical, HOST_DESCRIPTOR);
      const temp = `${descriptor}.${randomUUID()}.tmp`;
      const value: HostDescriptor = { url: `http://127.0.0.1:${port}`, token };
      await writeFile(temp, JSON.stringify(value), { mode: 0o600, flush: true });
      this.ready = true;
      await rename(temp, descriptor);
      this.descriptor = descriptor;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  broadcast() {
    if (!this.ready || this.broadcasting || !this.events.clients.size) return;
    this.broadcasting = true;
    queueMicrotask(() => {
      this.broadcasting = false;
      if (!this.ready || !this.events.clients.size) return;
      const message = JSON.stringify(this.snapshot!());
      for (const peer of this.events.clients) {
        if (peer.bufferedAmount > 16 * 1024 * 1024) peer.terminate();
        else if (peer.readyState === WebSocket.OPEN) peer.send(message);
      }
    });
  }

  async quiesce() {
    this.ready = false;
    await Promise.allSettled(this.activeCommands);
  }

  async close() {
    await this.quiesce();
    for (const peer of this.events.clients) peer.terminate();
    if (this.descriptor) await rm(this.descriptor, { force: true });
    this.server?.closeAllConnections();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = undefined; this.descriptor = undefined;
  }
}
