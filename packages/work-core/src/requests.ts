import type { WorkEvent, WorkSnapshot } from './types.ts';

/** Pending interactions belong to the current live attempt, including native UI answers. */
export function pendingRequests(state: WorkSnapshot): WorkEvent[] {
  const live = new Set(state.tasks.filter(task => ['queued', 'running', 'waiting'].includes(task.status))
    .map(task => task.attemptIds.at(-1)));
  const resolved = new Set(state.events.filter(event => event.type === 'reply' || event.type === 'request-resolved')
    .map(event => `${event.attemptId}:${(event.data as { requestId?: string })?.requestId}`));
  return state.events.filter(event => live.has(event.attemptId) && (event.type === 'permission' || event.type === 'question') &&
    !resolved.has(`${event.attemptId}:${(event.data as { requestId?: string })?.requestId}`));
}
