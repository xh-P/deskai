import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export type DshEvent = { seq: number; type: string; data?: Record<string, unknown> };
type Entry = { type: 'event'; event: DshEvent };
type History = { records: Entry[]; hasMore: boolean };
export type DshSnapshot = History & { type: 'snapshot'; cursor: number; header: { cwd?: string; id: string }; projections?: { values?: Record<string, unknown> } };
type Item = Entry | DshSnapshot | { type: 'assistant-stream'; frame: Record<string, unknown> };
export type DshFollowFrame = { type?: string; value?: unknown; error?: { code?: string } };

export interface DshWorkTransport {
  ensureHost(): Promise<{ state: string; code?: string }>;
  call<T>(endpoint: string, args: object): Promise<T>;
  sessionCall<T>(endpoint: string, request: object): Promise<T>;
  sessionFollow(request: object, onFrame: (frame: DshFollowFrame) => void): Promise<() => void>;
}

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function within<T>(promise: Promise<T>, ms: number, error: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(error)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

type Handlers = {
  ready: (snapshot: DshSnapshot, reattached: boolean) => void;
  event: (event: DshEvent) => void;
  assistant: (frame: Record<string, unknown>) => void;
  disconnected: () => void;
};

/** Open a live cut, fill any gap with dsh's backwards history pages, then consume newer events. */
export async function followDshSession(host: DshWorkTransport, sessionId: string, cwd: string, after: number | undefined,
    signal: AbortSignal, handlers: Handlers): Promise<void> {
  const address = { kind: 'session', sessionId };
  const maxMessages = 16;
  let cursor = after;
  let failures = 0;
  const apply = (event: DshEvent) => {
    if (event.seq <= cursor!) return;
    if (event.seq !== cursor! + 1) throw new Error('WORK_SESSION_EVENT_GAP');
    handlers.event(event);
    cursor = event.seq;
  };
  while (!signal.aborted) {
    let close: (() => void) | undefined;
    let wake: (() => void) | undefined;
    let closed = false;
    const queued: DshFollowFrame[] = [];
    const wakeReader = () => { wake?.(); wake = undefined; };
    const abort = () => { closed = true; close?.(); wakeReader(); };
    signal.addEventListener('abort', abort, { once: true });
    const next = async (): Promise<Item> => {
      while (!queued.length && !closed) await new Promise<void>(resolve => { wake = resolve; });
      signal.throwIfAborted();
      if (closed) throw new Error('WORK_FOLLOW_CLOSED');
      const frame = queued.shift()!;
      if (frame.type !== 'item') throw new Error(frame.error?.code ?? 'WORK_FOLLOW_CLOSED');
      return frame.value as Item;
    };
    try {
      close = await host.sessionFollow({ address, assistantStream: true, maxMessages }, frame => {
        if (frame.type === 'item' || frame.type === 'error' || frame.type === 'end') { queued.push(frame); wakeReader(); }
      });
      const opening = await within(next(), 15_000, 'WORK_SNAPSHOT_TIMEOUT');
      if (opening.type !== 'snapshot' || !Number.isSafeInteger(opening.cursor)) throw new Error('WORK_INVALID_SNAPSHOT');
      if (opening.header?.id !== sessionId || !opening.header.cwd || path.relative(cwd, opening.header.cwd)) throw new Error('WORK_SESSION_PROJECT_MISMATCH');
      const reattached = cursor !== undefined;
      if (!reattached) cursor = opening.cursor;
      else if (opening.cursor < cursor!) throw new Error('WORK_SESSION_CURSOR_REGRESSED');
      else if (opening.cursor > cursor!) {
        let page: History = { records: opening.records ?? [], hasMore: opening.hasMore };
        const pages = [page.records];
        while (page.records[0]?.event.seq > cursor! + 1 && page.hasMore) {
          signal.throwIfAborted();
          const beforeSeq = page.records[0].event.seq;
          page = await host.sessionCall<History>('session/page', { address, throughSeq: opening.cursor, beforeSeq, maxMessages });
          if (!page.records.length || page.records.at(-1)!.event.seq !== beforeSeq - 1) throw new Error('WORK_SESSION_HISTORY_GAP');
          pages.push(page.records);
        }
        signal.throwIfAborted();
        for (const records of pages.reverse()) for (const record of records) apply(record.event);
        if (cursor !== opening.cursor) throw new Error('WORK_SESSION_HISTORY_GAP');
      }
      failures = 0;
      handlers.ready(opening, reattached);
      while (!signal.aborted) {
        const item = await next();
        if (item.type === 'event') apply(item.event);
        else if (item.type === 'assistant-stream') handlers.assistant(item.frame);
        else throw new Error('WORK_UNEXPECTED_SNAPSHOT');
      }
    } catch (error) {
      if (signal.aborted) return;
      handlers.disconnected();
      if (errorMessage(error) === 'WORK_SESSION_PROJECT_MISMATCH' || ++failures >= 3) throw error;
    } finally {
      abort(); signal.removeEventListener('abort', abort);
    }
    await delay(400 * failures, undefined, { signal }).catch(() => {});
  }
}
