import type { InputDiagnostic } from './index.ts';

export type OutputDiagnostic = {
  type: 'input-submitted' | 'input-accepted' | 'model-started' | 'model-first-text' | 'model-decision'
    | 'tts-started' | 'tts-first-pcm' | 'tts-finished' | 'tts-failed' | 'playback-enqueued' | 'interruption-confirmed' | 'output-cleared';
  monotonicMs: number;
  sessionId: string;
  turnId?: string;
  attemptId?: string;
  segmentId?: string;
  generationId?: number;
  inputRevision?: number;
  utteranceIds?: number[];
  durationMs?: number;
};
export type VoiceDiagnostics = { continuationWindowMs: number; input: InputDiagnostic[]; output: OutputDiagnostic[] };
type Fields = Omit<OutputDiagnostic, 'type' | 'monotonicMs'>;

/** A bounded, in-memory timing trace. Explicit fields prevent text/PCM from entering diagnostics. */
export class OutputTimeline {
  private rows: OutputDiagnostic[] = [];

  record(type: OutputDiagnostic['type'], fields: Fields, once = false): void {
    if (once && this.rows.some(row => row.type === type && row.sessionId === fields.sessionId
      && row.turnId === fields.turnId && row.attemptId === fields.attemptId && row.segmentId === fields.segmentId
      && row.generationId === fields.generationId)) return;
    const row: OutputDiagnostic = { type, monotonicMs: performance.now(), sessionId: fields.sessionId };
    for (const key of ['turnId', 'attemptId', 'segmentId'] as const) {
      if (fields[key] !== undefined) row[key] = fields[key];
    }
    for (const key of ['generationId', 'inputRevision', 'durationMs'] as const) {
      if (fields[key] !== undefined) row[key] = fields[key];
    }
    if (fields.utteranceIds) row.utteranceIds = [...fields.utteranceIds];
    this.rows.push(row);
    if (this.rows.length > 100) this.rows.shift();
  }

  clear(): void { this.rows = []; }
  snapshot(): OutputDiagnostic[] {
    return this.rows.map(row => ({ ...row, ...(row.utteranceIds ? { utteranceIds: [...row.utteranceIds] } : {}) }));
  }
}
