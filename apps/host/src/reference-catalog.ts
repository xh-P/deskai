import path from 'node:path';
import { pendingRequests } from '../../../packages/work-core/src/requests.ts';
import type { AppStateVersion } from '../../../packages/app-core/src/app-host.ts';
import type { ReferenceIntent, ReferenceKind, ReferencePlan } from '../../../packages/voice-core/src/coordination.ts';
import type { HostSelection, HostSnapshot } from './protocol.ts';

export type ReferenceCandidate = {
  token: string; kind: ReferenceKind; id: string; label: string; aliases: string[];
  parentLabel?: string; projectId?: string; taskId?: string; attemptId?: string; execution?: string;
  detail?: string; goal?: string; selected?: boolean; current?: boolean; requestId?: string;
  question?: unknown; appVersion?: AppStateVersion; application?: unknown;
};
export type ReferenceCatalog = { candidates: ReferenceCandidate[]; complete: Record<ReferenceKind, boolean>; defaultProjectId: string };
type Resolution = { kind: 'selected'; target: ReferenceCandidate } | { kind: 'choose'; targets: ReferenceCandidate[] } |
  { kind: 'none' } | { kind: 'missing' };
const catalogLimit = 200;
const kinds: Record<ReferenceIntent, ReferenceKind[]> = {
  submit: ['project'], status: ['project', 'work_item'], append: ['work_item'], resume: ['work_item'], retry: ['work_item'],
  cancel: ['work_item'], reply: ['question'], app: ['app_session']
};
const normalized = (value: string) => value.normalize('NFKC').toLowerCase().trim().replace(/\\/g, '/');
const latinWord = (value: string | undefined) => value !== undefined && /[a-z0-9_]/.test(value);

function containsName(text: string, value: string): boolean {
  const name = normalized(value);
  if (!name) return false;
  const source = normalized(text);
  for (let at = source.indexOf(name); at >= 0; at = source.indexOf(name, at + 1)) {
    if (latinWord(name[0]) && latinWord(source[at - 1])) continue;
    if (latinWord(name.at(-1)) && latinWord(source[at + name.length])) continue;
    return true;
  }
  return false;
}
const names = (candidate: ReferenceCandidate, text: string) => candidate.aliases.some(alias => containsName(text, alias));

/** Freeze names, ownership, explicit focus and execution identity for one user turn. */
export function referenceCatalog(snapshot: HostSnapshot, focus: HostSelection, conversationId: string, text: string): ReferenceCatalog {
  const { work } = snapshot;
  const projects = new Map(work.projects.map(project => [project.id, project]));
  const tasks = new Map(work.tasks.map(task => [task.id, task]));
  const current = work.operations?.filter(operation => operation.conversationId === conversationId).at(-1);
  const currentTask = current && tasks.get(current.taskId);
  const rows: ReferenceCandidate[] = [];
  for (const project of work.projects) rows.push({ kind: 'project', token: `project:${project.id}`, id: project.id, label: project.name,
    aliases: [project.name, project.path, path.basename(project.path)], detail: project.path,
    selected: focus.projectId === project.id, current: currentTask?.projectId === project.id });
  const artifactAliases = new Map<string, string[]>();
  for (const artifact of snapshot.artifacts) {
    const entries = artifactAliases.get(artifact.taskId) ?? [];
    if (entries.length < 6 && !entries.includes(artifact.relativePath)) {
      entries.push(artifact.relativePath); artifactAliases.set(artifact.taskId, entries);
    }
  }
  for (const task of work.tasks.slice().reverse()) {
    const files = [...new Set([...(task.expectedArtifacts ?? []), ...(artifactAliases.get(task.id) ?? [])])].slice(0, 6);
    const goal = task.prompt.slice(0, 400);
    rows.push({ kind: 'work_item', token: `work_item:${task.id}`, id: task.id, label: task.title,
      aliases: [...new Set([task.title, ...files, ...files.map(file => path.basename(file))])], goal,
      projectId: task.projectId, parentLabel: projects.get(task.projectId)?.name, attemptId: task.attemptIds.at(-1), execution: task.status,
      selected: focus.taskId === task.id, current: currentTask?.id === task.id });
  }
  for (const event of pendingRequests(work)) {
    if (event.type !== 'question') continue;
    const task = tasks.get(event.taskId);
    const value = event.data as { requestId?: string; text?: string; data?: unknown };
    if (!task || !value.requestId) continue;
    rows.push({ kind: 'question', token: `question:${event.id}`, id: event.id, label: value.text ?? task.title, aliases: [task.title],
      parentLabel: task.title, projectId: task.projectId, taskId: task.id, attemptId: event.attemptId, requestId: value.requestId, question: value.data });
  }
  for (const app of snapshot.apps) {
    if (app.status !== 'connected' || app.mode !== 'collaborate' || !app.state) continue;
    rows.push({ kind: 'app_session', token: `app_session:${app.id}`, id: app.id, label: app.manifest.app.title,
      aliases: [app.manifest.app.title, app.manifest.app.id], selected: focus.appSessionId === app.id,
      appVersion: { revision: app.revision, generation: app.generation },
      application: { description: app.manifest.app, actions: app.manifest.actions, state: app.state } });
  }
  const defaultProjectId = focus.projectId ?? currentTask?.projectId ?? snapshot.selectedProjectId;
  const complete = {} as Record<ReferenceKind, boolean>;
  const candidates: ReferenceCandidate[] = [];
  for (const kind of ['project', 'work_item', 'app_session', 'question'] as const) {
    const group = rows.filter(row => row.kind === kind);
    complete[kind] = group.length <= catalogLimit;
    const rank = (row: ReferenceCandidate) => names(row, text) ? 0 : row.selected || row.current || row.id === defaultProjectId ? 1 : row.projectId === defaultProjectId ? 2 : 3;
    candidates.push(...group.map(row => ({ row, rank: rank(row) })).sort((a, b) => a.rank - b.rank).slice(0, catalogLimit).map(({ row }) => row));
  }
  return { candidates, complete, defaultProjectId };
}

export function modelCandidates(catalog: ReferenceCatalog) {
  return catalog.candidates.map(({ token, kind, label, aliases, parentLabel, projectId, taskId, goal, execution, selected, current, question, application, detail }) => ({
    token, kind, label, aliases, parentLabel, project: projectId && `project:${projectId}`, work: taskId && `work_item:${taskId}`,
    goal, execution, selected: selected || undefined, current: current || undefined, question, application, detail
  }));
}

export function resolveReference(catalog: ReferenceCatalog, plan: ReferencePlan, text: string): Resolution {
  const candidates = catalog.candidates;
  const phrase = plan.referenceText ?? text;
  if (plan.referenceText && !text.includes(plan.referenceText)) throw new Error('COORDINATION_REFERENCE_NOT_IN_INPUT');
  const projects = candidates.filter(row => row.kind === 'project');
  const projectsInReference = projects.filter(row => names(row, phrase));
  const namedProjects = projectsInReference.length ? projectsInReference : projects.filter(row => names(row, text));
  if (plan.references === null) {
    if (plan.intent === 'status' && !namedProjects.length) return { kind: 'none' };
    if (namedProjects.some(row => row.id !== catalog.defaultProjectId) || plan.intent === 'status')
      return { kind: 'choose', targets: namedProjects };
    const target = candidates.find(row => row.kind === 'project' && row.id === catalog.defaultProjectId);
    return target ? { kind: 'selected', target } : { kind: 'missing' };
  }
  if (!plan.references.length) return { kind: 'missing' };
  const byToken = new Map(candidates.map(row => [row.token, row]));
  const proposed = plan.references.map(token => {
    const row = byToken.get(token);
    if (!row || !kinds[plan.intent].includes(row.kind)) throw new Error('COORDINATION_REFERENCE_INVALID');
    return row;
  });
  const projectId = namedProjects.length === 1 ? namedProjects[0].id : undefined;
  const withinProject = (row: ReferenceCandidate) => !projectId || !row.projectId || row.projectId === projectId;
  const targets = proposed.filter(withinProject);
  if (!targets.length) throw new Error('COORDINATION_PROJECT_MISMATCH');
  if (proposed.length > 1) return { kind: 'choose', targets };
  const [target] = targets;
  const scope = candidates.filter(row => row.kind === target.kind && withinProject(row));
  const named = scope.filter(row => names(row, phrase));
  if (named.length) {
    if (!named.includes(target)) throw new Error('COORDINATION_REFERENCE_MISMATCH');
    if (named.length > 1 || !catalog.complete[target.kind]) return { kind: 'choose', targets: named };
    return { kind: 'selected', target };
  }
  let contextual = scope;
  if (target.projectId && !projectId) {
    const local = scope.filter(row => row.projectId === catalog.defaultProjectId);
    if (local.length) contextual = local;
  }
  const explicit = contextual.find(row => row.selected);
  const conversation = contextual.find(row => row.current);
  if (explicit === target || !explicit && conversation === target) return { kind: 'selected', target };
  if (target.kind === 'question') {
    const work = candidates.find(row => row.kind === 'work_item' && row.selected) ?? candidates.find(row => row.kind === 'work_item' && row.current);
    const questions = work && contextual.filter(row => row.taskId === work.id);
    if (questions?.length) contextual = questions;
  }
  if (!explicit && !conversation && catalog.complete[target.kind] && contextual.length === 1 && contextual[0] === target)
    return { kind: 'selected', target };
  return { kind: 'choose', targets: [...new Set([...contextual, target])] };
}
