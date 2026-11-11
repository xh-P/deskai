import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { WorkHost } from '../../../packages/work-core/src/host.ts';
import { Workspaces } from '../../../packages/work-core/src/workspace.ts';
import type { ProviderPort } from '../../../packages/work-core/src/types.ts';
import { pendingRequests } from '../../../packages/work-core/src/requests.ts';
import { AppHost, ArtifactRegistry } from '../../../packages/app-core/src/index.ts';
import { ArtifactExports } from '../../../packages/app-core/src/exports.ts';
import type { WorkRuntime } from '../../../packages/dsh-adapter/src/work-runtime.ts';
import type { CoordinationPlan } from '../../../packages/voice-core/src/coordination.ts';
import type { HostCommand, HostSnapshot } from './protocol.ts';

/** Shared Work and application state, independent of the client lifecycle. */
export class LocalHost {
  readonly work: WorkHost;
  readonly artifacts: ArtifactRegistry;
  readonly apps: AppHost;
  private readonly exports: ArtifactExports;
  private readonly runtime?: WorkRuntime;
  selectedProjectId = '';
  selectedTaskId = '';
  selectedAppId = '';
  private listeners = new Set<() => void>();
  private constructor(directory: string, provider: ProviderPort, runtime?: WorkRuntime) {
    this.runtime = runtime;
    this.artifacts = new ArtifactRegistry({ storageFile: path.join(directory, 'artifacts.json'),
      authorize: (taskId, workDir, relativePath, attemptId) => this.work.authorizeArtifact(taskId, workDir, relativePath, attemptId) });
    this.work = new WorkHost(path.join(directory, 'work-ledger.json'), provider, {
      workspaces: new Workspaces(directory), registerArtifact: (input, sha256) => this.artifacts.registerArtifact(input, sha256)
    });
    this.exports = new ArtifactExports(path.join(directory, 'exports'), this.artifacts);
    this.apps = new AppHost(this.artifacts);
  }
  static async open(directory: string, provider: ProviderPort, workspace: string, runtime?: WorkRuntime) {
    const host = new LocalHost(directory, provider, runtime);
    await host.artifacts.load(); await host.exports.load();
    if (!host.work.snapshot().projects.length) host.work.createProject({ name: path.basename(workspace), path: workspace });
    host.selectedProjectId = host.work.snapshot().projects[0].id;
    host.work.subscribe(() => host.changed());
    host.apps.subscribe(() => {
      if (!host.apps.listSessions().some(app => app.id === host.selectedAppId && app.status === 'connected'))
        host.selectedAppId = host.apps.listSessions().filter(app => app.status === 'connected').at(-1)?.id ?? '';
      host.changed();
    });
    await host.apps.start();
    host.work.recover();
    return host;
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  changed() { for (const listener of this.listeners) listener(); }
  snapshot(): HostSnapshot { return { work: this.work.snapshot(), artifacts: this.artifacts.listArtifacts(), apps: this.apps.listSessions(),
    exports: this.exports.list(), runtime: this.runtime?.getStatus() ?? { state: 'stopped' },
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
  async command(input: Exclude<HostCommand, { type: 'shutdown' }>): Promise<unknown> {
    switch (input.type) {
      case 'select': {
        if (input.appSessionId) this.selectApp(input.appSessionId);
        else if (input.taskId) this.selectTask(input.taskId);
        else if (input.projectId) this.selectProject(input.projectId);
        return;
      }
      case 'plan': return this.execute(input.plan);
      case 'diff': return this.work.diff(input.attemptId);
      case 'artifact-preview': {
        const { artifact, bytes } = await this.artifacts.readVerified(input.artifactId);
        return { artifact, base64: bytes.toString('base64') };
      }
      case 'artifact-launch': return this.apps.prepareLaunch(input.artifactId);
      case 'artifact-export': {
        const receipt = await this.exports.export(input.artifactId, input.destination);
        this.changed(); return receipt;
      }
      case 'app-action': return this.apps.invokeAction(input.sessionId, input.action, input.payload);
      case 'app-close': return this.apps.closeSession(input.sessionId);
      case 'native-window': {
        if (!this.runtime) throw new Error('WORK_HOST_UNAVAILABLE');
        return this.runtime.windowConnection();
      }
      case 'work': break;
      default: throw new Error('UNKNOWN_HOST_COMMAND');
    }
    const command = input.command;
    switch (command.type) {
      case 'project-create': {
        if (typeof command.path !== 'string' || !command.path.trim() || command.path.length > 4096) throw new Error('WORK_INVALID_INPUT');
        await mkdir(path.resolve(command.path.trim()), { recursive: true });
        const project = this.work.createProject(command); this.selectProject(project.id); return project;
      }
      case 'draft-save': return this.work.saveDraft(command);
      case 'submit': { const task = this.work.submit(command); this.selectTask(task.id); return task; }
      case 'append': return this.work.append(command.taskId, command.prompt);
      case 'continue': return this.work.continue(command.taskId, command.prompt);
      case 'retry': return this.work.retry(command.taskId);
      case 'cancel': return this.work.cancel(command.taskId);
      case 'recover': return this.work.reattach(command.taskId);
      case 'reply': return this.work.reply(command.taskId, command.requestId, command.response);
      default: throw new Error('UNKNOWN_WORK_COMMAND');
    }
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
  async close() { await this.work.close(); await this.apps.close(); }
}
