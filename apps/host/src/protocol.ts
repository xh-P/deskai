import type { Artifact, SessionSnapshot } from '../../../packages/app-core/src/index.ts';
import type { ExportReceipt } from '../../../packages/app-core/src/exports.ts';
import type { WorkRuntimeStatus } from '../../../packages/dsh-adapter/src/work-runtime.ts';
import type { CoordinationPlan } from '../../../packages/voice-core/src/coordination.ts';
import type { WorkSnapshot, WorkUiCommand } from '../../../packages/work-core/src/types.ts';

export interface HostSnapshot {
  work: WorkSnapshot;
  artifacts: Artifact[];
  apps: SessionSnapshot[];
  exports: ExportReceipt[];
  runtime: WorkRuntimeStatus;
  selectedProjectId: string;
  selectedTaskId: string;
  selectedAppId: string;
}

export type HostSelection = { projectId?: string; taskId?: string; appSessionId?: string };
export type HostCommand =
  | { type: 'work'; command: Exclude<WorkUiCommand, { type: 'native-open' }> }
  | ({ type: 'select' } & HostSelection)
  | { type: 'plan'; plan: CoordinationPlan }
  | { type: 'diff'; attemptId: string }
  | { type: 'artifact-preview' | 'artifact-launch'; artifactId: string }
  | { type: 'artifact-export'; artifactId: string; destination: string }
  | { type: 'app-action'; sessionId: string; action: string; payload: unknown }
  | { type: 'app-close'; sessionId: string }
  | { type: 'native-window' }
  | { type: 'shutdown' };
