import type { WorkEvent, WorkSnapshot } from './types.ts';

/** Pending interactions belong to the current live attempt, including native UI answers. */
export function pendingRequests(state: WorkSnapshot): WorkEvent[] {
  const live = new Set(state.tasks.filter(task => ['queued', 'running', 'waiting'].includes(task.status))
    .map(task => task.attemptIds.at(-1)));
  return unresolvedRequests(state.events.filter(event => live.has(event.attemptId)));
}

export function unresolvedRequests(events: WorkEvent[]): WorkEvent[] {
  const resolved = new Set(events.filter(event => event.type === 'reply' || event.type === 'request-resolved')
    .map(event => `${event.attemptId}:${(event.data as { requestId?: string })?.requestId}`));
  return events.filter(event => (event.type === 'permission' || event.type === 'question') &&
    !resolved.has(`${event.attemptId}:${(event.data as { requestId?: string })?.requestId}`));
}
