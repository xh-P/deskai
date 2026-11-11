import { randomUUID } from 'node:crypto';
import { completionLabel, workExecutionLabel, workOperationLabel } from '../../../packages/work-core/src/completion.ts';
import { asRecord, summarizeModels, traceOrder, type NativeTrace, type WorkTraceEntry, type WorkTraceFrame, type WorkTracePage } from '../../../packages/work-core/src/telemetry.ts';
import type { ProviderEvent, WorkHistory } from '../../../packages/work-core/src/types.ts';

const pageSize = 160;
const replaySize = 96;
const cachedFeeds = 24;
const actionName = { submit: '委派任务', append: '追加要求', continue: '继续任务', retry: '重试任务', cancel: '取消任务',
  recover: '恢复执行', reply: '提交答复' };
const liveStatus = new Set(['queued', 'running', 'waiting']);
const text = (value: unknown) => typeof value === 'string' && value ? value.slice(0, 4000) : undefined;
const requestText = (value: unknown) => {
  const questions = asRecord(value)?.questions;
  return Array.isArray(questions) ? questions.map(question => text(asRecord(question)?.question)).filter(Boolean).join('\n') : undefined;
};
const answerText = (value: unknown) => {
  const answers = asRecord(value)?.answers;
  return Array.isArray(answers) ? answers.map(answer => {
    const data = asRecord(answer);
    const choices = Array.isArray(data?.selected) ? data.selected.map(text).filter(Boolean) : [];
    return [...choices, text(data?.custom)].filter(Boolean).join('、');
  }).filter(Boolean).join('\n') : undefined;
};

function nativeEntry(attemptId: string, { key, ...entry }: NativeTrace, sourceSeq?: number, sessionId?: string): WorkTraceEntry {
  return { ...entry, id: `${attemptId}:dsh:${key}`, attemptId, actor: 'executor', sourceSeq, sessionId,
    ...(entry.kind === 'model' && entry.text ? { recipient: 'dispatcher' as const } : {}) };
}

function historyEntries(history: WorkHistory): WorkTraceEntry[] {
  const { attempts, operations, events } = history;
  const sessions = new Map(attempts.map(attempt => [attempt.id, attempt.providerSessionId]));
  const byOperation = new Map(operations.map(op => [op.id, op]));
  const rows = new Map<string, WorkTraceEntry>();
  const add = (row: WorkTraceEntry) => rows.set(row.id, row);
  for (const operation of operations) {
    const { delegation, id, attemptId, state, acceptedAt, conversationId } = operation;
    const at = Date.parse(acceptedAt);
    if (delegation) {
      add({ id: `origin:${id}`, at: delegation.at, attemptId, operationId: id, conversationId, actor: 'user', recipient: 'dispatcher',
        kind: 'message', title: '任务意图', text: delegation.text });
      delegation.requests.forEach((request, index) => add({ id: `plan:${id}:${index}`, at: request.at, attemptId, operationId: id,
        sessionId: request.sessionId, actor: 'dispatcher', kind: 'model', title: '调度模型请求',
        state: request.state ?? 'completed', metrics: request.metrics }));
    }
    add({ id: `receipt:${id}`, at, attemptId, operationId: id, conversationId, sessionId: sessions.get(attemptId), actor: 'host',
      recipient: delegation ? 'dispatcher' : 'user', kind: 'receipt',
      title: `${actionName[operation.kind]} · ${workOperationLabel(state)}`,
      text: operation.error ?? delegation?.target, state: state === 'unknown' || state === 'pending' ? 'waiting' : 'completed' });
  }
  for (const event of events) {
    const { attemptId, providerSeq } = event;
    const sessionId = sessions.get(attemptId);
    if (event.type === 'trace') { add(nativeEntry(attemptId, event.data as NativeTrace, providerSeq, sessionId)); continue; }
    const data = asRecord(event.data);
    const operationId = typeof data?.operationId === 'string' ? data.operationId : undefined;
    const operation = operationId ? byOperation.get(operationId) : undefined;
    const base = { id: event.id, attemptId, at: Date.parse(event.time), operationId, conversationId: operation?.conversationId,
      sessionId, sourceSeq: providerSeq };
    const requestId = typeof data?.requestId === 'string' ? `${attemptId}:request:${data.requestId}` : undefined;
    switch (event.type) {
      case 'submitted': case 'input-added': case 'cancel_requested': case 'recovery_requested': case 'reply':
        add({ ...base, kind: 'message', actor: operation?.delegation ? 'dispatcher' : 'user', recipient: 'executor',
          title: operation ? actionName[operation.kind] : event.type === 'reply' ? '提交答复' : '任务指令',
          text: text(data?.prompt) ?? answerText(data?.response), state: 'completed' });
        if (event.type === 'reply' && requestId) resolveRequest(requestId);
        break;
      case 'question': case 'permission':
        if (!requestId || rows.has(requestId)) break;
        add({ ...base, id: requestId, kind: 'request', actor: 'executor', recipient: 'user',
          title: event.type === 'question' ? '请求答复' : '请求授权', text: requestText(data?.data) || text(data?.text), state: 'waiting' });
        break;
      case 'request-resolved':
        if (requestId) resolveRequest(requestId);
        add({ ...base, kind: 'status', actor: 'executor', recipient: 'host', title: '输入已处理', state: 'completed' });
        break;
      case 'session':
        add({ ...base, kind: 'connection', actor: 'executor', recipient: 'host', title: '原生会话已连接', state: 'completed' });
        break;
      case 'settled': {
        const attempt = attempts.find(item => item.id === attemptId);
        if (!attempt) break;
        const outcome = typeof data?.outcome === 'string' ? data.outcome : attempt.status;
        const review = asRecord(data?.assessment)?.review;
        const label = workExecutionLabel(outcome);
        add({ ...base, kind: 'status', actor: 'executor', recipient: 'host', title: `执行回报 · ${label}`,
          text: text(data?.error) ?? (review === 'review_ready' ? completionLabel(attempt.assessment!) : undefined),
          state: outcome === 'completed' ? 'completed' : outcome === 'unknown' ? 'waiting' : outcome === 'failed' ? 'failed' : 'interrupted' });
        break;
      }
      case 'verified_artifact':
        add({ ...base, kind: 'delivery', actor: 'host', title: '文件已核验', text: text(data?.relativePath), state: 'completed' });
        break;
      case 'accepted':
        add({ ...base, kind: 'delivery', actor: 'user', recipient: 'host', title: '确认验收', state: 'completed' });
        break;
      case 'activity':
        if (data?.data && asRecord(data.data)?.code) add({ ...base, kind: 'status', actor: 'executor',
          title: '原生执行反馈', text: text(data.text), state: 'failed' });
        break;
    }
  }
  return [...rows.values()];

  function resolveRequest(id: string): void {
    const request = rows.get(id);
    if (request) request.state = 'completed';
  }
}

type Snapshot = Extract<WorkTraceFrame, { type: 'snapshot' }>;
type Delta = Extract<WorkTraceFrame, { type: 'delta' }>;
type Scope = {
  live: Map<string, WorkTraceEntry>;
  listeners: Set<(frame: WorkTraceFrame) => void>;
  replay: Delta[];
  current?: Snapshot;
  durable?: { rows: WorkTraceEntry[]; attempts: Map<string, WorkHistory['attempts'][number]> };
};

/** A bounded live view over the Work ledger. Cursor gaps reset from persisted facts. */
export class WorkTraceFeed {
  private readonly read: (taskId: string) => WorkHistory;
  private readonly scopes = new Map<string, Scope>();
  private readonly epoch = randomUUID();
  private readonly dirty = new Set<string>();
  private queued = false;
  private revision = 0;

  constructor(read: (taskId: string) => WorkHistory) { this.read = read; }

  private scope(taskId: string): Scope {
    const scope = this.scopes.get(taskId) ?? { live: new Map(), listeners: new Set(), replay: [] };
    this.scopes.delete(taskId);
    this.scopes.set(taskId, scope);
    if (this.scopes.size > cachedFeeds) {
      const evict = [...this.scopes].find(([id, item]) => id !== taskId && !item.listeners.size && !item.live.size);
      if (evict) this.scopes.delete(evict[0]);
    }
    return scope;
  }

  observe(taskId: string, attemptId: string, event: Extract<ProviderEvent, { type: 'trace' }>): void {
    const existing = this.scopes.get(taskId);
    if (!existing && event.providerSeq !== undefined) return;
    const scope = existing ?? this.scope(taskId);
    const row = nativeEntry(attemptId, event.entry, event.providerSeq);
    if (event.providerSeq === undefined) scope.live.set(row.id, row);
    else { scope.durable = undefined; scope.live.delete(row.id); }
    this.schedule(taskId);
  }

  changed(): void {
    for (const [id, scope] of this.scopes) { scope.durable = undefined; this.schedule(id); }
  }

  private schedule(taskId: string): void {
    this.dirty.add(taskId);
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      const dirty = [...this.dirty]; this.dirty.clear();
      for (const id of dirty) {
        const scope = this.scopes.get(id);
        if (scope) this.refresh(id, scope);
      }
    });
  }

  private rows(taskId: string, scope?: Scope): WorkTraceEntry[] {
    const read = () => {
      const history = this.read(taskId);
      return { rows: historyEntries(history).sort(traceOrder), attempts: new Map(history.attempts.map(attempt => [attempt.id, attempt])) };
    };
    if (!scope) return read().rows;
    const durable = scope.durable ??= read();
    if (!scope.live.size) return durable.rows;
    const live = [];
    for (const [id, entry] of scope.live) {
      const attempt = durable.attempts.get(entry.attemptId);
      if (!attempt || !liveStatus.has(attempt.status)) scope.live.delete(id);
      else live.push({ ...entry, sessionId: attempt.providerSessionId });
    }
    return [...durable.rows, ...live].sort(traceOrder);
  }

  private refresh(taskId: string, scope: Scope): Snapshot {
    const full = this.rows(taskId, scope);
    const rows = full.slice(-pageSize);
    const totals = summarizeModels(full);
    const older = full.length > rows.length;
    const previous = scope.current;
    const before = new Map(previous?.rows.map(row => [row.id, JSON.stringify(row)]));
    const updated = rows.filter(row => {
      const prior = before.get(row.id); before.delete(row.id);
      return prior !== JSON.stringify(row);
    });
    if (previous && !updated.length && !before.size && previous.older === older && JSON.stringify(previous.totals) === JSON.stringify(totals)) return previous;
    const cursor = `${this.epoch}:${++this.revision}`;
    const snapshot: Snapshot = { type: 'snapshot', taskId, cursor, rows, older, totals };
    scope.current = snapshot;
    if (previous) {
      const delta: Delta = { type: 'delta', taskId, after: previous.cursor, cursor, rows: updated, removed: [...before.keys()], older, totals };
      scope.replay.push(delta);
      if (scope.replay.length > replaySize) scope.replay.shift();
      for (const listener of scope.listeners) listener(delta);
    }
    return snapshot;
  }

  subscribe(taskId: string, after: string | undefined, listener: (frame: WorkTraceFrame) => void): () => void {
    this.read(taskId);
    const scope = this.scope(taskId);
    const snapshot = this.refresh(taskId, scope);
    const start = scope.replay.findIndex(delta => delta.after === after);
    if (start >= 0) for (const delta of scope.replay.slice(start)) listener(delta);
    else if (after === snapshot.cursor) listener({ type: 'delta', taskId, after, cursor: after, rows: [], removed: [],
      older: snapshot.older, totals: snapshot.totals });
    else listener(snapshot);
    scope.listeners.add(listener);
    return () => scope.listeners.delete(listener);
  }

  page(taskId: string, before: string): WorkTracePage {
    const rows = this.rows(taskId, this.scopes.get(taskId));
    const index = rows.findIndex(row => row.id === before);
    if (index < 0) throw new Error('WORK_TRACE_CURSOR_EXPIRED');
    return { rows: rows.slice(Math.max(0, index - pageSize), index), older: index > pageSize };
  }
}
