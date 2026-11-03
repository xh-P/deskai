import type { DialogueEvent } from '../../voice-core/src/dialogue.ts';
import type { PetPreferences, PetSnapshot, PetState } from './types.ts';

type InputState = 'OFF' | 'LISTENING' | 'CAPTURING' | 'SETTLING' | 'TRANSCRIBING' | 'ACCUMULATING';
type ModelState = 'idle' | 'generating' | 'cancelling' | 'waiting' | 'silent' | 'error';
type Playback = { sessionId: string; generationId: number; playing: boolean; paused: boolean; completed?: boolean };
type Progress = { generationId: number; text: string; completed: boolean };

/** Projects actual session, model and playback receipts into a visual state. */
export class PetActivity {
  private sessionId: string | null = null;
  private generationFloor = 0;
  private captureArmed = false;
  private inputState: InputState = 'OFF';
  private modelState: ModelState = 'idle';
  private playbackGeneration = -1;
  private playbackPlaying = false;
  private playbackPaused = false;
  private spokenText = '';
  private error = false;

  startSession(sessionId: string, captureArmed = false): void {
    if (!sessionId || this.sessionId === sessionId) {
      this.captureArmed = captureArmed;
      return;
    }
    this.sessionId = sessionId;
    this.generationFloor = 0;
    this.captureArmed = captureArmed;
    this.inputState = 'OFF';
    this.modelState = 'idle';
    this.playbackGeneration = -1;
    this.playbackPlaying = false;
    this.playbackPaused = false;
    this.spokenText = '';
    this.error = false;
  }

  stopSession(retainError = false): void {
    this.sessionId = null;
    this.captureArmed = false;
    this.inputState = 'OFF';
    this.modelState = 'idle';
    this.playbackPlaying = false;
    this.playbackPaused = false;
    this.spokenText = '';
    this.error = retainError;
  }

  setCaptureArmed(armed: boolean): void {
    this.captureArmed = armed;
    if (!armed) this.inputState = 'OFF';
  }

  input(state: string): void {
    if (!this.sessionId || !['OFF', 'LISTENING', 'CAPTURING', 'SETTLING', 'TRANSCRIBING', 'ACCUMULATING'].includes(state)) return;
    this.inputState = state as InputState;
    if (state === 'CAPTURING' || state === 'TRANSCRIBING') {
      if (this.modelState === 'waiting' || this.modelState === 'silent') this.modelState = 'idle';
      this.error = false;
    }
  }

  dialogue(event: DialogueEvent): void {
    if (!this.sessionId) return;
    if (event.type === 'user') {
      if (this.modelState === 'waiting' || this.modelState === 'silent') this.modelState = 'idle';
      this.error = false;
    } else if (event.type === 'decision') {
      if (event.action === 'WAIT' || event.action === 'SILENT') {
        this.modelState = event.action === 'WAIT' ? 'waiting' : 'silent';
      }
    } else if (event.type === 'model-state') {
      this.modelState = event.state;
      if (event.state === 'generating') this.error = false;
      if (event.state === 'error') this.error = true;
    } else if (event.type === 'output-clear') {
      this.output('clear', event.generationId);
    } else if (event.type === 'assistant-state' && event.generationId >= this.generationFloor) {
      if (event.state === 'interrupted' || event.state === 'error') {
        this.spokenText = '';
        this.playbackPlaying = false;
        if (event.state === 'error') this.error = true;
      }
    } else if (event.type === 'error') {
      this.error = true;
      this.spokenText = '';
      this.playbackPlaying = false;
    }
  }

  output(command: 'clear' | 'pause' | 'resume', generationId: number): void {
    if (!Number.isSafeInteger(generationId) || generationId < this.generationFloor) return;
    if (command === 'clear') {
      this.generationFloor = generationId;
      this.playbackGeneration = -1;
      this.playbackPlaying = false;
      this.playbackPaused = false;
      this.spokenText = '';
    } else if (command === 'pause') {
      this.playbackPaused = true;
      this.playbackPlaying = false;
      this.spokenText = '';
    } else {
      this.playbackPaused = false;
      this.playbackPlaying = false;
      this.spokenText = '';
    }
  }

  playback(report: Playback): void {
    if (!this.sessionId || report.sessionId !== this.sessionId || !Number.isSafeInteger(report.generationId) ||
        report.generationId < this.generationFloor) return;
    this.playbackGeneration = report.generationId;
    this.playbackPaused = report.paused === true;
    this.playbackPlaying = report.playing === true && !this.playbackPaused && report.completed !== true;
    if (!this.playbackPlaying) this.spokenText = '';
  }

  spoken(progress: Progress): void {
    if (!this.sessionId || progress.generationId < this.generationFloor ||
        progress.generationId !== this.playbackGeneration || !this.playbackPlaying || this.playbackPaused) return;
    this.spokenText = progress.completed ? '' : progress.text.slice(0, 160);
    if (progress.completed) this.playbackPlaying = false;
  }

  fail(): void {
    if (!this.sessionId) return;
    this.error = true;
    this.spokenText = '';
    this.playbackPlaying = false;
  }

  clearError(): void { this.error = false; if (this.modelState === 'error') this.modelState = 'idle'; }

  snapshot(preferences: PetPreferences): PetSnapshot {
    let state: PetState = this.error ? 'error' : 'off';
    if (this.sessionId) {
      if (this.error || this.modelState === 'error') state = 'error';
      else if (this.playbackPaused || this.modelState === 'cancelling') state = 'paused';
      else if (this.playbackPlaying && this.spokenText) state = 'speaking';
      else if (this.modelState === 'waiting') state = 'waiting';
      else if (this.modelState === 'silent') state = 'silent';
      else if (this.modelState === 'generating') state = 'thinking';
      else if (['SETTLING', 'TRANSCRIBING', 'ACCUMULATING'].includes(this.inputState)) state = 'recognizing';
      else if (this.captureArmed) state = 'listening';
    }
    return {
      variant: preferences.variant, size: preferences.size, visible: preferences.visible,
      alwaysOnTop: preferences.alwaysOnTop, motionMode: preferences.motionMode, state,
      subtitle: state === 'speaking' ? this.spokenText : '',
      sessionId: this.sessionId, generationId: Math.max(this.generationFloor, this.playbackGeneration),
    };
  }
}
