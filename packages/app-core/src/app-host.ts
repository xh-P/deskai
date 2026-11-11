import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import type { ArtifactRegistry } from './artifacts.ts';
import { boundedText, checkAction, encodeMessage, MAX_MESSAGE_BYTES, object, parseManifest, readState, revision,
  type EngagementMode, type JsonObject, type Manifest, type StateContract } from './auip-contract.ts';
import { readBundle, urlPath, type VerifiedBundle } from './bundle.ts';
import { Controller, type ControllerLease, type ControllerSnapshot } from './controller.ts';

const TICKET_LIFETIME = 60_000;
const ACTION_TIMEOUT = 10_000;
const secret = () => randomBytes(32).toString('base64url');
type Status = 'connected' | 'completed' | 'disconnected' | 'closed';
type Action = { action_id: string; actor: 'kurisu'; type: string; payload: JsonObject; expected_revision: number; controller_lease?: ControllerLease };
type Receipt = Action & { accepted: boolean; resulting_revision: number; effects: JsonObject; reason: string; resolved_at: number };
type SemanticEvent = { event_id: string; type: string; actor: string; revision: number; payload: JsonObject; caused_by_action_id: string };
type Pending = { action: Action; resolve: (receipt: Receipt) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Launch = { bundle: VerifiedBundle; ticket?: string; expires: number; timer: NodeJS.Timeout };
type Session = { id: string; artifactId: string; manifest: Manifest; token: string; status: Status; mode: EngagementMode;
  revision: number; generation: number; projection?: StateContract; events: SemanticEvent[]; seen: Map<string, SemanticEvent>;
  receipt?: Receipt; pending?: Pending; controller?: Controller; socket: WebSocket };

export type AppStateVersion = { revision: number; generation: number };
export interface SessionSnapshot {
  id: string;
  artifactId: string;
  status: Status;
  mode: EngagementMode;
  revision: number;
  generation: number;
  manifest: Manifest;
  state: JsonObject | null;
  events: SemanticEvent[];
  receipt?: Receipt;
  controller?: ControllerSnapshot;
}

/** AUIP v0 app-facing connection. Only the trusted Host can initiate an action or change engagement. */
export class AppHost {
  private server?: http.Server;
  private sockets?: WebSocketServer;
  private origin = '';
  private readonly launches = new Map<string, Launch>();
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(sessions: SessionSnapshot[]) => void>();
  private readonly registry: ArtifactRegistry;

  constructor(registry: ArtifactRegistry) { this.registry = registry; }

  async start(): Promise<void> {
    if (this.server) return;
    const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    this.sockets = sockets;
    const server = http.createServer((request, response) => {
      const match = /^\/bundle\/([A-Za-z0-9_-]+)\/(.+)$/.exec((request.url ?? '').split('?', 1)[0]);
      const launch = match && this.launches.get(match[1]);
      let file;
      try { if (match && launch) file = launch.bundle.files.get(decodeURIComponent(match[2])); } catch { /* Invalid URL encoding. */ }
      if (request.method !== 'GET' || !match || !file) { response.writeHead(404); response.end(); return; }
      const bridge = `${this.origin.replace('http:', 'ws:')}/bridge/${match[1]}`;
      response.writeHead(200, { 'Content-Type': file.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${bridge}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
      response.end(file.bytes);
    });
    this.server = server;
    server.on('upgrade', (request, socket, head) => {
      const key = /^\/bridge\/([A-Za-z0-9_-]+)$/.exec(request.url ?? '')?.[1];
      const launch = key && this.launches.get(key);
      if (!key || !launch || !launch.ticket || launch.expires <= Date.now() || request.headers.origin !== this.origin) { socket.destroy(); return; }
      sockets.handleUpgrade(request, socket, head, peer => this.connect(peer, key, launch));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    this.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  async prepareLaunch(artifactId: string): Promise<{ url: string; artifactId: string }> {
    if (!this.server) throw new Error('app_host_unavailable');
    const bundle = await readBundle(this.registry, artifactId);
    const key = secret(); const ticket = secret(); const expires = Date.now() + TICKET_LIFETIME;
    const timer = setTimeout(() => this.launches.delete(key), TICKET_LIFETIME);
    timer.unref();
    this.launches.set(key, { bundle, ticket, expires, timer });
    const descriptor = { schema: 'amadeus.auip/launch-v0', webSocketUrl: `${this.origin.replace('http:', 'ws:')}/bridge/${key}`,
      attachTicket: ticket, expiresAt: expires / 1000 };
    const fragment = Buffer.from(JSON.stringify(descriptor)).toString('base64url');
    return { artifactId, url: `${this.origin}/bundle/${key}/${urlPath(bundle.entry)}#amadeus-auip=${fragment}` };
  }

  listSessions(): SessionSnapshot[] {
    return [...this.sessions.values()].map(session => structuredClone({ id: session.id, artifactId: session.artifactId,
      status: session.status, mode: session.mode, revision: session.revision, generation: session.generation, manifest: session.manifest,
      state: session.projection?.state ?? null, events: session.events, receipt: session.receipt, controller: session.controller?.snapshot() }));
  }

  subscribe(listener: (sessions: SessionSnapshot[]) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed() {
    if (!this.listeners.size) return;
    const snapshot = this.listSessions();
    for (const listener of this.listeners) { try { listener(snapshot); } catch { /* The client cannot change the session. */ } }
  }

  private active(id: string): Session {
    const session = this.sessions.get(id);
    if (session?.status !== 'connected' || session.socket.readyState !== WebSocket.OPEN) throw new Error('session_not_active');
    return session;
  }

  setMode(id: string, mode: EngagementMode) {
    const session = this.active(id);
    if (mode !== 'observe' && mode !== 'collaborate') throw new Error('unsupported_engagement_mode');
    if (!session.manifest.stances.includes(mode === 'observe' ? 'spectator' : 'participant')) throw new Error('unsupported_stance');
    if (session.mode !== mode) session.generation++;
    session.mode = mode;
    if (mode === 'observe') {
      this.invalidate(session, 'user_took_over');
      this.revokeController(session, 'user_takeover');
    }
    this.changed();
    return { appSessionId: id, mode, controller: session.controller?.snapshot() };
  }

  closeSession(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.status === 'disconnected' || session.status === 'closed') return;
    this.revokeController(session, 'session_closed');
    this.end(session, 'closed', 'session_closed');
    session.socket.close();
  }

  async invokeAction(id: string, type: string, value: unknown, expected: AppStateVersion): Promise<Receipt> {
    const session = this.active(id);
    if (session.mode !== 'collaborate') throw new Error('participant_stance_required');
    if (!session.projection || !session.revision) throw new Error('app_state_not_ready');
    if (revision(expected?.revision) !== session.revision) throw new Error('stale_action_revision');
    if (revision(expected?.generation) !== session.generation) throw new Error('participant_generation_changed');
    if (session.pending) throw new Error('action_already_pending');
    const payload = checkAction(session.manifest, session.projection, type, value);
    const lease = session.controller?.propose(type);
    const action: Action = { action_id: `action_${randomUUID()}`, actor: 'kurisu', type, payload,
      expected_revision: session.revision, ...(lease ? { controller_lease: lease } : {}) };
    const frame = this.eventFrame(session, 'auip.action.requested', { action });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.end(session, 'disconnected', 'action_receipt_timeout'); session.socket.terminate();
      }, ACTION_TIMEOUT);
      session.pending = { action, resolve, reject, timer };
      session.socket.send(frame, error => {
        if (error && session.pending?.action === action) { this.end(session, 'disconnected', 'action_transport_failed'); session.socket.terminate(); }
      });
    });
  }

  private eventFrame(session: Session, method: string, params: JsonObject) {
    return encodeMessage({ type: 'evt', id: randomUUID(), method, params: { ...params, app_session_id: session.id } });
  }
  private push(session: Session, method: string, params: JsonObject) {
    session.socket.send(this.eventFrame(session, method, params), error => {
      if (error) session.socket.terminate();
    });
  }

  private revokeController(session: Session, reason: string) {
    const revoke = session.controller?.revoke(reason);
    if (revoke) this.push(session, 'auip.controller.revoke.requested', { revoke });
  }

  private connect(socket: WebSocket, key: string, launch: Launch) {
    let session: Session | undefined;
    const deadline = setTimeout(() => { if (!session) socket.close(1008); }, 5000);
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearTimeout(deadline);
      if (!session) return;
      this.launches.delete(key);
      if (session.status === 'connected' || session.status === 'completed') this.end(session, 'disconnected', 'connection_lost');
    });
    socket.on('message', raw => {
      let id = '?';
      let params: JsonObject;
      try {
        const request = object(JSON.parse(raw.toString()), 'invalid_envelope');
        id = boundedText(request.id, 160, 'invalid_request_id');
        if (request.type !== 'req') throw new Error('invalid_envelope');
        const input = object(request.params, 'invalid_params');
        if (!session) {
          if (request.method !== 'auip.register') throw new Error('connection_not_registered');
          if (!launch.ticket || launch.ticket !== input.attach_ticket || launch.expires <= Date.now() || !this.launches.has(key)) throw new Error('invalid_attach_ticket');
          if (!isDeepStrictEqual(parseManifest(input.manifest), launch.bundle.manifest)) throw new Error('manifest_artifact_mismatch');
          launch.ticket = undefined; clearTimeout(launch.timer); clearTimeout(deadline);
          const { manifest } = launch.bundle;
          session = { id: `app_${randomUUID()}`, artifactId: launch.bundle.artifactId, manifest, token: secret(), status: 'connected',
            mode: manifest.stances.includes('participant') ? 'collaborate' : 'observe', revision: 0, generation: 0, events: [], seen: new Map(), socket,
            controller: manifest.controller ? new Controller(manifest.controller, () => this.changed()) : undefined };
          this.sessions.set(session.id, session); this.changed();
          params = { ok: true, app_session_id: session.id, bridge_token: session.token, revision: 0 };
        } else {
          if (input.app_session_id !== session.id || input.bridge_token !== session.token) throw new Error('invalid_session_authority');
          params = this.handle(session, request.method, input, id);
        }
      } catch (error) {
        params = { ok: false, error: (error instanceof Error ? error.message : 'invalid_message').slice(0, 240) };
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encodeMessage({ type: 'res', id, method: '', params }));
        if (session?.status === 'closed') socket.close();
      }
    });
  }

  private handle(session: Session, method: unknown, params: JsonObject, requestId: string): JsonObject {
    if (method === 'auip.session.close') { this.end(session, 'closed', 'app_closed'); return { ok: true, revision: session.revision }; }
    if (session.status !== 'connected') throw new Error('session_not_active');
    if (method === 'auip.action.result') return this.resolveAction(session, params, requestId);
    if (method === 'auip.state.publish') this.publishState(session, params);
    else if (method === 'auip.event.publish') this.publishEvent(session, params);
    else if (method === 'auip.controller.status.publish' && session.controller) session.controller.report(params);
    else throw new Error('unknown_method');
    this.changed();
    return { ok: true, revision: session.revision };
  }

  private publishState(session: Session, params: JsonObject) {
    const next = revision(params.revision);
    if (next < session.revision) throw new Error('stale_revision');
    if (next === session.revision) {
      if (!isDeepStrictEqual(params.state, session.projection?.state ?? {})) throw new Error('revision_conflict');
      return;
    }
    const state = readState(params.state, session.manifest, session.projection);
    this.invalidate(session, 'action_revision_changed');
    session.revision = next; session.projection = state;
  }

  private publishEvent(session: Session, params: JsonObject) {
    const id = boundedText(params.event_id, 160, 'invalid_event_id');
    const type = boundedText(params.event_type, 120, 'invalid_event_type');
    const spec = Object.hasOwn(session.manifest.events, type) && session.manifest.events[type];
    if (!spec) throw new Error('undeclared_event');
    const actor = boundedText(params.actor ?? 'app', 24, 'invalid_actor');
    if (!['app', 'user', 'kurisu', 'system'].includes(actor)) throw new Error('invalid_actor');
    const causedBy = typeof params.caused_by_action_id === 'string' ? params.caused_by_action_id : '';
    const event = { event_id: id, type, actor, revision: revision(params.revision), payload: object(params.payload, 'invalid_event_payload'), caused_by_action_id: causedBy };
    const previous = session.seen.get(id);
    if (previous) { if (!isDeepStrictEqual(previous, event)) throw new Error('event_id_conflict'); return; }
    if (!session.projection || event.revision !== session.revision) throw new Error('event_revision_mismatch');
    if (causedBy && (session.receipt?.action_id !== causedBy || !session.receipt.accepted || session.receipt.resulting_revision !== event.revision))
      throw new Error('event_action_unverified');
    if (spec.controllerEffect && (actor !== 'app' || session.controller?.snapshot().status !== 'active'))
      throw new Error('controller_effect_without_active_lease');
    session.seen.set(id, event); session.events.push(event);
    if (session.seen.size > 128) session.seen.delete(session.seen.keys().next().value!);
    if (session.events.length > 64) session.events.shift();
    if (spec.terminal) this.end(session, 'completed', 'terminal_event');
  }

  private resolveAction(session: Session, params: JsonObject, requestId: string): JsonObject {
    const pending = session.pending;
    if (!pending || pending.action.action_id !== params.action_id) throw new Error('unknown_action');
    if (typeof params.accepted !== 'boolean') throw new Error('invalid_action_receipt');
    const next = revision(params.resulting_revision);
    const accepted = params.accepted;
    if (accepted ? next <= session.revision : next !== session.revision) throw new Error('action_receipt_revision_mismatch');
    const state = accepted ? readState(params.state, session.manifest, session.projection) : undefined;
    const receipt: Receipt = { ...pending.action, accepted, resulting_revision: next, effects: object(params.effects ?? {}, 'invalid_action_effects'),
      reason: typeof params.reason === 'string' ? params.reason.slice(0, 240) : '', resolved_at: Date.now() / 1000 };
    const response = { ok: true, revision: next, receipt };
    encodeMessage({ type: 'res', id: requestId, method: '', params: response });
    if (state) {
      if (pending.action.controller_lease) session.controller!.activate(pending.action.controller_lease);
      session.projection = state; session.revision = next;
    }
    clearTimeout(pending.timer); session.pending = undefined; session.receipt = receipt;
    pending.resolve(structuredClone(receipt)); this.changed();
    return response;
  }

  private invalidate(session: Session, reason: string) {
    const pending = session.pending;
    if (!pending) return;
    clearTimeout(pending.timer); session.pending = undefined; pending.reject(new Error(reason));
  }

  private end(session: Session, status: Exclude<Status, 'connected'>, reason: string) {
    session.status = status;
    this.invalidate(session, reason); session.controller?.reset(reason); this.changed();
  }

  async close(): Promise<void> {
    for (const launch of this.launches.values()) clearTimeout(launch.timer);
    this.launches.clear();
    for (const session of this.sessions.values()) if (session.status === 'connected' || session.status === 'completed') this.end(session, 'disconnected', 'host_closed');
    for (const socket of this.sockets?.clients ?? []) socket.terminate();
    this.sockets?.close();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}
