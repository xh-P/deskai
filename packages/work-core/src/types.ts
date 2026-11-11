import type { AcceptanceReceipt, CompletionAssessment, DeliveryEvidence } from './completion.ts';
import type { WorkOperation } from './operations.ts';
import type { NativeTrace } from './telemetry.ts';

export type WorkStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
export interface WorkProject { id: string; name: string; path: string; createdAt: string }
export interface WorkDraft { id: string; projectId: string; text: string; updatedAt: string }
export type WorkWorkspace =
  | { kind: 'git'; path: string; root: string; repository: string; branch: string }
  | { kind: 'local'; path: string; repository?: string };
export type WorkBaseline = { kind: 'git'; root: string; tree: string } | { kind: 'local' };
export interface WorkChanges { before: string; after: string; fileCount: number }
export interface ProviderBinding { baseline: number; requestIds: string[]; removedIds?: string[] }
export interface WorkTask { id: string; projectId: string; title: string; prompt: string; authoring?: boolean; expectedArtifacts?: string[]; status: WorkStatus; workspace?: WorkWorkspace; attemptIds: string[]; createdAt: string; updatedAt: string }
export interface WorkAttempt {
  id: string; taskId: string; operationId: string; status: WorkStatus; prompt: string; providerSessionId?: string; binding?: ProviderBinding;
  baseline?: WorkBaseline; changes?: WorkChanges; artifactFiles?: { relativePath: string; sha256: string }[]; deliveryError?: string; result?: ProviderResult;
  delivery?: DeliveryEvidence; assessment?: CompletionAssessment; acceptance?: AcceptanceReceipt;
  summary?: string; error?: string; createdAt: string; updatedAt: string;
}
export interface WorkEvent { id: string; taskId: string; attemptId: string; time: string; type: string; data: unknown; providerSeq?: number }
export interface WorkSnapshot { version: 1; projects: WorkProject[]; drafts: WorkDraft[]; tasks: WorkTask[]; attempts: WorkAttempt[]; events: WorkEvent[]; operations: WorkOperation[] }
export type WorkHistory = { task: WorkTask; attempts: WorkAttempt[]; events: WorkEvent[]; operations: WorkOperation[] };

export type WorkEffectCommand =
  | { type: 'submit'; projectId: string; prompt: string; title?: string; authoring?: boolean; expectedArtifacts?: string[] }
  | { type: 'append' | 'continue'; taskId: string; prompt: string }
  | { type: 'retry' | 'cancel' | 'recover'; taskId: string }
  | { type: 'reply'; taskId: string; requestId: string; response: unknown };

export type WorkUiCommand = WorkEffectCommand
  | { type: 'project-create'; name: string; path: string }
  | { type: 'draft-save'; projectId: string; text: string }
  | { type: 'accept' | 'recheck'; taskId: string; attemptId: string }
  | { type: 'native-open'; taskId: string; attemptId: string };

export type ProviderEvent = (
  | { type: 'session'; providerSessionId: string }
  | { type: 'binding'; binding: ProviderBinding }
  | { type: 'request-admitted'; requestId: string }
  | { type: 'activity'; text: string; data?: unknown }
  | { type: 'trace'; entry: NativeTrace }
  | { type: 'permission'; requestId: string; text: string; data?: unknown }
  | { type: 'question'; requestId: string; text: string; data?: unknown; answerable?: boolean }
  | { type: 'request-resolved'; requestId: string }
  | { type: 'artifact'; path: string; data?: unknown }
  | { type: 'artifact-manifest-invalid'; reason: string }
) & { providerSeq?: number };
export interface ProviderRequest { taskId: string; attemptId: string; projectPath: string; prompt: string; requestId: string; providerSessionId?: string; authoring?: boolean; expectedArtifacts?: string[] }
export interface ProviderResult {
  providerSessionId?: string; outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
  summary?: string; error?: string; unsettled?: boolean;
}
export interface ProviderPort {
  start(request: ProviderRequest, onEvent: (event: ProviderEvent) => void): Promise<ProviderResult>;
  recover?(request: ProviderRequest & { providerSessionId: string; binding: ProviderBinding }, onEvent: (event: ProviderEvent) => void): Promise<ProviderResult>;
  append(attemptId: string, prompt: string, requestId: string): Promise<void>;
  cancel(attemptId: string): Promise<void>;
  reply(attemptId: string, requestId: string, response: unknown): Promise<void>;
}
