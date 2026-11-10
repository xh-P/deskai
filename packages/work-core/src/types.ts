export type WorkStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
export interface WorkProject { id: string; name: string; path: string; createdAt: string }
export interface WorkDraft { id: string; projectId: string; text: string; updatedAt: string }
export interface WorkTask { id: string; projectId: string; title: string; prompt: string; authoring?: boolean; status: WorkStatus; attemptIds: string[]; createdAt: string; updatedAt: string }
export interface WorkAttempt { id: string; taskId: string; status: WorkStatus; prompt: string; providerSessionId?: string; summary?: string; error?: string; createdAt: string; updatedAt: string }
export interface WorkEvent { id: string; taskId: string; attemptId: string; time: string; type: string; data: unknown }
export interface WorkSnapshot { version: 1; projects: WorkProject[]; drafts: WorkDraft[]; tasks: WorkTask[]; attempts: WorkAttempt[]; events: WorkEvent[] }

export type WorkUiCommand =
  | { type: 'project-create'; name: string; path: string }
  | { type: 'draft-save'; projectId: string; text: string }
  | { type: 'submit'; projectId: string; prompt: string; authoring?: boolean }
  | { type: 'append' | 'continue'; taskId: string; prompt: string }
  | { type: 'retry' | 'cancel' | 'native-open'; taskId: string }
  | { type: 'reply'; taskId: string; requestId: string; response: unknown };

export type ProviderEvent =
  | { type: 'session'; providerSessionId: string }
  | { type: 'activity'; text: string; data?: unknown }
  | { type: 'permission' | 'question'; requestId: string; text: string; data?: unknown }
  | { type: 'request-resolved'; requestId: string }
  | { type: 'artifact'; path: string; data?: unknown };
export interface ProviderRequest { taskId: string; attemptId: string; projectPath: string; prompt: string; providerSessionId?: string; authoring?: boolean }
export interface ProviderResult { providerSessionId?: string; outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'; summary?: string; error?: string }
export interface ProviderPort {
  start(request: ProviderRequest, onEvent: (event: ProviderEvent) => void): Promise<ProviderResult>;
  append(attemptId: string, prompt: string): Promise<void>;
  cancel(attemptId: string): Promise<void>;
  reply(attemptId: string, requestId: string, response: unknown): Promise<void>;
}
