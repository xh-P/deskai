import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProviderEvent, ProviderPort, WorkAttempt, WorkEvent, WorkProject, WorkSnapshot, WorkTask } from './types.ts';
import { pendingRequests } from './requests.ts';

const now = () => new Date().toISOString();
const id = () => randomUUID();
const active = (status: string) => status === 'queued' || status === 'running' || status === 'waiting';
const clean = (value: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('WORK_INVALID_INPUT');
  return value.trim();
};

/** Host-owned ledger. Only this class mutates work state; the provider owns execution. */
export class WorkHost {
  private state: WorkSnapshot;
  private listeners = new Set<(snapshot: WorkSnapshot) => void>();
  private running = new Set<string>();
  private replying = new Set<string>();
  private readonly file: string;
  private readonly provider: ProviderPort;
  constructor(file: string, provider: ProviderPort) {
    this.file = file; this.provider = provider;
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as WorkSnapshot :
      { version: 1, projects: [], drafts: [], tasks: [], attempts: [], events: [] };
    if (this.state.version !== 1 || !Array.isArray(this.state.projects) || !Array.isArray(this.state.tasks) ||
        !Array.isArray(this.state.drafts) || !Array.isArray(this.state.attempts) || !Array.isArray(this.state.events)) throw new Error('WORK_LEDGER_INVALID');
    let changed = false;
    for (const attempt of this.state.attempts) {
      if (!active(attempt.status)) continue;
      attempt.status = 'interrupted'; attempt.updatedAt = now();
      const task = this.state.tasks.find(item => item.id === attempt.taskId);
      if (task && task.attemptIds.at(-1) === attempt.id) { task.status = 'interrupted'; task.updatedAt = attempt.updatedAt; }
      this.event(attempt, 'interrupted', { reason: 'host_restart', message: 'Provider outcome is unknown; no automatic retry was made.' });
      changed = true;
    }
    if (changed) this.save();
  }
  snapshot(): WorkSnapshot { return structuredClone(this.state); }
  subscribe(listener: (snapshot: WorkSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${id()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), 'utf8');
    renameSync(temp, this.file);
    for (const listener of this.listeners) { try { listener(this.snapshot()); } catch { /* a UI subscriber cannot affect the ledger */ } }
  }
  private event(attempt: WorkAttempt, type: string, data: unknown): WorkEvent {
    const event = { id: id(), taskId: attempt.taskId, attemptId: attempt.id, time: now(), type, data };
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
    const time = now(); const attempt: WorkAttempt = { id: id(), taskId: task.id, status: 'queued', prompt, providerSessionId, createdAt: time, updatedAt: time };
    task.attemptIds.push(attempt.id); task.status = 'queued'; task.updatedAt = time; this.state.attempts.push(attempt);
    this.event(attempt, 'submitted', { prompt }); this.save(); this.running.add(attempt.id);
    attempt.status = task.status = 'running'; attempt.updatedAt = task.updatedAt = now(); this.save();
    void Promise.resolve().then(() => this.provider.start({ taskId: task.id, attemptId: attempt.id, projectPath: this.project(task.projectId).path, prompt, providerSessionId, authoring: task.authoring }, e => this.onProviderEvent(task, attempt, e)))
      .then(result => {
        if (result.providerSessionId) attempt.providerSessionId = result.providerSessionId;
        attempt.status = task.status = result.outcome; attempt.summary = result.summary; attempt.error = result.error;
        attempt.updatedAt = task.updatedAt = now(); this.event(attempt, 'settled', result); this.running.delete(attempt.id); this.save();
      }, error => {
        attempt.status = task.status = 'unknown'; attempt.error = error instanceof Error ? error.message : String(error);
        attempt.updatedAt = task.updatedAt = now(); this.event(attempt, 'settled', { outcome: 'unknown', error: attempt.error }); this.running.delete(attempt.id); this.save();
      });
    return attempt;
  }
  private onProviderEvent(task: WorkTask, attempt: WorkAttempt, event: ProviderEvent): void {
    if (!this.running.has(attempt.id)) return;
    if (event.type === 'session') attempt.providerSessionId = event.providerSessionId;
    if (event.type === 'permission' || event.type === 'question') task.status = attempt.status = 'waiting';
    attempt.updatedAt = task.updatedAt = now(); this.event(attempt, event.type, event);
    if (event.type === 'request-resolved') task.status = attempt.status = pendingRequests(this.state).some(item => item.attemptId === attempt.id) ? 'waiting' : 'running';
    this.save();
  }
  async append(taskId: string, prompt: string): Promise<void> {
    const task = this.task(taskId); const attempt = this.last(task); const text = clean(prompt, 100000);
    if (!this.running.has(attempt.id)) throw new Error('WORK_TASK_NOT_RUNNING');
    await this.provider.append(attempt.id, text);
    this.event(attempt, 'input-added', { prompt: text }); attempt.updatedAt = task.updatedAt = now(); this.save();
  }
  continue(taskId: string, prompt: string): WorkAttempt {
    const task = this.task(taskId); const previous = this.last(task);
    if (!previous.providerSessionId) throw new Error('WORK_SESSION_UNAVAILABLE');
    return structuredClone(this.launch(task, clean(prompt, 100000), previous.providerSessionId));
  }
  retry(taskId: string): WorkAttempt { const task = this.task(taskId); const last = this.last(task); return structuredClone(this.launch(task, last.prompt)); }
  async cancel(taskId: string): Promise<void> {
    const task = this.task(taskId); const attempt = this.last(task);
    if (!this.running.has(attempt.id)) throw new Error('WORK_TASK_NOT_RUNNING');
    this.event(attempt, 'cancel_requested', {}); this.save(); await this.provider.cancel(attempt.id);
  }
  async reply(taskId: string, requestId: string, response: unknown): Promise<void> {
    const task = this.task(taskId); const attempt = this.last(task);
    if (!this.running.has(attempt.id)) throw new Error('WORK_REQUEST_NOT_PENDING');
    const key = `${attempt.id}:${requestId}`;
    const pending = pendingRequests(this.state).find(e => e.attemptId === attempt.id && (e.data as { requestId?: string })?.requestId === requestId);
    if (!pending || this.replying.has(key)) throw new Error('WORK_REQUEST_NOT_PENDING');
    this.replying.add(key);
    try {
      await this.provider.reply(attempt.id, requestId, response);
      this.event(attempt, 'reply', { requestId, response });
      const hasPending = pendingRequests(this.state).some(e => e.attemptId === attempt.id);
      if (this.running.has(attempt.id)) { task.status = attempt.status = hasPending ? 'waiting' : 'running'; attempt.updatedAt = task.updatedAt = now(); }
      this.save();
    } finally { this.replying.delete(key); }
  }
  recordArtifact(taskId: string, data: unknown, attemptId?: string): void {
    const task = this.task(taskId);
    const attempt = attemptId ? this.state.attempts.find(item => item.id === attemptId && item.taskId === taskId) : this.last(task);
    if (!attempt) throw new Error('WORK_ATTEMPT_NOT_FOUND');
    this.event(attempt, 'verified_artifact', data); this.save();
  }
  authorizeArtifact(taskId: string, workDir: string, relativePath: string): boolean {
    const task = this.state.tasks.find(t => t.id === taskId);
    const project = task && this.state.projects.find(p => p.id === task.projectId);
    if (!project || path.resolve(project.path) !== path.resolve(workDir) || path.isAbsolute(relativePath)) return false;
    const requested = path.resolve(workDir, relativePath);
    if (path.relative(workDir, requested).startsWith('..')) return false;
    return this.state.events.some(e => e.taskId === taskId && e.type === 'artifact' &&
      typeof (e.data as { path?: unknown })?.path === 'string' &&
      path.resolve(workDir, (e.data as { path: string }).path) === requested);
  }
}
