export type TokenUsage = {
  inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number;
  reasoningTokens?: number; totalTokens?: number;
};

export type ModelTelemetry = {
  provider?: string; model?: string; thinking?: string; reasoningEffort?: string;
  usage?: TokenUsage; elapsedMs?: number; firstTokenMs?: number;
};

export type PlannerRequest = { at: number; sessionId: string; metrics: ModelTelemetry; state?: 'completed' | 'failed' | 'interrupted' };
export type WorkDelegation = { at: number; text: string; target: string; requests: PlannerRequest[] };

export type TraceState = 'running' | 'completed' | 'failed' | 'interrupted' | 'waiting';
export type NativeTrace = {
  key: string;
  at: number;
  kind: 'model' | 'tool' | 'connection';
  title: string;
  state: TraceState;
  text?: string;
  elapsedMs?: number;
  metrics?: ModelTelemetry;
  turn?: number;
  step?: number;
  callId?: string;
};

export type TraceActor = 'user' | 'dispatcher' | 'host' | 'executor';
export type WorkTraceEntry = Omit<NativeTrace, 'key' | 'kind' | 'state'> & {
  id: string;
  attemptId: string;
  kind: NativeTrace['kind'] | 'message' | 'receipt' | 'status' | 'request' | 'delivery';
  actor: TraceActor;
  recipient?: TraceActor;
  state?: TraceState;
  operationId?: string;
  conversationId?: string;
  sessionId?: string;
  sourceSeq?: number;
};

export type ModelTotals = {
  requests: number; reported: number; output: number; reasoning?: number;
  cache?: { read: number; input: number; requests: number };
};
export type AttemptTelemetry = { dispatcher: ModelTotals; executor: ModelTotals };

export type WorkTraceFrame =
  | { type: 'snapshot'; taskId: string; cursor: string; rows: WorkTraceEntry[]; older: boolean; totals: Record<string, AttemptTelemetry> }
  | { type: 'delta'; taskId: string; after: string; cursor: string; rows: WorkTraceEntry[]; removed: string[];
    older: boolean; totals: Record<string, AttemptTelemetry> };

export type WorkTracePage = { rows: WorkTraceEntry[]; older: boolean };
export type WorkTraceUpdate = WorkTraceFrame | { type: 'disconnected'; taskId: string };

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function parseUsage(value: unknown): TokenUsage | undefined {
  const data = asRecord(value);
  if (!data) return;
  const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const inputTokens = count(data.inputTokens), outputTokens = count(data.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return;
  return { inputTokens, outputTokens, cacheReadTokens: count(data.cacheReadTokens),
    cacheWriteTokens: count(data.cacheWriteTokens), reasoningTokens: count(data.reasoningTokens), totalTokens: count(data.totalTokens) };
}

export function parseModelTelemetry(value: unknown): ModelTelemetry {
  const data = asRecord(value) ?? {};
  const label = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 160) : undefined;
  const duration = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  return { provider: label(data.provider), model: label(data.model), thinking: label(data.thinking),
    reasoningEffort: label(data.reasoningEffort), usage: parseUsage(data.usage),
    elapsedMs: duration(data.elapsedMs), firstTokenMs: duration(data.firstTokenMs) };
}

export function parsePlannerRequests(value: unknown): PlannerRequest[] {
  if (!Array.isArray(value)) return [];
  const requests: PlannerRequest[] = [];
  for (const item of value.slice(0, 32)) {
    const request = asRecord(item);
    if (!request || typeof request.at !== 'number' || !Number.isFinite(request.at) || request.at < 0 ||
        request.at > 8.64e15 || typeof request.sessionId !== 'string' || !/^[\w-]{1,128}$/.test(request.sessionId)) continue;
    const state = request.state === 'failed' || request.state === 'interrupted' ? request.state : 'completed';
    requests.push({ at: request.at, sessionId: request.sessionId, metrics: parseModelTelemetry(request.metrics), state });
  }
  return requests;
}

export function traceOrder(a: WorkTraceEntry, b: WorkTraceEntry): number {
  return a.at - b.at || (a.sourceSeq ?? 0) - (b.sourceSeq ?? 0) || a.id.localeCompare(b.id);
}

export function cacheUsage(usage: TokenUsage): { read: number; input: number } | undefined {
  const read = usage.cacheReadTokens;
  if (read === undefined) return;
  const input = usage.inputTokens + read + (usage.cacheWriteTokens ?? 0);
  if (usage.totalTokens === undefined || input + usage.outputTokens === usage.totalTokens) return { read, input };
}

export function summarizeModels(rows: readonly WorkTraceEntry[]): Record<string, AttemptTelemetry> {
  const empty = (): ModelTotals => ({ requests: 0, reported: 0, output: 0 });
  const result: Record<string, AttemptTelemetry> = {};
  for (const row of rows) {
    if (row.kind !== 'model' || (row.actor !== 'dispatcher' && row.actor !== 'executor')) continue;
    const attempt = result[row.attemptId] ??= { dispatcher: empty(), executor: empty() };
    const total = attempt[row.actor];
    total.requests++;
    const usage = row.metrics?.usage;
    if (!usage) continue;
    total.reported++;
    total.output += usage.outputTokens;
    if (usage.reasoningTokens !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoningTokens;
    const counted = cacheUsage(usage);
    if (!counted) continue;
    const cache = total.cache ??= { read: 0, input: 0, requests: 0 };
    cache.read += counted.read;
    cache.input += counted.input;
    cache.requests++;
  }
  return result;
}
