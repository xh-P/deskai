import type { WorkAttempt, WorkEvent, WorkStatus, WorkTask } from './types.ts';
import type { WorkOperation } from './operations.ts';
import { unresolvedRequests } from './requests.ts';

export interface VerifiedFile { id: string; relativePath: string; sha256: string }
export interface DeliveryFailure { relativePath?: string; reason: string }
export interface DeliveryEvidence { files: VerifiedFile[]; appEntries: string[]; failures: DeliveryFailure[] }
export interface CompletionAssessment {
  execution: WorkStatus;
  completeness: 'unknown' | 'incomplete' | 'partial' | 'complete';
  attention: 'none' | 'error' | 'permission' | 'input' | 'review';
  review: 'open' | 'review_ready' | 'accepted';
  missingFiles: string[];
  missingApp: boolean;
  pendingPermissions: number;
  pendingInputs: number;
  delivery: DeliveryEvidence;
}
export interface AcceptanceReceipt {
  id: string; taskId: string; attemptId: string; acceptedAt: string; assessment: CompletionAssessment;
}

const executionLabels: Record<string, string> = { queued: '排队', running: '运行中', waiting: '等待答复', completed: '执行已结束',
  failed: '执行失败', cancelled: '已取消', interrupted: '已中断', unknown: '状态未知' };
export const workExecutionLabel = (status: string) => executionLabels[status] ?? status;

const operationLabels: Record<WorkOperation['state'], string> = { accepted: '操作已受理', pending: '等待操作确认',
  acknowledged: '已收到操作确认', unknown: '操作结果待确认' };
export const workOperationLabel = (state: WorkOperation['state']) => operationLabels[state];

export const artifactPath = (value: string) => value.replace(/\\/g, '/');
export function expectedFiles(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64) throw new Error('WORK_EXPECTED_ARTIFACTS_INVALID');
  return [...new Set(value.map(file => {
    if (typeof file !== 'string' || !file.trim() || file.length > 1024 || /[:\u0000-\u001f]/.test(file)) throw new Error('WORK_EXPECTED_ARTIFACT_PATH_INVALID');
    const normalized = artifactPath(file.trim());
    if (normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('WORK_EXPECTED_ARTIFACT_PATH_INVALID');
    return normalized;
  }))];
}

/** Evaluate verified delivery evidence separately from the provider's execution result. */
export function assessCompletion(task: WorkTask, attempt: WorkAttempt, events: WorkEvent[]): CompletionAssessment {
  const delivery = attempt.delivery ?? { files: [], appEntries: [], failures: [] };
  const registered = new Set(delivery.files.map(file => artifactPath(file.relativePath)));
  const requests = unresolvedRequests(events.filter(event => event.attemptId === attempt.id));
  const evidence = {
    execution: attempt.status, missingFiles: (task.expectedArtifacts ?? []).filter(file => !registered.has(file)),
    missingApp: task.authoring === true && !delivery.appEntries.length,
    pendingPermissions: requests.filter(event => event.type === 'permission').length,
    pendingInputs: requests.filter(event => event.type === 'question').length,
    delivery
  };
  const decision = (completeness: CompletionAssessment['completeness'], attention: CompletionAssessment['attention'],
      review: CompletionAssessment['review'] = 'open'): CompletionAssessment => ({ ...evidence, completeness, attention, review });
  if (attempt.status === 'unknown' || attempt.status === 'interrupted') return decision('unknown', 'error');
  if (attempt.status === 'failed') return decision('incomplete', 'error');
  if (attempt.status === 'cancelled') return decision('incomplete', 'review');
  if (evidence.pendingPermissions) return decision(attempt.status === 'completed' ? 'partial' : 'unknown', 'permission');
  if (evidence.pendingInputs) return decision(attempt.status === 'completed' ? 'partial' : 'unknown', 'input');
  if (attempt.status !== 'completed') return decision('unknown', 'none');
  if (delivery.failures.length) return decision('partial', 'error');
  if (evidence.missingFiles.length || evidence.missingApp) return decision('partial', 'review');
  const explicitCriteria = (task.expectedArtifacts?.length ?? 0) > 0 || task.authoring === true;
  return decision(explicitCriteria ? 'complete' : 'partial', 'review', 'review_ready');
}

export function completionLabel(assessment?: CompletionAssessment): string {
  if (!assessment) return '等待评估';
  if (assessment.review === 'accepted') return '用户已验收';
  if (assessment.review === 'review_ready') return '待人工验收';
  if (assessment.execution !== 'completed') return '交付尚未就绪';
  if (assessment.attention === 'permission') return '仍有权限请求';
  if (assessment.attention === 'input') return '仍有待答复事项';
  if (assessment.delivery.failures.length) return '交付验证失败';
  return '交付证据不足';
}
