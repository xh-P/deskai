import path from 'node:path';
import { WorkHost } from '../../../packages/work-core/src/host.ts';
import type { ProviderPort, WorkEvent } from '../../../packages/work-core/src/types.ts';
import { pendingRequests } from '../../../packages/work-core/src/requests.ts';
import { AppHost, ArtifactRegistry } from '../../../packages/app-core/src/index.ts';
import type { CoordinationPlan } from '../../../packages/voice-core/src/coordination.ts';

/** One composition boundary for durable Work and ephemeral application sessions. */
export class DesktopHost {
  readonly work: WorkHost;
  readonly artifacts: ArtifactRegistry;
  readonly apps: AppHost;
  selectedProjectId = '';
  selectedTaskId = '';
  selectedAppId = '';
  private seen = new Set<string>();
  private registrations: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private notice: (event: WorkEvent) => void;
  private constructor(directory: string, provider: ProviderPort, notice: (event: WorkEvent) => void) {
    this.notice = notice;
    this.work = new WorkHost(path.join(directory, 'work-ledger.json'), provider);
    this.artifacts = new ArtifactRegistry({ storageFile: path.join(directory, 'artifacts.json'),
      authorize: (taskId, workDir, relativePath) => this.work.authorizeArtifact(taskId, workDir, relativePath) });
    this.apps = new AppHost(this.artifacts);
  }
  static async open(directory: string, provider: ProviderPort, workspace: string, notice: (event: WorkEvent) => void = () => {}) {
    const host = new DesktopHost(directory, provider, notice);
    await host.artifacts.load(); await host.apps.start();
    if (!host.work.snapshot().projects.length) host.work.createProject({ name: path.basename(workspace), path: workspace });
    host.selectedProjectId = host.work.snapshot().projects[0].id;
    for (const event of host.work.snapshot().events) host.seen.add(event.id);
    host.work.subscribe(state => {
      for (const event of state.events) {
        if (host.seen.has(event.id)) continue;
        host.seen.add(event.id);
        if (event.type === 'artifact') host.queueArtifact(event);
        if (['settled', 'permission', 'question'].includes(event.type)) host.notice(event);
      }
      host.changed();
    });
    host.apps.subscribe(() => {
      if (!host.apps.listSessions().some(app => app.id === host.selectedAppId && app.status === 'connected'))
        host.selectedAppId = host.apps.listSessions().filter(app => app.status === 'connected').at(-1)?.id ?? '';
      host.changed();
    });
    const previous = host.work.snapshot();
    const registered = new Set(previous.events.filter(event => event.type === 'verified_artifact')
      .map(event => (event.data as { sourceEventId?: string }).sourceEventId));
    for (const event of previous.events) if (event.type === 'artifact' && !registered.has(event.id)) host.queueArtifact(event);
    return host;
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed() { for (const listener of this.listeners) listener(); }
  snapshot() { return { work: this.work.snapshot(), artifacts: this.artifacts.listArtifacts(), apps: this.apps.listSessions(),
    selectedProjectId: this.selectedProjectId, selectedTaskId: this.selectedTaskId, selectedAppId: this.selectedAppId }; }
  selectApp(sessionId: string) {
    if (!this.apps.listSessions().some(app => app.id === sessionId && app.status === 'connected')) throw new Error('APP_SESSION_UNAVAILABLE');
    this.selectedAppId = sessionId; this.changed();
  }
  selectProject(projectId: string) {
    if (!this.work.snapshot().projects.some(project => project.id === projectId)) throw new Error('WORK_PROJECT_NOT_FOUND');
    this.selectedProjectId = projectId; this.selectedTaskId = ''; this.changed();
  }
  selectTask(taskId: string) {
    const task = this.work.snapshot().tasks.find(task => task.id === taskId);
    if (!task) throw new Error('WORK_TASK_NOT_FOUND');
    this.selectedTaskId = task.id; this.selectedProjectId = task.projectId; this.changed();
  }
  planningContext() {
    const state = this.work.snapshot();
    return { selectedProjectId: this.selectedProjectId, selectedTaskId: this.selectedTaskId, selectedAppId: this.selectedAppId,
      projects: state.projects.map(({ id, name, path }) => ({ id, name, path })),
      tasks: state.tasks.slice(-20).map(task => ({ id: task.id, title: task.title, status: task.status, projectId: task.projectId,
        latest: state.attempts.find(a => a.id === task.attemptIds.at(-1))?.summary?.slice(0, 600) })),
      requests: pendingRequests(state).slice(-8),
      apps: this.apps.listSessions().filter(app => app.status === 'connected').map(({ id, manifest, state, revision }) => ({ id, manifest, state, revision })) };
  }
  private queueArtifact(event: WorkEvent) {
    this.registrations = this.registrations.then(async () => {
      const state = this.work.snapshot(); const task = state.tasks.find(task => task.id === event.taskId)!;
      const project = state.projects.find(project => project.id === task.projectId)!;
      const file = (event.data as { path: string }).path;
      const relativePath = path.isAbsolute(file) ? path.relative(project.path, file) : file;
      try {
        const artifact = await this.artifacts.registerArtifact({ taskId: task.id, workDir: project.path, relativePath });
        this.work.recordArtifact(task.id, { ...artifact, sourceEventId: event.id }, event.attemptId);
      } catch (error) {
        this.work.recordArtifact(task.id, { rejected: true, sourceEventId: event.id, reason: String(error) }, event.attemptId);
      }
      this.changed();
    });
  }
  async execute(plan: CoordinationPlan): Promise<unknown> {
    if (plan.intent === 'chat') return { kind: 'chat' };
    if (plan.intent === 'submit') {
      const task = this.work.submit({ projectId: plan.projectId ?? this.selectedProjectId, title: plan.title, prompt: plan.prompt!, authoring: plan.authoring });
      this.selectTask(task.id);
      return { kind: 'task-submitted', taskId: task.id, title: task.title, status: task.status, message: '任务已受理，尚未完成。' };
    }
    if (plan.intent === 'status') {
      const state = this.work.snapshot();
      if (plan.taskId && !state.tasks.some(task => task.id === plan.taskId)) throw new Error('WORK_TASK_NOT_FOUND');
      return { kind: 'task-status', requests: pendingRequests(state).filter(event => !plan.taskId || event.taskId === plan.taskId),
        permissionHandling: '权限请求请打开对应任务的原生会话处理；自动审查已默认开启。',
        tasks: state.tasks.filter(task => !plan.taskId || task.id === plan.taskId).slice(-10).map(task => ({
        id: task.id, title: task.title, status: task.status,
        summary: state.attempts.find(a => a.id === task.attemptIds.at(-1))?.summary?.slice(0, 1200),
      })) };
    }
    if (plan.intent === 'app') {
      const receipt = await this.apps.invokeAction(plan.sessionId!, plan.action!, plan.payload ?? {});
      return { kind: 'application-receipt', sessionId: plan.sessionId, action: plan.action, receipt };
    }
    this.selectTask(plan.taskId!);
    if (plan.intent === 'cancel') await this.work.cancel(plan.taskId!);
    if (plan.intent === 'append') {
      const task = this.work.snapshot().tasks.find(task => task.id === plan.taskId)!;
      if (['queued', 'running', 'waiting'].includes(task.status)) await this.work.append(task.id, plan.prompt!);
      else this.work.continue(task.id, plan.prompt!);
    }
    if (plan.intent === 'resume') this.work.continue(plan.taskId!, plan.prompt || '继续完成原任务。');
    if (plan.intent === 'retry') this.work.retry(plan.taskId!);
    if (plan.intent === 'reply') await this.work.reply(plan.taskId!, plan.requestId!, plan.response);
    return { kind: 'task-control-receipt', operation: plan.intent, task: this.work.snapshot().tasks.find(task => task.id === plan.taskId) };
  }
  async close() { await this.registrations; await this.apps.close(); }
}

export type DesktopHostSnapshot = ReturnType<DesktopHost['snapshot']>;
