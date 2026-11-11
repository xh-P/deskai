import type { AppStateVersion, Artifact, SessionSnapshot } from '../../../packages/app-core/src/index.ts';
import type { EngagementMode } from '../../../packages/app-core/src/auip-contract.ts';
import type { ExportReceipt } from '../../../packages/app-core/src/exports.ts';
import type { WorkRuntimeStatus } from '../../../packages/dsh-adapter/src/work-runtime.ts';
import type { CoordinationPlan, ReferenceSelection } from '../../../packages/voice-core/src/coordination.ts';
import type { WorkSnapshot, WorkUiCommand } from '../../../packages/work-core/src/types.ts';
import type { ControlTurn } from './conversation-control.ts';
import type { PlannerRequest } from '../../../packages/work-core/src/telemetry.ts';

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
  | { type: 'work'; command: Exclude<WorkUiCommand, { type: 'native-open' }>; operationId?: string }
  | { type: 'work-receipt'; operationId: string }
  | ({ type: 'select' } & HostSelection)
  | { type: 'plan-context'; turn: ControlTurn }
  | { type: 'plan'; turn: ControlTurn; plan: CoordinationPlan; requests?: PlannerRequest[] }
  | { type: 'work-trace-page'; taskId: string; before: string }
  | { type: 'reference-select'; conversationId: string; selection: ReferenceSelection }
  | { type: 'reference-dismiss'; conversationId: string; clarificationId: string }
  | { type: 'diff'; attemptId: string }
  | { type: 'artifact-preview' | 'artifact-launch'; artifactId: string }
  | { type: 'artifact-export'; artifactId: string; destination: string }
  | { type: 'app-action'; sessionId: string; action: string; payload: unknown; expected: AppStateVersion }
  | { type: 'app-mode'; sessionId: string; mode: EngagementMode }
  | { type: 'app-close'; sessionId: string }
  | { type: 'native-window' }
  | { type: 'shutdown' };
