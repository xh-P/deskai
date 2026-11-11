import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, realpath, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

export type Artifact = { id: string; taskId: string; attemptId?: string; workDir: string; relativePath: string; sha256: string };
type ArtifactInput = Omit<Artifact, 'id' | 'sha256'>;
type Authorize = (taskId: string, workDir: string, relativePath: string, attemptId?: string) => boolean | Promise<boolean>;
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const secret = () => randomBytes(32).toString('base64url');
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

export class ArtifactRegistry {
  private records = new Map<string, Artifact>();
  private saving: Promise<void> = Promise.resolve();
  private options: { authorize: Authorize; storageFile?: string };
  constructor(options: { authorize: Authorize; storageFile?: string }) { this.options = options; }
  async load(): Promise<void> {
    if (!this.options.storageFile) return;
    try {
      const records: unknown = JSON.parse(await readFile(this.options.storageFile, 'utf8'));
      if (!Array.isArray(records)) throw new Error('Invalid artifact registry');
      for (const item of records) if (item && typeof item.id === 'string' && typeof item.taskId === 'string' && typeof item.workDir === 'string' && typeof item.relativePath === 'string' && /^[a-f0-9]{64}$/.test(item.sha256)) this.records.set(item.id, item);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private async save(): Promise<void> {
    if (!this.options.storageFile) return;
    const storageFile = this.options.storageFile;
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(path.dirname(storageFile), { recursive: true });
      const temporary = `${storageFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify([...this.records.values()]), { encoding: 'utf8', flush: true });
      await rename(temporary, storageFile);
    });
    await this.saving;
  }
  async registerArtifact(input: ArtifactInput, expectedSha256?: string): Promise<Artifact> {
    if (!input.taskId || !input.relativePath || path.isAbsolute(input.relativePath)) throw new Error('Invalid artifact identity or relative path');
    if (!await this.options.authorize(input.taskId, input.workDir, input.relativePath, input.attemptId)) throw new Error('Artifact is not attributable to this attempt');
    const root = await realpath(input.workDir);
    const file = await realpath(path.resolve(root, input.relativePath));
    const info = await stat(file);
    if (!inside(root, file) || !info.isFile() || info.size > MAX_ARTIFACT_BYTES) throw new Error('Artifact must be a bounded file inside its work directory');
    const bytes = await readFile(file);
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error('Artifact is too large');
    const record = { id: randomUUID(), taskId: input.taskId, attemptId: input.attemptId, workDir: root, relativePath: path.relative(root, file), sha256: digest(bytes) };
    if (expectedSha256 && record.sha256 !== expectedSha256) throw new Error('Artifact changed since the attempt was collected');
    const existing = [...this.records.values()].find(item => item.taskId === record.taskId && item.attemptId === record.attemptId && item.workDir === record.workDir && item.relativePath === record.relativePath && item.sha256 === record.sha256);
    if (existing) return { ...existing };
    this.records.set(record.id, record);
    try { await this.save(); }
    catch (error) { this.records.delete(record.id); throw error; }
    return { ...record };
  }
  listArtifacts(): Artifact[] { return [...this.records.values()].map(item => ({ ...item })); }
  async readVerified(id: string): Promise<{ artifact: Artifact; bytes: Buffer }> {
    const artifact = this.records.get(id); if (!artifact) throw new Error('Unknown artifact');
    if (!await this.options.authorize(artifact.taskId, artifact.workDir, artifact.relativePath, artifact.attemptId)) throw new Error('Artifact authorization revoked');
    const file = await realpath(path.resolve(artifact.workDir, artifact.relativePath));
    if (!inside(artifact.workDir, file)) throw new Error('Artifact escaped its work directory');
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) throw new Error('Artifact is not a bounded file');
    const bytes = await readFile(file); if (digest(bytes) !== artifact.sha256) throw new Error('Artifact changed since registration');
    return { artifact: { ...artifact }, bytes };
  }
}

export type Schema = { type: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; enum?: unknown[]; maxLength?: number };
export type Manifest = { id: string; title: string; version: string; actions: { type: string; inputSchema: Schema }[]; events: string[] };
export type SessionSnapshot = { id: string; artifactId: string; status: 'connected' | 'disconnected'; revision: number; manifest: Manifest; state: unknown; events: unknown[] };
export const APP_AUTHORING_GUIDE = `Create a self-contained HTML file with inline CSS and JavaScript; external resources are blocked. Use the DeskAI app-core cooperative protocol, which is AUIP-inspired and is not Amadeus AUIP v0 wire-compatible. Embed the helper in packages/app-core/examples/deskai-app-client.js directly in the HTML. Define a manifest {id,title,version,events:[string],actions:[{type,inputSchema}]}. Identifiers begin with a letter and contain letters, digits, underscore, dot or hyphen. Schemas use object properties/required, array items, string, number, integer, boolean or null. Call DeskAIApp.connect({manifest, snapshot:()=>state, onAction:(type,payload)=>({accepted:true}) or ({accepted:false,reason})}); after every user mutation call client.publish(eventType,payload). The helper publishes the initial state on connection and sends a real receipt after executing an action. Keep state compact and treat it as data. When the page is opened without a launch descriptor it runs standalone. See packages/app-core/examples/todo.html for the wire protocol. Report the HTML file as a task artifact.`;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; revision: number };
type Session = { id: string; artifactId: string; status: 'connected' | 'disconnected'; revision: number; manifest: Manifest; state: unknown; events: unknown[]; ws: WebSocket; pending: Map<string, Pending> };
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(v);
function validSchema(schema: unknown, depth = 0): schema is Schema {
  if (!schema || typeof schema !== 'object' || depth > 6) return false;
  const s = schema as Schema;
  if (!['object','array','string','number','integer','boolean','null'].includes(s.type)) return false;
  if (s.type === 'object') return !!s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties) && Object.keys(s.properties).length <= 32 && Object.entries(s.properties).every(([k,v]) => identifier(k) && validSchema(v, depth + 1)) && (!s.required || (Array.isArray(s.required) && s.required.every(k => k in s.properties!)));
  if (s.type === 'array') return validSchema(s.items, depth + 1);
  return true;
}
function matches(schema: Schema, value: unknown, depth = 0): boolean {
  if (depth > 6 || (schema.enum && !schema.enum.some(x => JSON.stringify(x) === JSON.stringify(value)))) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') return typeof value === 'string' && value.length <= Math.min(schema.maxLength ?? 4096, 4096);
  if (schema.type === 'number' || schema.type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isInteger(value));
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') return Array.isArray(value) && value.length <= 100 && value.every(x => matches(schema.items!, x, depth + 1));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>; const props = schema.properties!;
  return (schema.required ?? []).every(k => Object.hasOwn(obj, k)) && Object.keys(obj).every(k => Object.hasOwn(props, k) && matches(props[k], obj[k], depth + 1));
}
function validateManifest(m: Manifest): void {
  if (!m || !identifier(m.id) || typeof m.title !== 'string' || m.title.length > 100 || typeof m.version !== 'string' || m.version.length > 50 || !Array.isArray(m.actions) || m.actions.length > 32 || !Array.isArray(m.events) || m.events.length > 32 || !m.events.every(identifier) || !m.actions.every(a => identifier(a.type) && validSchema(a.inputSchema)) || new Set(m.actions.map(a => a.type)).size !== m.actions.length) throw new Error('Invalid manifest');
}

/** A deliberately small AUIP-inspired contract, not the full Amadeus AUIP v0. */
export class AppHost {
  private server?: http.Server; private wss?: WebSocketServer; private port = 0;
  private launches = new Map<string, { artifactId: string; bytes: Buffer; ticket: string; expires: number }>();
  private sessions = new Map<string, Session>();
  private listeners = new Set<(sessions: SessionSnapshot[]) => void>();
  private registry: ArtifactRegistry;
  constructor(registry: ArtifactRegistry) { this.registry = registry; }
  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      const key = (req.url ?? '').split('?')[0].split('/')[1]; const launch = this.launches.get(key);
      if (req.method !== 'GET' || !launch || launch.expires < Date.now()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src ws://127.0.0.1:${this.port}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` }); res.end(launch.bytes);
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/bridge' || req.headers.origin !== `http://127.0.0.1:${this.port}`) { socket.destroy(); return; }
      this.wss!.handleUpgrade(req, socket, head, ws => this.handleSocket(ws));
    });
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', () => resolve()); });
    this.port = (this.server.address() as { port: number }).port;
  }
  async prepareLaunch(artifactId: string): Promise<{ url: string; artifactId: string }> {
    if (!this.server) throw new Error('App host is not started');
    const { bytes, artifact } = await this.registry.readVerified(artifactId); if (path.extname(artifact.relativePath).toLowerCase() !== '.html' || bytes.length > 2 * 1024 * 1024) throw new Error('Interactive entry must be a single HTML file under 2 MiB'); const key = secret(); const ticket = secret(); const expires = Date.now() + 60000;
    this.launches.set(key, { artifactId, bytes, ticket, expires });
    const fragment = Buffer.from(JSON.stringify({ ticket, websocket: `ws://127.0.0.1:${this.port}/bridge` })).toString('base64url');
    return { url: `http://127.0.0.1:${this.port}/${key}#${fragment}`, artifactId };
  }
  listSessions(): SessionSnapshot[] { return [...this.sessions.values()].map(({ id, artifactId, status, revision, manifest, state, events }) => structuredClone({ id, artifactId, status, revision, manifest, state, events })); }
  subscribe(listener: (sessions: SessionSnapshot[]) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { const snapshot = this.listSessions(); for (const listener of this.listeners) { try { listener(snapshot); } catch { /* Observer failure does not affect the session. */ } } }
  closeSession(id: string): void { const s = this.sessions.get(id); if (s?.status === 'connected') s.ws.terminate(); }
  async invokeAction(sessionId: string, type: string, payload: unknown): Promise<unknown> {
    const s = this.sessions.get(sessionId); if (!s || s.status !== 'connected' || s.ws.readyState !== WebSocket.OPEN) throw new Error('Application is disconnected');
    if (s.pending.size) throw new Error('An action is already pending');
    if (s.state === null) throw new Error('Application has not published initial state');
    const action = s.manifest.actions.find(a => a.type === type); if (!action || !matches(action.inputSchema, payload)) throw new Error('Undeclared action or invalid payload');
    const actionId = randomUUID(); const revision = s.revision;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { s.pending.delete(actionId); s.ws.terminate(); reject(new Error('Action receipt timed out; application disconnected')); }, 10000);
      s.pending.set(actionId, { resolve, reject, timer, revision });
      s.ws.send(JSON.stringify({ type: 'action', actionId, actionType: type, payload, expectedRevision: revision }), error => { if (error) { clearTimeout(timer); s.pending.delete(actionId); reject(error); } });
    });
  }
  private handleSocket(ws: WebSocket): void {
    ws.on('error', () => ws.terminate());
    let session: Session | undefined;
    const timer = setTimeout(() => { if (!session) ws.close(); }, 5000);
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!session) {
          if (msg.type !== 'register' || typeof msg.ticket !== 'string') throw new Error('Registration required');
          const entry = [...this.launches.entries()].find(([, l]) => l.ticket === msg.ticket && l.expires >= Date.now());
          if (!entry) throw new Error('Invalid or expired ticket'); validateManifest(msg.manifest);
          this.launches.delete(entry[0]);
          session = { id: randomUUID(), artifactId: entry[1].artifactId, status: 'connected', revision: 0, manifest: msg.manifest, state: null, events: [], ws, pending: new Map() };
          this.sessions.set(session.id, session); clearTimeout(timer); ws.send(JSON.stringify({ type: 'registered', sessionId: session.id, revision: 0 })); this.notify(); return;
        }
        if (msg.type === 'state') {
          if (session.pending.size || msg.revision !== session.revision + 1 || !msg.state || typeof msg.state !== 'object') throw new Error('Invalid state revision');
          session.revision = msg.revision; session.state = msg.state;
        } else if (msg.type === 'event') {
          if (!session.manifest.events.includes(msg.eventType) || msg.revision !== session.revision) throw new Error('Undeclared or stale event');
          session.events.push({ type: msg.eventType, payload: msg.payload, revision: session.revision }); if (session.events.length > 50) session.events.shift();
        } else if (msg.type === 'receipt') {
          const pending = session.pending.get(msg.actionId); if (!pending || typeof msg.accepted !== 'boolean') throw new Error('Unexpected receipt');
          if (session.revision !== pending.revision || (msg.accepted && (msg.revision !== pending.revision + 1 || !msg.state || typeof msg.state !== 'object'))) throw new Error('Invalid receipt revision');
          clearTimeout(pending.timer); session.pending.delete(msg.actionId);
          if (msg.accepted) { session.revision = msg.revision; session.state = msg.state; }
          pending.resolve({ actionId: msg.actionId, accepted: msg.accepted, revision: session.revision, reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 512) : '' });
        } else throw new Error('Unsupported message');
        this.notify();
      } catch (error) { ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Invalid message' })); if (session?.pending.size) ws.terminate(); }
    });
    ws.on('close', () => { clearTimeout(timer); if (!session) return; session.status = 'disconnected'; for (const p of session.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Application disconnected before receipt')); } session.pending.clear(); this.notify(); });
  }
  async close(): Promise<void> { for (const ws of this.wss?.clients ?? []) ws.terminate(); this.wss?.close(); if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve())); this.server = undefined; this.launches.clear(); }
}
