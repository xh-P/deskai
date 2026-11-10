import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderEvent, ProviderPort, ProviderRequest, ProviderResult } from '../../work-core/src/types.ts';
import { APP_AUTHORING_GUIDE } from '../../app-core/src/index.ts';

type Event = { seq?: number; type?: string; data?: Record<string, unknown> };
type Follow = { type?: string; cursor?: number; header?: { cwd?: string; id?: string }; event?: Event; projections?: { values?: Record<string, unknown> }; frame?: Record<string, unknown> };
export interface DshWorkTransport {
  ensureHost(): Promise<{ state: string; code?: string }>;
  call<T>(endpoint: string, args: object): Promise<T>;
  sessionCall<T>(endpoint: string, request: object): Promise<T>;
  sessionFollow(request: object, onFrame: (frame: { type?: string; value?: unknown; error?: { code?: string } }) => void): Promise<() => void>;
}
type Active = { sessionId?: string; cancelRequested: boolean; promptSubmitted: boolean; pendingTurns: number;
  requestIds: Set<string>; submissions: Set<Promise<unknown>>; removedIds: Set<string>;
  enteredTurns: Map<string, number>; endedTurns: Set<number>; currentTurn?: number;
  cancelRpc?: Promise<void>; cancelNative?: () => Promise<void>; cancelDone?: boolean;
  close?: () => void; cancelTimer?: NodeJS.Timeout; onCancelTimeout?: () => void };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function textBlocks(message: unknown): string {
  const content = record(message)?.content;
  return Array.isArray(content) ? content.filter(block => record(block)?.type === 'text').map(block => record(block)?.text).filter((s): s is string => typeof s === 'string').join('\n') : '';
}
function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
async function within<T>(promise: Promise<T>, ms: number, error: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(error)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Only files explicitly named by this attempt and still inside its project are artifacts. */
async function verifiedArtifacts(root: string, taskId: string, attemptId: string): Promise<string[]> {
  const manifest = path.join(root, '.deskai2-artifacts', `${attemptId}.json`);
  let data: unknown;
  try { data = JSON.parse(await readFile(manifest, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const row = record(data);
  if (row?.taskId !== taskId || row.attemptId !== attemptId || !Array.isArray(row.paths) || row.paths.length > 64) throw new Error('WORK_ARTIFACT_MANIFEST_INVALID');
  const canonicalRoot = await realpath(root);
  const files: string[] = [];
  for (const candidate of row.paths) {
    if (typeof candidate !== 'string' || !candidate || path.isAbsolute(candidate)) throw new Error('WORK_ARTIFACT_PATH_INVALID');
    const resolved = await realpath(path.resolve(canonicalRoot, candidate));
    const relative = path.relative(canonicalRoot, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('WORK_ARTIFACT_OUTSIDE_PROJECT');
    if (!(await stat(resolved)).isFile()) throw new Error('WORK_ARTIFACT_NOT_FILE');
    files.push(resolved);
  }
  return [...new Set(files)];
}

/** Delegates one task to a native dsh Session. The Host owns tools, audit, permissions, and persistence. */
export class DshWorkProvider implements ProviderPort {
  private active = new Map<string, Active>();
  private readonly host: DshWorkTransport;
  private readonly root: string;
  constructor(host: DshWorkTransport, root: string) { this.host = host; this.root = root; }

  async start(request: ProviderRequest, onEvent: (event: ProviderEvent) => void): Promise<ProviderResult> {
    if (this.active.has(request.attemptId)) throw new Error('WORK_ATTEMPT_BUSY');
    const active: Active = { cancelRequested: false, promptSubmitted: false, pendingTurns: 0,
      requestIds: new Set(), submissions: new Set(), removedIds: new Set(), enteredTurns: new Map(), endedTurns: new Set() };
    this.active.set(request.attemptId, active);
    let baseline = -1;
    let settled = false;
    let resolveEnd!: (result: ProviderResult) => void;
    const end = new Promise<ProviderResult>(resolve => { resolveEnd = resolve; });
    let latestSummary = '';
    const emit = (event: ProviderEvent) => { try { onEvent(event); } catch { /* UI callbacks do not own the native session. */ } };
    const settle = (result: ProviderResult) => { if (!settled) { settled = true; resolveEnd(result); } };
    const questionCallIds = new Set<string>();
    let activity = '';
    let activityTimer: NodeJS.Timeout | undefined;
    const flushActivity = () => {
      if (activityTimer) clearTimeout(activityTimer);
      activityTimer = undefined;
      if (activity) { emit({ type: 'activity', text: activity }); activity = ''; }
    };
    const queueActivity = (chunk: string) => {
      activity += chunk;
      activityTimer ??= setTimeout(flushActivity, 250);
    };
    active.onCancelTimeout = () => { active.cancelTimer ??= setTimeout(() => settle(sessionResult('unknown', 'WORK_CANCEL_UNCONFIRMED')), 30_000); };
    const sessionResult = (outcome: ProviderResult['outcome'], error?: string): ProviderResult => ({
      ...(active.sessionId ? { providerSessionId: active.sessionId } : {}), outcome,
      ...(latestSummary ? { summary: latestSummary.slice(-4000) } : {}), ...(error ? { error } : {})
    });
    const cancellationConfirmed = () => [...active.requestIds].every(id => active.removedIds.has(id) ||
      (active.enteredTurns.has(id) && active.endedTurns.has(active.enteredTurns.get(id)!)));
    const accepted = (value: { accepted: true }, code: string) => { if (value.accepted !== true) throw new Error(code); };
    const cancelNative = async () => {
      if (!active.sessionId || !active.promptSubmitted) return;
      active.cancelRpc ??= (async () => {
        const sessionId = active.sessionId!;
        // dsh cancel keeps the inbox. Stop the live turn promptly, then wait for
        // submissions already in flight before removing only this attempt's rows.
        const cancel = () => this.host.sessionCall<{ accepted: true }>('session/cancel', { sessionId })
          .then(value => accepted(value, 'WORK_CANCEL_REJECTED'));
        const firstCancel = cancel();
        await Promise.allSettled([...active.submissions, firstCancel]);
        await firstCancel;
        for (let pass = 0; pass <= active.requestIds.size; pass++) {
          const projection = await this.host.sessionCall<{ values?: Record<string, unknown> } | null>('session/projections', { sessionId });
          const inbox = record(projection?.values?.inbox);
          const rows = [...(Array.isArray(inbox?.['next-turn']) ? inbox['next-turn'] : []),
            ...(Array.isArray(inbox?.['next-step']) ? inbox['next-step'] : [])];
          const own = rows.map(record).filter((row): row is Record<string, unknown> =>
            !!row && typeof row.id === 'string' && active.requestIds.has(String(record(row.source)?.rpcId)));
          if (!own.length) break;
          for (const row of own) {
            try {
              const value = await this.host.sessionCall<{ accepted: true }>('session/updateQueue',
                { sessionId, itemId: row.id, action: { kind: 'remove' } });
              accepted(value, 'WORK_QUEUE_REMOVE_REJECTED');
              active.removedIds.add(String(record(row.source)?.rpcId));
            } catch (error) {
              if (failure(error) !== 'session/queue-item-not-found') throw error;
            }
          }
          // A queued row may have become the live turn during removal.
          await cancel();
        }
        const finalProjection = await this.host.sessionCall<{ values?: Record<string, unknown> } | null>('session/projections', { sessionId });
        const finalInbox = record(finalProjection?.values?.inbox);
        const remaining = [...(Array.isArray(finalInbox?.['next-turn']) ? finalInbox['next-turn'] : []),
          ...(Array.isArray(finalInbox?.['next-step']) ? finalInbox['next-step'] : [])];
        if (remaining.some(value => active.requestIds.has(String(record(record(value)?.source)?.rpcId))))
          throw new Error('WORK_QUEUE_NOT_CLEARED');
        // An in-flight prompt can leave the inbox and enter a new turn after
        // the first cancellation, so cancel once more after admissions settle.
        await cancel();
        active.cancelDone = true;
        if (cancellationConfirmed())
          settle(sessionResult('cancelled'));
        else active.onCancelTimeout?.();
      })();
      await active.cancelRpc;
    };
    active.cancelNative = cancelNative;
    const handle = (raw: { type?: string; value?: unknown; error?: { code?: string } }) => {
      if (raw.type === 'error') { flushActivity(); settle(sessionResult('interrupted', raw.error?.code ?? 'WORK_FOLLOW_FAILED')); return; }
      if (raw.type !== 'item') return;
      const item = raw.value as Follow | undefined;
      if (item?.type === 'snapshot') {
        baseline = item.cursor ?? -1;
        const header = item.header;
        if (!header || header.id !== active.sessionId || typeof header.cwd !== 'string' || path.resolve(header.cwd).toLowerCase() !== path.resolve(request.projectPath).toLowerCase())
          settle(sessionResult('failed', 'WORK_SESSION_PROJECT_MISMATCH'));
        return;
      }
      if (item?.type === 'assistant-stream') {
        const frame = item.frame;
        if (frame?.type === 'chunk') {
          const chunk = record(frame.chunk);
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') queueActivity(chunk.text);
        }
        return;
      }
      if (item?.type !== 'event' || !item.event || (item.event.seq ?? -1) <= baseline) return;
      const event = item.event;
      const data = event.data ?? {};
      if (event.type === 'turn/start') {
        if (typeof data.turn === 'number') active.currentTurn = data.turn;
      } else if (event.type === 'user/message') {
        const source = record(data.source);
        if (source?.kind === 'user-question-reply' && typeof source.callId === 'string' && questionCallIds.delete(source.callId))
          emit({ type: 'request-resolved', requestId: source.callId });
        if (typeof source?.rpcId === 'string' && active.requestIds.has(source.rpcId) && active.currentTurn !== undefined)
          active.enteredTurns.set(source.rpcId, active.currentTurn);
      } else if (event.type === 'assistant/message') {
        const summary = textBlocks(data.message);
        if (summary) latestSummary = summary;
      } else if (event.type === 'tool/call') {
        flushActivity();
        const name = typeof data.name === 'string' ? data.name : 'tool';
        emit({ type: 'activity', text: `dsh: ${name}`, data: { eventType: event.type, callId: data.callId } });
        if (/ask_user_question/i.test(name) && typeof data.callId === 'string') {
          questionCallIds.add(data.callId);
          let argumentsValue: unknown;
          try { argumentsValue = JSON.parse(String(data.arguments ?? '{}')); } catch { argumentsValue = {}; }
          emit({ type: 'question', requestId: data.callId, text: 'dsh 需要你的回答', data: argumentsValue });
        }
      } else if (event.type === 'approval/asked') {
        flushActivity();
        emit({ type: 'permission', requestId: String(data.id ?? ''), text: String(data.reason ?? data.toolName ?? 'dsh 需要授权'), data });
      } else if (event.type === 'approval/decided') {
        if (typeof data.id === 'string') emit({ type: 'request-resolved', requestId: data.id });
      } else if (event.type === 'tool/result') {
        flushActivity();
        const message = record(data.message);
        const toolError = record(data.error);
        if (typeof message?.toolCallId === 'string' && questionCallIds.has(message.toolCallId) && toolError?.code !== 'TOOL_OUTCOME_UNKNOWN') {
          const content = Array.isArray(message.content) ? message.content : [];
          const pending = content.some(block => {
            const row = record(block);
            if (row?.type !== 'text' || typeof row.text !== 'string') return false;
            try { return record(JSON.parse(row.text))?.pending === true; } catch { return false; }
          });
          if (!pending) { questionCallIds.delete(message.toolCallId); emit({ type: 'request-resolved', requestId: message.toolCallId }); }
        }
        if (toolError?.code === 'AUTO_REVIEW_DENIED') emit({ type: 'activity', text: `Auto review 拒绝了 ${String(data.message ? record(data.message)?.toolCallId ?? 'tool' : 'tool')}`, data: { code: 'AUTO_REVIEW_DENIED' } });
      } else if (event.type === 'turn/end') {
        flushActivity();
        const reason = record(data.reason);
        const kind = reason?.kind;
        const turn = typeof data.turn === 'number' ? data.turn : undefined;
        const owned = turn === undefined ? 0 : [...active.enteredTurns.values()].filter(value => value === turn).length;
        if (turn !== undefined) active.endedTurns.add(turn);
        if (owned) active.pendingTurns = Math.max(0, active.pendingTurns - owned);
        if (active.cancelRequested) {
          if (active.cancelDone && cancellationConfirmed()) settle(sessionResult('cancelled'));
          return;
        }
        if (!owned) return;
        if (kind === 'completed') { if (active.pendingTurns === 0) settle(sessionResult('completed')); }
        else if (kind === 'aborted') settle(sessionResult('cancelled'));
        else if (kind === 'interrupted') settle(sessionResult('interrupted'));
        else settle(sessionResult('failed', typeof record(reason?.error)?.code === 'string' ? String(record(reason?.error)?.code) : String(kind ?? 'WORK_TURN_FAILED')));
      }
    };
    try {
      const ready = await this.host.ensureHost();
      if (ready.state !== 'ready') throw new Error(ready.code ?? 'WORK_HOST_UNAVAILABLE');
      if (active.cancelRequested) return sessionResult('cancelled');
      if (request.providerSessionId) active.sessionId = request.providerSessionId;
      else {
        const created = await this.host.sessionCall<{ sessionId: string }>('session/create', { cwd: request.projectPath });
        if (!created.sessionId) throw new Error('WORK_CREATE_FAILED');
        active.sessionId = created.sessionId;
      }
      emit({ type: 'session', providerSessionId: active.sessionId });
      if (active.cancelRequested) return sessionResult('cancelled');
      let snapshotReady!: () => void;
      const snapshot = new Promise<void>(resolve => { snapshotReady = resolve; });
      const wrappedHandle = (raw: Parameters<typeof handle>[0]) => {
        if (raw.type === 'error' || raw.type === 'item' && (raw.value as Follow | undefined)?.type === 'snapshot') snapshotReady();
        handle(raw);
      };
      active.close = await this.host.sessionFollow({ address: { kind: 'session', sessionId: active.sessionId }, assistantStream: true, maxMessages: 16 }, wrappedHandle);
      await within(snapshot, 15_000, 'WORK_SNAPSHOT_TIMEOUT');
      if (settled) return await end;
      if (active.cancelRequested) return sessionResult('cancelled');
      const catalog = await this.host.call<{ options?: { value?: string }[] }>('permissionPresets/catalog', {});
      if (!catalog.options?.some(option => option.value === 'auto')) throw new Error('WORK_AUTO_REVIEW_UNAVAILABLE');
      const command = await this.host.call<{ result?: { kind?: string; text?: string } }>('commands/execute', {
        agentId: active.sessionId, line: '/permission auto', submittedAttachments: []
      });
      if (command?.result?.kind !== 'success') throw new Error('WORK_AUTO_REVIEW_FAILED');
      if (active.cancelRequested) return sessionResult('cancelled');
      const manifest = path.join(request.projectPath, '.deskai2-artifacts', `${request.attemptId}.json`);
      const artifactInstructions = `\n\nDeskAI task artifact protocol: If you create or modify files that the user should open, write a JSON manifest at ${manifest} with exactly {"taskId":${JSON.stringify(request.taskId)},"attemptId":${JSON.stringify(request.attemptId)},"paths":["project-relative/file.ext"]}. Include only actual files you produced for this task. Do not list the manifest itself. Paths must remain inside the current project directory. This is a task-scoped handoff, not a claim that a file exists.`;
      const authoringInstructions = request.authoring ? `\n\nDeskAI cooperative app authoring:\n${APP_AUTHORING_GUIDE}\nHelper source: ${path.join(this.root, 'packages/app-core/examples/deskai-app-client.js')}. Embed this helper's actual source in the HTML file.` : '';
      active.promptSubmitted = true;
      active.pendingTurns++;
      const requestId = randomUUID();
      active.requestIds.add(requestId);
      const submission = this.host.sessionCall<{ accepted: true }>('session/prompt', {
        requestId, sessionId: active.sessionId, mode: 'queue', content: [{ type: 'text', text: request.prompt + artifactInstructions + authoringInstructions }]
      });
      active.submissions.add(submission);
      const receipt = await submission.finally(() => active.submissions.delete(submission));
      if (receipt.accepted !== true) throw new Error('WORK_PROMPT_REJECTED');
      if (active.cancelRequested) await cancelNative();
      return await within(end, 30 * 60_000, 'WORK_SETTLEMENT_TIMEOUT').catch(error => sessionResult('unknown', failure(error)));
    } catch (error) {
      return sessionResult(active.cancelRequested ? active.promptSubmitted ? 'unknown' : 'cancelled' : 'failed', failure(error));
    } finally {
      flushActivity();
      if (active.cancelTimer) clearTimeout(active.cancelTimer);
      active.close?.();
      this.active.delete(request.attemptId);
      try { for (const file of await verifiedArtifacts(request.projectPath, request.taskId, request.attemptId)) emit({ type: 'artifact', path: file }); }
      catch { emit({ type: 'activity', text: '产物清单无效；请在任务工作台检查生成文件。' }); }
    }
  }

  async cancel(attemptId: string): Promise<void> {
    const active = this.active.get(attemptId);
    if (!active) throw new Error('WORK_ATTEMPT_NOT_ACTIVE');
    active.cancelRequested = true;
    if (!active.sessionId || !active.promptSubmitted) return;
    await active.cancelNative?.();
  }

  async append(attemptId: string, prompt: string): Promise<void> {
    const active = this.active.get(attemptId);
    if (!active?.sessionId || active.cancelRequested) throw new Error('WORK_SESSION_NOT_READY');
    if (!prompt.trim()) throw new Error('WORK_INPUT_EMPTY');
    active.pendingTurns++;
    const requestId = randomUUID();
    active.requestIds.add(requestId);
    try {
      const submission = this.host.sessionCall<{ accepted: true }>('session/prompt', {
        requestId, sessionId: active.sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }]
      });
      active.submissions.add(submission);
      const receipt = await submission.finally(() => active.submissions.delete(submission));
      if (receipt.accepted !== true) throw new Error('WORK_APPEND_REJECTED');
    } catch (error) { active.pendingTurns--; active.requestIds.delete(requestId); throw error; }
    if (active.cancelRequested) await active.cancelNative?.();
  }

  async reply(attemptId: string, requestId: string, response: unknown): Promise<void> {
    const active = this.active.get(attemptId);
    if (!active?.sessionId) throw new Error('WORK_SESSION_NOT_READY');
    const answer = record(response);
    if (!Array.isArray(answer?.answers)) throw new Error('WORK_QUESTION_ANSWER_INVALID');
    const accepted = await this.host.call<boolean>('userQuestions/answer', {
      agentId: active.sessionId, callId: requestId, answer
    });
    if (!accepted) throw new Error('WORK_QUESTION_NOT_PENDING');
  }
}
