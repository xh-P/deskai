import { pendingRequests } from '../../../packages/work-core/src/requests.ts';
import type { HostSnapshot } from './protocol.ts';

function capabilities(snapshot: HostSnapshot) {
  const project = snapshot.work.projects.find(project => project.id === snapshot.selectedProjectId);
  return {
    work: { executor: 'dsh', delegation: '通过 Host 委派执行任务，支持提交、查询、补充、取消、重试、继续和回答任务问题。',
      permission: '默认开启自动审查，权限请求需在原生会话中处理。',
      readiness: '执行器配置存在不代表原生运行环境已经就绪。以实际执行回执和状态为准。' },
    selectedProject: project ? { id: project.id, name: project.name, path: project.path } : null,
    applications: snapshot.apps.filter(app => app.status === 'connected')
      .map(({ id, manifest, mode }) => ({ id, title: manifest.app.title, mode, actions: mode === 'collaborate' ? manifest.actions : {} }))
  };
}

export function dialogueContext(snapshot: HostSnapshot, receipt: unknown) { return { capabilities: capabilities(snapshot), receipt }; }

export function planningContext(snapshot: HostSnapshot) {
  const state = snapshot.work;
  const { work, selectedProject } = capabilities(snapshot);
  const { selectedProjectId, selectedTaskId, selectedAppId } = snapshot;
  return { capabilities: { work, selectedProject }, selectedProjectId, selectedTaskId, selectedAppId,
    projects: state.projects.map(({ id, name, path }) => ({ id, name, path })),
    tasks: state.tasks.slice(-20).map(task => {
      const attempt = state.attempts.find(item => item.id === task.attemptIds.at(-1));
      return { id: task.id, title: task.title, execution: task.status, projectId: task.projectId,
        review: attempt?.assessment?.review, providerReport: attempt?.summary?.slice(0, 600) };
    }),
    requests: pendingRequests(state).slice(-8),
    apps: snapshot.apps.filter(app => app.status === 'connected' && app.state).map(({ id, manifest, state, revision, mode, controller }) => ({
      id, app: manifest.app, actions: mode === 'collaborate' ? manifest.actions : {}, state, revision, mode, controller: controller?.status })) };
}
