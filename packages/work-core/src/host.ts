import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProviderEvent, ProviderPort, ProviderRequest, ProviderResult, WorkAttempt, WorkEvent, WorkProject, WorkSnapshot, WorkTask } from './types.ts';
import { pendingRequests } from './requests.ts';
import { relativeInside, workspacesOverlap, type Workspaces } from './workspace.ts';

const now = () => new Date().toISOString();
const id = () => randomUUID();
const active = (status: string) => status === 'queued' || status === 'running' || status === 'waiting';
const clean = (value: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('WORK_INVALID_INPUT');
  return value.trim();
};

type ArtifactInput = { taskId: string; attemptId: string; workDir: string; relativePath: string };
type WorkHostOptions = { workspaces?: Workspaces; registerArtifact?: (input: ArtifactInput, expectedSha256: string) => Promise<unknown> };

/** Host-owned ledger. Only this class mutates work state; the provider owns execution. */
export class WorkHost {
  private state: WorkSnapshot;
  private listeners = new Set<() => void>();
  private running = new Set<string>();
  private executing = new Set<string>();
  private cancelled = new Set<string>();
  private localOperations = new Set<Promise<unknown>>();
  private closing = false;
  private replying = new Set<string>();
  private readonly file: string;
  private readonly provider: ProviderPort;
  private readonly options: WorkHostOptions;
  constructor(file: string, provider: ProviderPort, options: WorkHostOptions = {}) {
    this.file = file; this.provider = provider;
    this.options = options;
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as WorkSnapshot :
      { version: 1, projects: [], drafts: [], tasks: [], attempts: [], events: [] };
    if (this.state.version !== 1 || !Array.isArray(this.state.projects) || !Array.isArray(this.state.tasks) ||
        !Array.isArray(this.state.drafts) || !Array.isArray(this.state.attempts) || !Array.isArray(this.state.events)) throw new Error('WORK_LEDGER_INVALID');
    if (!options.workspaces) this.recover();
  }
  recover(): void {
    for (const task of this.state.tasks.filter(task => active(task.status))) {
      const attempt = this.last(task);
      if (this.running.has(attempt.id)) continue;
      if (attempt.result || attempt.binding?.requestIds.length && attempt.providerSessionId && this.provider.recover) this.run(task, attempt, true);
      else this.finish(task, attempt, attempt.providerSessionId && !task.workspace && this.options.workspaces
        ? { outcome: 'unknown', error: 'WORK_DISPATCH_BINDING_UNAVAILABLE', unsettled: true }
        : { outcome: 'interrupted', error: 'WORK_HOST_RESTARTED_BEFORE_DISPATCH' });
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.localOperations);
  }
  snapshot(): WorkSnapshot { return structuredClone(this.state); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${id()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), { encoding: 'utf8', flush: true });
    renameSync(temp, this.file);
    for (const listener of this.listeners) { try { listener(); } catch { /* Client notification cannot affect the ledger. */ } }
  }
  private event(attempt: WorkAttempt, type: string, data: unknown, providerSeq?: number): WorkEvent {
    const event = { id: id(), taskId: attempt.taskId, attemptId: attempt.id, time: now(), type, data, providerSeq };
    this.state.events.push(event); return event;
  }
  private project(projectId: string): WorkProject { const p = this.state.projects.find(p => p.id === projectId); if (!p) throw new Error('WORK_PROJECT_NOT_FOUND'); return p; }
  private task(taskId: string): WorkTask { const t = this.state.tasks.find(t => t.id === taskId); if (!t) throw new Error('WORK_TASK_NOT_FOUND'); return t; }
  private last(task: WorkTask): WorkAttempt { const a = this.state.attempts.find(a => a.id === task.attemptIds.at(-1)); if (!a) throw new Error('WORK_ATTEMPT_NOT_FOUND'); return a; }
  createProject(input: { name: string; path: string }): WorkProject {
    const project = { id: id(), name: clean(input.name, 200), path: path.resolve(clean(input.path, 4096)), createdAt: now() };
    this.state.projects.push(project); this.save(); return structuredClone(project);
  }
  saveDraft(input: { projectId: string; text: string }): void {
    this.project(input.projectId);
    if (typeof input.text !== 'string' || input.text.length > 100000) throw new Error('WORK_INVALID_INPUT');
    let draft = this.state.drafts.find(d => d.projectId === input.projectId);
    if (!draft) { draft = { id: id(), projectId: input.projectId, text: '', updatedAt: now() }; this.state.drafts.push(draft); }
    draft.text = input.text; draft.updatedAt = now(); this.save();
  }
  submit(input: { projectId: string; prompt: string; title?: string; authoring?: boolean }): WorkTask {
    this.project(input.projectId); const prompt = clean(input.prompt, 100000); const time = now();
    const task: WorkTask = { id: id(), projectId: input.projectId, title: input.title ? clean(input.title, 200) : prompt.slice(0, 80), prompt, status: 'queued', attemptIds: [], createdAt: time, updatedAt: time };
    task.authoring = input.authoring === true;
    this.state.tasks.push(task); this.launch(task, prompt); return structuredClone(task);
  }
  private launch(task: WorkTask, prompt: string, providerSessionId?: string): WorkAttempt {
    if (active(task.status) && task.attemptIds.length) throw new Error('WORK_TASK_BUSY');
    if (task.attemptIds.length && this.last(task).result?.unsettled) throw new Error('WORK_PREVIOUS_EXECUTION_UNCONFIRMED');
    if (providerSessionId && this.options.workspaces && !task.workspace) throw new Error('WORK_SESSION_WORKSPACE_UNBOUND');
    const time = now(); const attempt: WorkAttempt = { id: id(), taskId: task.id, status: 'queued', prompt, providerSessionId, createdAt: time, updatedAt: time };
    task.attemptIds.push(attempt.id); task.status = 'queued'; task.updatedAt = time; this.state.attempts.push(attempt);
    this.event(attempt, 'submitted', { prompt }); this.save();
    this.run(task, attempt, false);
    return attempt;
  }

  private run(task: WorkTask, attempt: WorkAttempt, recovering: boolean) {
    this.running.add(attempt.id);
    void this.execute(task, attempt, recovering).catch(error => {
      if (this.closing) return;
      this.finish(task, attempt, {
        outcome: attempt.binding || !this.options.workspaces ? 'unknown' : 'failed',
        error: error instanceof Error ? error.message : String(error), unsettled: !!attempt.binding
      });
    }).finally(() => {
      this.running.delete(attempt.id); this.cancelled.delete(attempt.id); this.executing.delete(attempt.id);
    }).catch(error => console.error('Work ledger write failed', error));
  }

  private async local<T>(operation: Promise<T>): Promise<T> {
    this.localOperations.add(operation);
    try { return await operation; } finally { this.localOperations.delete(operation); }
  }

  private async prepare(task: WorkTask, attempt: WorkAttempt, projectPath: string) {
    const workspaces = this.options.workspaces!;
    const workspace = await workspaces.prepare(task.id, projectPath, task.workspace);
    for (const other of this.state.tasks) {
      if (other.id === task.id || !other.workspace || workspace.kind === 'git' && other.workspace.kind === 'git') continue;
      if ((active(other.status) || this.last(other).result?.unsettled) && workspacesOverlap(workspace.path, other.workspace.path))
        throw new Error('WORK_WORKSPACE_BUSY');
    }
    task.workspace = workspace;
    this.save();
    if (!this.closing && !this.cancelled.has(attempt.id)) {
      try { attempt.baseline = await workspaces.baseline(workspace, attempt.id); }
      catch (error) { attempt.deliveryError = error instanceof Error ? error.message : String(error); }
      this.save();
    }
  }

  private async execute(task: WorkTask, attempt: WorkAttempt, recovering: boolean) {
    const projectPath = this.project(task.projectId).path;
    let result = recovering && !attempt.result?.unsettled ? attempt.result : undefined;
    if (!result) {
      if (!recovering && this.options.workspaces) await this.local(this.prepare(task, attempt, projectPath));
      else await Promise.resolve();
      if (this.closing) return;
      if (!recovering && this.cancelled.has(attempt.id)) { this.finish(task, attempt, { outcome: 'cancelled' }); return; }
      task.status = attempt.status = pendingRequests(this.state).some(event => event.attemptId === attempt.id) ? 'waiting' : 'running';
      this.save();
      const request: ProviderRequest = { taskId: task.id, attemptId: attempt.id, projectPath: task.workspace?.path ?? projectPath,
        prompt: attempt.prompt, providerSessionId: attempt.providerSessionId, authoring: task.authoring };
      const notify = (event: ProviderEvent) => this.onProviderEvent(task, attempt, event);
      this.executing.add(attempt.id);
      try {
        result = recovering ? await this.provider.recover!({ ...request, providerSessionId: attempt.providerSessionId!, binding: attempt.binding! }, notify)
          : await this.provider.start(request, notify);
      } finally { this.executing.delete(attempt.id); }
      if (this.closing) return;
      attempt.result = result;
      if (result.providerSessionId) attempt.providerSessionId = result.providerSessionId;
      this.save();
    }
    if (!result.unsettled && task.workspace && attempt.baseline) {
      try { await this.local(this.deliver(task, attempt)); }
      catch (error) { attempt.deliveryError = error instanceof Error ? error.message : String(error); }
    }
    if (!this.closing) this.finish(task, attempt, result);
  }

  private async deliver(task: WorkTask, attempt: WorkAttempt) {
    const workDir = task.workspace!.path;
    const events = this.state.events.filter(event => event.attemptId === attempt.id);
    if (!attempt.artifactFiles) {
      const claims = events.filter(event => event.type === 'artifact').map(event => (event.data as { path: string }).path);
      const { changes, files } = await this.options.workspaces!.collect(task.workspace!, attempt.id, attempt.baseline!, claims);
      attempt.changes = changes; attempt.artifactFiles = files;
      this.save();
    }
    if (!this.options.registerArtifact) return;
    const registered = new Set(events.filter(event => event.type === 'verified_artifact').map(event => (event.data as { relativePath: string }).relativePath));
    for (const { relativePath, sha256 } of attempt.artifactFiles) {
      if (registered.has(relativePath)) continue;
      const input = { taskId: task.id, attemptId: attempt.id, workDir, relativePath };
      try { this.event(attempt, 'verified_artifact', await this.options.registerArtifact(input, sha256)); }
      catch (error) { this.event(attempt, 'artifact_rejected', { relativePath, reason: String(error) }); }
      this.save();
    }
  }

  private finish(task: WorkTask, attempt: WorkAttempt, result: ProviderResult) {
    if (result.providerSessionId) attempt.providerSessionId = result.providerSessionId;
    attempt.result = result; attempt.status = task.status = result.outcome; attempt.summary = result.summary; attempt.error = result.error;
    attempt.updatedAt = task.updatedAt = now(); this.event(attempt, 'settled', result);
    this.save();
  }

  private onProviderEvent(task: WorkTask, attempt: WorkAttempt, event: ProviderEvent): void {
    if (this.closing) {
      if (event.type === 'binding') throw new Error('WORK_HOST_STOPPING');
      return;
    }
    if (event.type === 'binding') { attempt.binding = structuredClone(event.binding); this.save(); return; }
    if (event.providerSeq !== undefined && this.state.events.some(item => item.attemptId === attempt.id && item.providerSeq === event.providerSeq && item.type === event.type)) return;
    if (event.type === 'session' && attempt.providerSessionId === event.providerSessionId) return;
    if (event.type === 'artifact' && this.state.events.some(item => item.attemptId === attempt.id && item.type === 'artifact' && (item.data as { path: string }).path === event.path)) return;
    if (event.type === 'session') attempt.providerSessionId = event.providerSessionId;
    if (event.type === 'permission' || event.type === 'question') task.status = attempt.status = 'waiting';
    attempt.updatedAt = task.updatedAt = now(); this.event(attempt, event.type, event, event.providerSeq);
    if (event.type === 'request-resolved') task.status = attempt.status = pendingRequests(this.state).some(item => item.attemptId === attempt.id) ? 'waiting' : 'running';
    this.save();
  }
  async append(taskId: string, prompt: string): Promise<void> {
    const task = this.task(taskId); const attempt = this.last(task); const text = clean(prompt, 100000);
    if (!this.executing.has(attempt.id)) throw new Error('WORK_TASK_NOT_RUNNING');
    await this.provider.append(attempt.id, text);
    this.event(attempt, 'input-added', { prompt: text }); attempt.updatedAt = task.updatedAt = now(); this.save();
  }
  continue(taskId: string, prompt: string): WorkAttempt {
    const task = this.task(taskId); const previous = this.last(task);
    if (!previous.providerSessionId) throw new Error('WORK_SESSION_UNAVAILABLE');
    return structuredClone(this.launch(task, clean(prompt, 100000), previous.providerSessionId));
  }
  retry(taskId: string): WorkAttempt { const task = this.task(taskId); const last = this.last(task); return structuredClone(this.launch(task, last.prompt)); }
  reattach(taskId: string): WorkAttempt {
    const task = this.task(taskId); const attempt = this.last(task);
    if (active(task.status) || !attempt.result?.unsettled || !attempt.binding || !attempt.providerSessionId || !this.provider.recover)
      throw new Error('WORK_RECOVERY_UNAVAILABLE');
    task.status = attempt.status = 'queued'; attempt.updatedAt = task.updatedAt = now();
    this.event(attempt, 'recovery_requested', {}); this.save(); this.run(task, attempt, true);
    return structuredClone(attempt);
  }
  async cancel(taskId: string): Promise<void> {
    const task = this.task(taskId); const attempt = this.last(task);
    if (!active(attempt.status) || !this.running.has(attempt.id) || attempt.result && !attempt.result.unsettled) throw new Error('WORK_TASK_NOT_RUNNING');
    this.event(attempt, 'cancel_requested', {}); this.save();
    if (this.executing.has(attempt.id)) await this.provider.cancel(attempt.id);
    else if (!attempt.binding) this.cancelled.add(attempt.id);
  }
  async reply(taskId: string, requestId: string, response: unknown): Promise<void> {
    const task = this.task(taskId); const attempt = this.last(task);
    if (!this.executing.has(attempt.id)) throw new Error('WORK_REQUEST_NOT_PENDING');
    const key = `${attempt.id}:${requestId}`;
    const pending = pendingRequests(this.state).find(e => e.attemptId === attempt.id && (e.data as { requestId?: string })?.requestId === requestId);
    if (!pending || this.replying.has(key)) throw new Error('WORK_REQUEST_NOT_PENDING');
    this.replying.add(key);
    try {
      await this.provider.reply(attempt.id, requestId, response);
      this.event(attempt, 'reply', { requestId, response });
      const hasPending = pendingRequests(this.state).some(e => e.attemptId === attempt.id);
      if (this.executing.has(attempt.id)) { task.status = attempt.status = hasPending ? 'waiting' : 'running'; attempt.updatedAt = task.updatedAt = now(); }
      this.save();
    } finally { this.replying.delete(key); }
  }
  async diff(attemptId: string): Promise<string> {
    const attempt = this.state.attempts.find(item => item.id === attemptId);
    if (!this.options.workspaces || !attempt?.baseline || !attempt.changes) throw new Error('WORK_DIFF_UNAVAILABLE');
    return this.options.workspaces.diff(attempt.baseline, attempt.changes);
  }
  authorizeArtifact(taskId: string, workDir: string, relativePath: string, attemptId?: string): boolean {
    const task = this.state.tasks.find(t => t.id === taskId);
    if (!task || path.isAbsolute(relativePath)) return false;
    const root = task.workspace?.path ?? this.project(task.projectId).path;
    if (path.relative(root, workDir)) return false;
    const requested = path.resolve(workDir, relativePath);
    const relative = relativeInside(root, requested);
    if (!relative) return false;
    if (this.options.workspaces) return this.state.attempts.some(attempt => attempt.id === attemptId && attempt.taskId === taskId && attempt.artifactFiles?.some(file => file.relativePath === relative));
    return this.state.events.some(e => e.taskId === taskId && e.type === 'artifact' &&
      typeof (e.data as { path?: unknown })?.path === 'string' &&
      path.resolve(workDir, (e.data as { path: string }).path) === requested);
  }
}
