import { createHash } from 'node:crypto';
import type { WorkAttempt, WorkEffectCommand, WorkTask } from './types.ts';

export interface WorkOperation {
  id: string;
  kind: WorkEffectCommand['type'];
  signature: string;
  taskId: string;
  attemptId: string;
  previousAttemptId?: string;
  conversationId?: string;
  optionId?: string;
  acceptedAt: string;
  state: 'accepted' | 'pending' | 'acknowledged' | 'unknown';
  nativeRequestId?: string;
  error?: string;
}

export type WorkAdmission = Pick<WorkOperation, 'id' | 'kind' | 'signature' | 'conversationId' | 'optionId'>;
export interface WorkOperationReceipt {
  kind: 'work-operation';
  operation: Pick<WorkOperation, 'id' | 'kind' | 'taskId' | 'attemptId' | 'previousAttemptId' | 'state' | 'acceptedAt' | 'error'>;
  task: Pick<WorkTask, 'id' | 'projectId' | 'title'>;
  execution: { provider: 'dsh'; runId: string; status: WorkAttempt['status']; sessionId?: string; requestId?: string;
    review?: NonNullable<WorkAttempt['assessment']>['review']; error?: string };
}

export function operationSignature(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  return createHash('sha256').update(canonical).digest('hex');
}

export function assertOperationId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('WORK_OPERATION_ID_INVALID');
}

export function isWorkEffect(command: { type: string }): command is WorkEffectCommand {
  return ['submit', 'append', 'continue', 'retry', 'cancel', 'recover', 'reply'].includes(command.type);
}
