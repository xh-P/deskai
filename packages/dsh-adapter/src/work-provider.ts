import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderBinding, ProviderEvent, ProviderPort, ProviderRequest, ProviderResult } from '../../work-core/src/types.ts';
import { APP_AUTHORING_GUIDE } from '../../app-core/src/index.ts';
import { errorMessage, followDshSession, within, type DshEvent, type DshWorkTransport } from './session-feed.ts';

export type { DshWorkTransport } from './session-feed.ts';
type Active = { sessionId?: string; baseline?: number; connected: boolean; acceptingInput: boolean; cancelRequested: boolean;
  requestIds: Set<string>; submissions: Set<Promise<unknown>>; removedIds: Set<string>;
  enteredTurns: Map<string, number>; endedTurns: Map<number, ProviderResult>; currentTurn?: number;
  saveBinding: () => void; settleKnown: () => void;
  cancelRpc?: Promise<void>; cancelNative?: () => Promise<void>; cancelDone?: boolean;
  cancelTimer?: NodeJS.Timeout };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function textBlocks(message: unknown): string {
  const content = record(message)?.content;
  return Array.isArray(content) ? content.filter(block => record(block)?.type === 'text').map(block => record(block)?.text).filter((s): s is string => typeof s === 'string').join('\n') : '';
}
function inboxRows(value: unknown): Record<string, unknown>[] {
  const inbox = record(value);
  return ['next-turn', 'next-step'].flatMap(target => {
    const rows = inbox?.[target];
    return Array.isArray(rows) ? rows.map(record).filter(row => row !== undefined) : [];
  });
}
const requestIdOf = (row: Record<string, unknown>) => String(record(row.source)?.rpcId ?? '');
const promptRejected = new Set(['WORK_PROMPT_REJECTED', 'session/not-found', 'session/provider-credentials-unavailable',
  'session/provider-models-unavailable', 'session/model-unavailable', 'session/attachment-invalid', 'session/writer-held']);

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

  start(request: ProviderRequest, onEvent: (event: ProviderEvent) => void): Promise<ProviderResult> {
    return this.execute(request, onEvent);
  }

  recover(request: ProviderRequest & { providerSessionId: string; binding: ProviderBinding }, onEvent: (event: ProviderEvent) => void): Promise<ProviderResult> {
    return this.execute(request, onEvent, request.binding);
  }

  private async execute(request: ProviderRequest, onEvent: (event: ProviderEvent) => void, binding?: ProviderBinding): Promise<ProviderResult> {
    const result = await this.run(request, onEvent, binding);
    if (!result.unsettled) {
      try { for (const file of await verifiedArtifacts(request.projectPath, request.taskId, request.attemptId)) onEvent({ type: 'artifact', path: file }); }
      catch { onEvent({ type: 'activity', text: '产物清单无效，请在任务工作台检查生成文件。' }); }
    }
    return result;
  }

  private async run(request: ProviderRequest, emit: (event: ProviderEvent) => void, binding?: ProviderBinding): Promise<ProviderResult> {
    if (this.active.has(request.attemptId)) throw new Error('WORK_ATTEMPT_BUSY');
    const active: Active = { baseline: binding?.baseline, connected: false, acceptingInput: false, cancelRequested: false,
      requestIds: new Set(binding?.requestIds), submissions: new Set(), removedIds: new Set(binding?.removedIds),
      enteredTurns: new Map(), endedTurns: new Map(),
      saveBinding: () => emit({ type: 'binding', binding: { baseline: active.baseline!, requestIds: [...active.requestIds], removedIds: [...active.removedIds] } }),
      settleKnown: () => settleKnown() };
    this.active.set(request.attemptId, active);
    const feed = new AbortController();
    let settled = false;
    let resolveEnd!: (result: ProviderResult) => void;
    const end = new Promise<ProviderResult>(resolve => { resolveEnd = resolve; });
    let latestSummary = '';
    const settle = (result: ProviderResult) => { if (!settled) { settled = true; resolveEnd(result); } };
    const questionCallIds = new Set<string>();
    let activity = '';
    let activityTimer: NodeJS.Timeout | undefined;
    const flushActivity = () => {
      if (activityTimer) clearTimeout(activityTimer);
      activityTimer = undefined;
      if (activity) { const text = activity; activity = ''; emit({ type: 'activity', text }); }
    };
    const queueActivity = (chunk: string) => {
      activity += chunk;
      activityTimer ??= setTimeout(() => {
        try { flushActivity(); } catch (error) { settle(sessionResult('unknown', errorMessage(error), true)); }
      }, 250);
    };
    const sessionResult = (outcome: ProviderResult['outcome'], error?: string, unsettled?: boolean): ProviderResult => ({
      ...(active.sessionId ? { providerSessionId: active.sessionId } : {}), outcome,
      ...(latestSummary ? { summary: latestSummary.slice(-4000) } : {}), ...(error ? { error } : {}), ...(unsettled ? { unsettled } : {})
    });
    const settledRequest = (id: string): ProviderResult | undefined => active.removedIds.has(id) ? { outcome: 'cancelled' }
      : active.endedTurns.get(active.enteredTurns.get(id)!);
    const settleKnown = () => {
      if (!active.requestIds.size || active.cancelRequested && !active.cancelDone) return;
      const results = [...active.requestIds].map(settledRequest);
      if (results.some(result => result === undefined)) return;
      const firstIncomplete = results.find(result => result?.outcome !== 'completed');
      const outcome = firstIncomplete?.outcome ?? 'completed';
      settle(sessionResult(outcome, firstIncomplete?.error));
    };
    const accepted = (value: { accepted: true }, code: string) => { if (value.accepted !== true) throw new Error(code); };
    const cancelNative = async () => {
      if (!active.sessionId || !active.requestIds.size) return;
      active.cancelTimer ??= setTimeout(() => settle(sessionResult('unknown', 'WORK_CANCEL_UNCONFIRMED', true)), 30_000);
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
          const own = inboxRows(projection?.values?.inbox).filter(row => typeof row.id === 'string' && active.requestIds.has(requestIdOf(row)));
          if (!own.length) break;
          for (const row of own) {
            try {
              const value = await this.host.sessionCall<{ accepted: true }>('session/updateQueue',
                { sessionId, itemId: row.id, action: { kind: 'remove' } });
              accepted(value, 'WORK_QUEUE_REMOVE_REJECTED');
              active.removedIds.add(requestIdOf(row)); active.saveBinding();
            } catch (error) {
              if (errorMessage(error) !== 'session/queue-item-not-found') throw error;
            }
          }
          // A queued row may have become the live turn during removal.
          await cancel();
        }
        const finalProjection = await this.host.sessionCall<{ values?: Record<string, unknown> } | null>('session/projections', { sessionId });
        if (inboxRows(finalProjection?.values?.inbox).some(row => active.requestIds.has(requestIdOf(row))))
          throw new Error('WORK_QUEUE_NOT_CLEARED');
        // An in-flight prompt can leave the inbox and enter a new turn after
        // the first cancellation, so cancel once more after admissions settle.
        await cancel();
        active.cancelDone = true;
        settleKnown();
      })().catch(error => { active.cancelRpc = undefined; throw error; });
      await active.cancelRpc;
    };
    active.cancelNative = cancelNative;
    const ownedTurn = () => active.currentTurn !== undefined && [...active.enteredTurns.values()].includes(active.currentTurn);
    let unknownToolOutcome = false;
    const handle = (event: DshEvent) => {
      const report = (value: ProviderEvent) => emit({ ...value, providerSeq: event.seq });
      const data = event.data ?? {};
      if (event.type === 'turn/start') {
        if (typeof data.turn === 'number') active.currentTurn = data.turn;
        unknownToolOutcome = false;
        return;
      }
      if (event.type === 'user/message') {
        const source = record(data.source);
        if (source?.kind === 'user-question-reply' && typeof source.callId === 'string' && questionCallIds.delete(source.callId))
          report({ type: 'request-resolved', requestId: source.callId });
        if (typeof source?.rpcId === 'string' && active.requestIds.has(source.rpcId) && active.currentTurn !== undefined)
          active.enteredTurns.set(source.rpcId, active.currentTurn);
        return;
      }
      if (event.type === 'turn/end') {
        const reason = record(data.reason);
        if (typeof data.turn === 'number') {
          const outcome = reason?.kind === 'completed' ? 'completed' : reason?.kind === 'aborted' ? 'cancelled'
            : reason?.kind === 'interrupted' ? 'interrupted' : 'failed';
          const error = unknownToolOutcome ? 'WORK_TOOL_OUTCOME_UNKNOWN' : outcome === 'failed' ? String(record(reason?.error)?.code ?? reason?.kind ?? 'WORK_TURN_FAILED') : undefined;
          active.endedTurns.set(data.turn, { outcome, error });
          if (active.currentTurn === data.turn) active.currentTurn = undefined;
          flushActivity(); settleKnown();
        }
        return;
      }
      if (!ownedTurn()) return;
      if (event.type === 'assistant/message') {
        const summary = textBlocks(data.message);
        if (summary) latestSummary = summary;
      } else if (event.type === 'tool/call') {
        flushActivity();
        const name = typeof data.name === 'string' ? data.name : 'tool';
        report({ type: 'activity', text: `dsh: ${name}`, data: { eventType: event.type, callId: data.callId } });
        if (/ask_user_question/i.test(name) && typeof data.callId === 'string') {
          questionCallIds.add(data.callId);
          let argumentsValue: unknown;
          try { argumentsValue = JSON.parse(String(data.arguments ?? '{}')); } catch { argumentsValue = {}; }
          report({ type: 'question', requestId: data.callId, text: 'dsh 需要你的回答', data: argumentsValue });
        }
      } else if (event.type === 'approval/asked') {
        flushActivity();
        report({ type: 'permission', requestId: String(data.id ?? ''), text: String(data.reason ?? data.toolName ?? 'dsh 需要授权'), data });
      } else if (event.type === 'approval/decided') {
        if (typeof data.id === 'string') report({ type: 'request-resolved', requestId: data.id });
      } else if (event.type === 'tool/result') {
        flushActivity();
        const message = record(data.message);
        const toolError = record(data.error);
        if (toolError?.code === 'TOOL_OUTCOME_UNKNOWN') unknownToolOutcome = true;
        if (typeof message?.toolCallId === 'string' && questionCallIds.has(message.toolCallId) && toolError?.code !== 'TOOL_OUTCOME_UNKNOWN') {
          const content = Array.isArray(message.content) ? message.content : [];
          const pending = content.some(block => {
            const row = record(block);
            if (row?.type !== 'text' || typeof row.text !== 'string') return false;
            try { return record(JSON.parse(row.text))?.pending === true; } catch { return false; }
          });
          if (!pending) { questionCallIds.delete(message.toolCallId); report({ type: 'request-resolved', requestId: message.toolCallId }); }
        }
        if (toolError?.code === 'AUTO_REVIEW_DENIED') report({ type: 'activity', text: `Auto review 拒绝了 ${String(message?.toolCallId ?? 'tool')}`, data: { code: 'AUTO_REVIEW_DENIED' } });
      }
    };
    try {
      const ready = await this.host.ensureHost();
      if (ready.state !== 'ready') throw new Error(ready.code ?? 'WORK_HOST_UNAVAILABLE');
      if (active.cancelRequested && !binding) return sessionResult('cancelled');
      if (request.providerSessionId) active.sessionId = request.providerSessionId;
      else {
        const created = await this.host.sessionCall<{ sessionId: string }>('session/create', { cwd: request.projectPath });
        if (!created.sessionId) throw new Error('WORK_CREATE_FAILED');
        active.sessionId = created.sessionId;
      }
      emit({ type: 'session', providerSessionId: active.sessionId });
      let snapshotReady!: () => void;
      const snapshot = new Promise<void>(resolve => { snapshotReady = resolve; });
      void followDshSession(this.host, active.sessionId, request.projectPath, binding?.baseline, feed.signal, {
        ready: (opening, reattached) => {
          active.connected = true; active.baseline ??= opening.cursor;
          if (binding) active.acceptingInput = true;
          snapshotReady();
          settleKnown();
          if (!reattached || !active.requestIds.size || active.submissions.size || active.currentTurn !== undefined || settled) return;
          const queued = inboxRows(opening.projections?.values?.inbox);
          if ([...active.requestIds].some(id => !settledRequest(id) && !queued.some(row => requestIdOf(row) === id)))
            settle(sessionResult('unknown', 'WORK_NATIVE_REQUEST_NOT_CONFIRMED', true));
        },
        event: handle,
        assistant: frame => {
          const chunk = record(frame.chunk);
          if (ownedTurn() && frame.type === 'chunk' && chunk?.type === 'text-delta' && typeof chunk.text === 'string') queueActivity(chunk.text);
        },
        disconnected: () => { active.connected = false; }
      }).catch(error => settle(sessionResult(active.requestIds.size ? 'unknown' : 'failed', errorMessage(error), !!active.requestIds.size)));
      await Promise.race([snapshot, end]);
      if (settled || binding) return await within(end, 30 * 60_000, 'WORK_SETTLEMENT_TIMEOUT');
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
      if (!active.connected) throw new Error('WORK_SESSION_NOT_READY');
      await this.submitPrompt(active, request.prompt + artifactInstructions + authoringInstructions);
      active.acceptingInput = true;
      if (active.cancelRequested) await cancelNative();
      return await within(end, 30 * 60_000, 'WORK_SETTLEMENT_TIMEOUT');
    } catch (error) {
      if (settled) return await end;
      if (active.requestIds.size) return sessionResult('unknown', errorMessage(error), true);
      return sessionResult(active.cancelRequested ? 'cancelled' : 'failed', errorMessage(error));
    } finally {
      feed.abort();
      if (active.cancelTimer) clearTimeout(active.cancelTimer);
      this.active.delete(request.attemptId);
      flushActivity();
    }
  }

  async cancel(attemptId: string): Promise<void> {
    const active = this.active.get(attemptId);
    if (!active) throw new Error('WORK_ATTEMPT_NOT_ACTIVE');
    if (active.requestIds.size && !active.connected) throw new Error('WORK_SESSION_RECONNECTING');
    active.cancelRequested = true;
    await active.cancelNative?.();
  }

  async append(attemptId: string, prompt: string): Promise<void> {
    const active = this.active.get(attemptId);
    if (!active?.sessionId || !active.connected || !active.acceptingInput || active.cancelRequested) throw new Error('WORK_SESSION_NOT_READY');
    if (!prompt.trim()) throw new Error('WORK_INPUT_EMPTY');
    await this.submitPrompt(active, prompt);
    if (active.cancelRequested) await active.cancelNative?.();
  }

  private async submitPrompt(active: Active, prompt: string): Promise<void> {
    const requestId = randomUUID();
    active.requestIds.add(requestId);
    try { active.saveBinding(); }
    catch (error) { active.requestIds.delete(requestId); throw error; }
    try {
      const submission = this.host.sessionCall<{ accepted: true }>('session/prompt', {
        requestId, sessionId: active.sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }]
      });
      active.submissions.add(submission);
      const receipt = await submission.finally(() => active.submissions.delete(submission));
      if (receipt.accepted !== true) throw new Error('WORK_PROMPT_REJECTED');
    } catch (error) {
      if (promptRejected.has(errorMessage(error)) && !active.enteredTurns.has(requestId)) {
        active.requestIds.delete(requestId); active.saveBinding(); active.settleKnown();
      }
      throw error;
    }
  }

  async reply(attemptId: string, requestId: string, response: unknown): Promise<void> {
    const active = this.active.get(attemptId);
    if (!active?.sessionId || !active.connected) throw new Error('WORK_SESSION_NOT_READY');
    const answer = record(response);
    if (!Array.isArray(answer?.answers)) throw new Error('WORK_QUESTION_ANSWER_INVALID');
    const accepted = await this.host.call<boolean>('userQuestions/answer', {
      agentId: active.sessionId, callId: requestId, answer
    });
    if (!accepted) throw new Error('WORK_QUESTION_NOT_PENDING');
  }
}
