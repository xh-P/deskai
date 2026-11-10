import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

/** Local API clients have a separate bearer capability; application tickets cannot use it. */
export class HostApi {
  private server?: http.Server;
  private descriptor?: string;
  async start(directory: string, snapshot: () => unknown, command: (input: unknown) => Promise<unknown>) {
    const token = randomBytes(32).toString('base64url');
    const expected = Buffer.from(`Bearer ${token}`);
    this.server = http.createServer(async (request, response) => {
      const credential = Buffer.from(request.headers.authorization ?? '');
      if (request.headers.origin || credential.length !== expected.length || !timingSafeEqual(credential, expected)) {
        response.writeHead(401); response.end(); return;
      }
      response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
      try {
        if (request.method === 'GET' && request.url === '/snapshot') { response.end(JSON.stringify(snapshot())); return; }
        if (request.method !== 'POST' || request.url !== '/command') { response.writeHead(404); response.end(); return; }
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length; if (length > 1024 * 1024) { response.writeHead(413); response.end(); return; }
          chunks.push(chunk);
        }
        const result = await command(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.end(JSON.stringify({ result: result ?? null }));
      } catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
    });
    try {
      await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve); });
      const port = (this.server.address() as { port: number }).port;
      await mkdir(directory, { recursive: true }); this.descriptor = path.join(directory, 'local-api.json');
      await writeFile(this.descriptor, JSON.stringify({ url: `http://127.0.0.1:${port}`, token }), { mode: 0o600 });
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async close() {
    this.server?.closeAllConnections();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    if (this.descriptor) await rm(this.descriptor, { force: true });
    this.server = undefined; this.descriptor = undefined;
  }
}
