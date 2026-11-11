import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { WorkHost } from '../../../packages/work-core/src/host.ts';
import { Workspaces } from '../../../packages/work-core/src/workspace.ts';
import type { ProviderPort } from '../../../packages/work-core/src/types.ts';
import { isWorkEffect, type WorkOperationReceipt } from '../../../packages/work-core/src/operations.ts';
import { AppHost, ArtifactRegistry } from '../../../packages/app-core/src/index.ts';
import { ArtifactExports } from '../../../packages/app-core/src/exports.ts';
import type { WorkRuntime } from '../../../packages/dsh-adapter/src/work-runtime.ts';
import type { HostCommand, HostSelection, HostSnapshot } from './protocol.ts';
import { verifyWorkDelivery } from './work-delivery.ts';
import { ConversationControl } from './conversation-control.ts';

/** Shared Work and application state, independent of the client lifecycle. */
export class LocalHost {
  readonly work: WorkHost;
  readonly artifacts: ArtifactRegistry;
  readonly apps: AppHost;
  private readonly control: ConversationControl;
  private readonly exports: ArtifactExports;
  private readonly runtime?: WorkRuntime;
  selectedProjectId = '';
  selectedTaskId = '';
  selectedAppId = '';
  private focus: HostSelection = {};
  private listeners = new Set<() => void>();
  private constructor(directory: string, provider: ProviderPort, runtime?: WorkRuntime) {
    this.runtime = runtime;
    this.artifacts = new ArtifactRegistry({ storageFile: path.join(directory, 'artifacts.json'),
      authorize: (taskId, workDir, relativePath, attemptId) => this.work.authorizeArtifact(taskId, workDir, relativePath, attemptId) });
    this.work = new WorkHost(path.join(directory, 'work-ledger.json'), provider, {
      workspaces: new Workspaces(directory), registerArtifact: (input, sha256) => this.artifacts.registerArtifact(input, sha256),
      verifyDelivery: (task, attempt, claims) => verifyWorkDelivery(this.artifacts, task, attempt, claims)
    });
    this.exports = new ArtifactExports(path.join(directory, 'exports'), this.artifacts);
    this.apps = new AppHost(this.artifacts);
    this.control = new ConversationControl(this.work, this.apps, () => ({ snapshot: this.snapshot(), focus: { ...this.focus } }), receipt => this.showWorkReceipt(receipt));
  }
  static async open(directory: string, provider: ProviderPort, workspace: string, runtime?: WorkRuntime) {
    const host = new LocalHost(directory, provider, runtime);
    await host.artifacts.load(); await host.exports.load();
    if (!host.work.snapshot().projects.length) host.work.createProject({ name: path.basename(workspace), path: workspace });
    host.selectedProjectId = host.work.snapshot().projects[0].id;
    host.work.subscribe(() => host.changed());
    host.apps.subscribe(sessions => {
      if (!sessions.some(app => app.id === host.selectedAppId && app.status === 'connected'))
        host.selectedAppId = sessions.filter(app => app.status === 'connected').at(-1)?.id ?? '';
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
    this.focus.appSessionId = this.selectedAppId = sessionId; this.changed();
  }
  selectProject(projectId: string) {
    if (!this.work.snapshot().projects.some(project => project.id === projectId)) throw new Error('WORK_PROJECT_NOT_FOUND');
    this.focus.projectId = projectId; this.focus.taskId = undefined;
    this.selectedProjectId = projectId; this.selectedTaskId = ''; this.changed();
  }
  selectTask(taskId: string) {
    const task = this.work.snapshot().tasks.find(task => task.id === taskId);
    if (!task) throw new Error('WORK_TASK_NOT_FOUND');
    this.focus.taskId = task.id; this.focus.projectId = task.projectId;
    this.selectedTaskId = task.id; this.selectedProjectId = task.projectId; this.changed();
  }
  private showWorkReceipt(receipt: WorkOperationReceipt) {
    if (this.selectedTaskId === receipt.task.id && this.selectedProjectId === receipt.task.projectId) return;
    if (this.focus.taskId !== receipt.task.id) this.focus.taskId = undefined;
    if (this.focus.projectId !== receipt.task.projectId) this.focus.projectId = undefined;
    this.selectedTaskId = receipt.task.id; this.selectedProjectId = receipt.task.projectId; this.changed();
  }
  async command(input: Exclude<HostCommand, { type: 'shutdown' }>): Promise<unknown> {
    switch (input.type) {
      case 'select': {
        if (input.appSessionId) this.selectApp(input.appSessionId);
        else if (input.taskId) this.selectTask(input.taskId);
        else if (input.projectId) this.selectProject(input.projectId);
        return;
      }
      case 'plan-context': return this.control.begin(input.turn);
      case 'plan': return this.control.execute(input.turn, input.plan);
      case 'reference-select': return this.control.choose(input.conversationId, input.selection);
      case 'reference-dismiss': return this.control.dismiss(input.conversationId, input.clarificationId);
      case 'work-receipt': {
        const receipt = this.work.receipt(input.operationId);
        if (!receipt) throw new Error('WORK_OPERATION_NOT_FOUND');
        return receipt;
      }
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
      case 'app-action': return this.apps.invokeAction(input.sessionId, input.action, input.payload, input.expected);
      case 'app-mode': return this.apps.setMode(input.sessionId, input.mode);
      case 'app-close': return this.apps.closeSession(input.sessionId);
      case 'native-window': {
        if (!this.runtime) throw new Error('WORK_HOST_UNAVAILABLE');
        return this.runtime.windowConnection();
      }
      case 'work': break;
      default: throw new Error('UNKNOWN_HOST_COMMAND');
    }
    const command = input.command;
    if (isWorkEffect(command)) {
      const replay = input.operationId !== undefined && this.work.operation(input.operationId) !== undefined;
      const receipt = await this.work.dispatch(command, { id: input.operationId });
      if (!replay) this.showWorkReceipt(receipt);
      return receipt;
    }
    switch (command.type) {
      case 'project-create': {
        if (typeof command.path !== 'string' || !command.path.trim() || command.path.length > 4096) throw new Error('WORK_INVALID_INPUT');
        await mkdir(path.resolve(command.path.trim()), { recursive: true });
        const project = this.work.createProject(command); this.selectProject(project.id); return project;
      }
      case 'draft-save': return this.work.saveDraft(command);
      case 'accept': case 'recheck': return this.work.review(command.taskId, command.attemptId, command.type);
      default: throw new Error('UNKNOWN_WORK_COMMAND');
    }
  }
  async close() { await this.work.close(); await this.apps.close(); }
}
