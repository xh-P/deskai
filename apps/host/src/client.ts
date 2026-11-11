import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import WebSocket from 'ws';
import { HOST_DESCRIPTOR, type HostDescriptor } from './api.ts';
import type { HostCommand, HostSnapshot } from './protocol.ts';
import { isWorkEffect } from '../../../packages/work-core/src/operations.ts';
import type { WorkTraceFrame } from '../../../packages/work-core/src/telemetry.ts';

class HostResponseError extends Error {}

export class HostClient {
  readonly directory: string;
  private latest?: HostSnapshot;
  private online = false;
  constructor(directory: string) { this.directory = directory; }

  private async discover(): Promise<HostDescriptor> {
    const descriptor = JSON.parse(await readFile(path.join(this.directory, HOST_DESCRIPTOR), 'utf8')) as HostDescriptor;
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(descriptor.url) || typeof descriptor.token !== 'string') throw new Error('INVALID_HOST_DESCRIPTOR');
    return descriptor;
  }

  private async request<T>(route: string, command?: HostCommand): Promise<T> {
    const { url, token } = await this.discover();
    const response = await fetch(url + route, { redirect: 'error', signal: AbortSignal.timeout(command ? 240_000 : 3000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(command ? { method: 'POST', body: JSON.stringify(command) } : {}) });
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new HostResponseError(error?.error ?? `HOST_HTTP_${response.status}`);
    }
    return await response.json() as T;
  }

  async snapshot(): Promise<HostSnapshot> {
    const snapshot = await this.request<HostSnapshot>('/snapshot');
    if (!this.online) this.latest = snapshot;
    return snapshot;
  }

  cached(): HostSnapshot | undefined { return this.latest; }
  async command<T = unknown>(input: HostCommand): Promise<T> {
    const command = input.type === 'work' && isWorkEffect(input.command) ? { ...input, operationId: input.operationId ?? randomUUID() } : input;
    const request = () => this.request<{ result: T }>('/command', command);
    const replayable = command.type === 'plan' || command.type === 'reference-select' || command.type === 'work' && isWorkEffect(command.command);
    try { return (await request()).result; }
    catch (error) {
      if (!replayable || error instanceof HostResponseError) throw error;
      return (await request()).result;
    }
  }

  watch(changed: (snapshot: HostSnapshot) => void): () => void {
    return this.subscribe<HostSnapshot>(() => '/events', snapshot => {
      this.online = true;
      this.latest = snapshot;
      changed(snapshot);
    }, () => { this.online = false; });
  }

  watchWorkTrace(taskId: string, changed: (frame: WorkTraceFrame) => void, disconnected: () => void): () => void {
    let cursor: string | undefined;
    return this.subscribe<WorkTraceFrame>(() => {
      const query = new URLSearchParams({ task: taskId });
      if (cursor) query.set('after', cursor);
      return `/work-events?${query}`;
    }, frame => {
      if (frame.taskId !== taskId || frame.type !== 'snapshot' && (frame.type !== 'delta' || frame.after !== cursor)) {
        cursor = undefined;
        throw new Error('WORK_TRACE_SEQUENCE_GAP');
      }
      cursor = frame.cursor;
      changed(frame);
    }, disconnected);
  }

  private subscribe<T>(route: () => string, changed: (value: T) => void, disconnected: () => void): () => void {
    let stopped = false;
    let socket: WebSocket | undefined;
    let retry: NodeJS.Timeout | undefined;
    const reconnect = () => {
      if (stopped) return;
      disconnected();
      retry = setTimeout(() => void connect(), 750);
    };
    const connect = async () => {
      try {
        const { url, token } = await this.discover();
        if (stopped) return;
        const peer = new WebSocket(url.replace('http:', 'ws:') + route(), {
          headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 3000
        });
        socket = peer;
        peer.on('error', () => peer.terminate());
        peer.once('close', reconnect);
        peer.on('message', raw => {
          if (stopped) return;
          try { changed(JSON.parse(raw.toString()) as T); }
          catch { peer.terminate(); return; }
        });
      } catch { reconnect(); }
    };
    void connect();
    return () => { stopped = true; clearTimeout(retry); socket?.terminate(); };
  }
}
