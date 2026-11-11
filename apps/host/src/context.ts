import type { HostSnapshot } from './protocol.ts';
import { pendingRequests } from '../../../packages/work-core/src/requests.ts';
import { modelCandidates, type ReferenceCatalog } from './reference-catalog.ts';
import type { ReferenceClarification } from '../../../packages/voice-core/src/coordination.ts';

function capabilities(snapshot: HostSnapshot) {
  const project = snapshot.work.projects.find(project => project.id === snapshot.selectedProjectId);
  return {
    work: { executor: 'dsh', delegation: '通过 Host 委派后台任务，支持提交、查询、补充、取消、重试、继续和回答任务问题。',
      startup: '收到任务后 Host 按需启动 dsh。',
      permission: '默认开启自动审查，权限请求需在原生会话中处理。',
      readiness: snapshot.runtime.state },
    selectedProject: project ? { id: project.id, name: project.name, path: project.path } : null,
    applications: snapshot.apps.filter(app => app.status === 'connected')
      .map(({ id, manifest, mode }) => ({ id, title: manifest.app.title, mode, actions: mode === 'collaborate' ? manifest.actions : {} }))
  };
}

export function dialogueContext(snapshot: HostSnapshot, receipt: unknown) { return { capabilities: capabilities(snapshot), receipt }; }

export function planningContext(snapshot: HostSnapshot, catalog: ReferenceCatalog, pendingClarification?: ReferenceClarification) {
  const { work } = capabilities(snapshot);
  return { capabilities: work, references: modelCandidates(catalog), complete: catalog.complete,
    defaultProject: catalog.defaultProjectId && `project:${catalog.defaultProjectId}`, pendingClarification };
}

export function taskStatus(snapshot: HostSnapshot, scope?: { taskId?: string; projectId?: string }) {
  const state = snapshot.work;
  const tasks = state.tasks.filter(task => (!scope?.taskId || task.id === scope.taskId) && (!scope?.projectId || task.projectId === scope.projectId));
  const taskIds = new Set(tasks.map(task => task.id));
  return { kind: 'task-status' as const, requests: pendingRequests(state).filter(event => taskIds.has(event.taskId)),
    permissionHandling: '权限请求请打开对应任务的原生会话处理。',
    tasks: tasks.slice(-10).map(task => {
      const attempt = state.attempts.find(item => item.id === task.attemptIds.at(-1));
      const assessment = attempt?.assessment;
      return { id: task.id, title: task.title, execution: task.status, review: assessment?.review, completeness: assessment?.completeness,
        missingFiles: assessment?.missingFiles, missingApp: assessment?.missingApp, validationFailures: assessment?.delivery.failures,
        pendingInputs: assessment?.pendingInputs, pendingPermissions: assessment?.pendingPermissions,
        acceptedAt: attempt?.acceptance?.acceptedAt, providerReport: attempt?.summary?.slice(0, 1200) };
    }) };
}
