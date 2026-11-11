import type { WorkEvent, WorkSnapshot } from './types.ts';

/** Pending interactions belong to the current live attempt, including native UI answers. */
export function pendingRequests(state: WorkSnapshot): WorkEvent[] {
  const live = new Set(state.tasks.filter(task => ['queued', 'running', 'waiting'].includes(task.status))
    .map(task => task.attemptIds.at(-1)));
  return unresolvedRequests(state.events.filter(event => live.has(event.attemptId)));
}

export function unresolvedRequests(events: WorkEvent[]): WorkEvent[] {
  const pending = new Map<string, WorkEvent>();
  for (const event of events) {
    const requestId = (event.data as { requestId?: string } | undefined)?.requestId;
    if (!requestId) continue;
    const key = `${event.attemptId}:${requestId}`;
    if (event.type === 'permission' || event.type === 'question') pending.set(key, event);
    else if (event.type === 'reply' || event.type === 'request-resolved') pending.delete(key);
  }
  return [...pending.values()];
}
