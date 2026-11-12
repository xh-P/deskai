import type { DialogueEvent } from '../../voice-core/src/dialogue.ts';
import type { PetGesture, PetPreferences, PetSnapshot, PetState } from './types.ts';
import type { MouthFrame } from './live2d.ts';

type InputState = 'OFF' | 'LISTENING' | 'CAPTURING' | 'SETTLING' | 'TRANSCRIBING' | 'ACCUMULATING';
type ModelState = 'idle' | 'generating' | 'cancelling' | 'waiting' | 'silent' | 'error';
type Playback = { sessionId: string; generationId: number; playing: boolean; paused: boolean; completed?: boolean };
type Progress = { generationId: number; text: string; completed: boolean; attemptId?: string; segmentId?: string };
type GestureEvent = Extract<DialogueEvent, { type: 'gesture' }>;

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
  private held = false;
  private segment?: Progress;
  private pendingGesture?: GestureEvent;
  private gesture?: PetGesture;
  private lastMouthFrame = -1;
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
    this.held = false;
    this.segment = undefined;
    this.clearGestures();
    this.lastMouthFrame = -1;
    this.error = false;
  }

  stopSession(retainError = false): void {
    this.sessionId = null;
    this.captureArmed = false;
    this.inputState = 'OFF';
    this.modelState = 'idle';
    this.playbackPlaying = false;
    this.playbackPaused = false;
    this.held = false;
    this.segment = undefined;
    this.clearGestures();
    this.error = retainError;
  }

  setCaptureArmed(armed: boolean): void {
    this.captureArmed = armed;
    if (!armed) this.inputState = 'OFF';
  }

  clearGestures(): void { this.pendingGesture = this.gesture = undefined; }

  input(state: string): void {
    if (!this.sessionId || !['OFF', 'LISTENING', 'CAPTURING', 'SETTLING', 'TRANSCRIBING', 'ACCUMULATING'].includes(state)) return;
    this.inputState = state as InputState;
    if (state === 'CAPTURING' && !this.playbackPlaying) this.gesture = undefined;
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
      if (event.state === 'generating') { this.error = false; this.clearGestures(); }
      if (event.state === 'error') this.fail();
    } else if (event.type === 'gesture' && event.generationId >= this.generationFloor && !this.error) {
      if (event.timing === 'speech') this.pendingGesture = event;
      else if (!this.playbackPaused) this.gesture = { ...event.gesture, startedAt: Date.now() };
    } else if (event.type === 'output-clear') {
      this.output('clear', event.generationId);
    } else if (event.type === 'assistant-state' && event.generationId >= this.generationFloor) {
      if (event.state === 'interrupted' || event.state === 'error') {
        this.segment = undefined;
        this.playbackPlaying = false;
        this.clearGestures();
        if (event.state === 'error') this.error = true;
      }
    } else if (event.type === 'error') {
      this.fail();
    }
  }

  output(command: 'clear' | 'pause' | 'resume', generationId: number): void {
    if (!Number.isSafeInteger(generationId) || generationId < this.generationFloor) return;
    this.held = command === 'pause';
    if (command === 'clear') {
      this.generationFloor = generationId;
      this.playbackGeneration = -1;
      this.playbackPlaying = false;
      this.playbackPaused = false;
      this.segment = undefined;
      this.lastMouthFrame = -1;
      this.clearGestures();
    } else if (command === 'pause') {
      this.playbackPaused = true;
      this.playbackPlaying = false;
      this.segment = undefined;
      this.gesture = undefined;
    } else {
      this.playbackPaused = false;
      this.playbackPlaying = false;
      this.segment = undefined;
    }
  }

  playback(report: Playback): void {
    if (!this.sessionId || report.sessionId !== this.sessionId || !Number.isSafeInteger(report.generationId) ||
        report.generationId < this.generationFloor) return;
    if (this.playbackGeneration !== report.generationId) this.segment = undefined;
    this.playbackGeneration = report.generationId;
    this.playbackPaused = this.held || report.paused === true;
    this.playbackPlaying = report.playing === true && !this.playbackPaused && report.completed !== true;
    if (this.playbackPaused) this.gesture = undefined;
    if (!this.playbackPlaying) this.segment = undefined;
  }

  spoken(progress: Progress): void {
    if (!this.sessionId || progress.generationId < this.generationFloor ||
        progress.generationId !== this.playbackGeneration || !this.playbackPlaying || this.playbackPaused) return;
    if (progress.completed) {
      if (this.segment?.segmentId === progress.segmentId) this.segment = undefined;
    } else {
      this.segment = progress;
      const pending = this.pendingGesture;
      if (pending?.attemptId === progress.attemptId && pending?.generationId === progress.generationId) {
        this.pendingGesture = undefined;
        this.gesture = { ...pending.gesture, startedAt: Date.now() };
      }
    }
  }

  mouth(frame: MouthFrame): boolean {
    const current = this.segment;
    if (!current || this.error || this.modelState === 'cancelling' || !this.playbackPlaying || this.playbackPaused ||
        frame.sessionId !== this.sessionId || frame.generationId !== current.generationId ||
        frame.attemptId !== current.attemptId || frame.segmentId !== current.segmentId ||
        !Number.isSafeInteger(frame.frame) || frame.frame <= this.lastMouthFrame ||
        !Number.isFinite(frame.sampleRate) || frame.sampleRate < 8000 || frame.sampleRate > 192000 ||
        !Number.isFinite(frame.open) || frame.open < 0 || frame.open > 1 ||
        !Number.isFinite(frame.shape) || Math.abs(frame.shape) > 1) return false;
    this.lastMouthFrame = frame.frame;
    return true;
  }

  fail(): void {
    if (!this.sessionId) return;
    this.error = true;
    this.segment = undefined;
    this.playbackPlaying = false;
    this.clearGestures();
  }

  clearError(): void { this.error = false; if (this.modelState === 'error') this.modelState = 'idle'; }

  snapshot(preferences: PetPreferences): PetSnapshot {
    let state: PetState = this.error ? 'error' : 'off';
    if (this.sessionId) {
      if (this.error || this.modelState === 'error') state = 'error';
      else if (this.playbackPaused || this.modelState === 'cancelling') state = 'paused';
      else if (this.playbackPlaying && this.segment) state = 'speaking';
      else if (this.modelState === 'waiting') state = 'waiting';
      else if (this.modelState === 'silent') state = 'silent';
      else if (this.modelState === 'generating') state = 'thinking';
      else if (['SETTLING', 'TRANSCRIBING', 'ACCUMULATING'].includes(this.inputState)) state = 'recognizing';
      else if (this.captureArmed) state = 'listening';
    }
    return {
      variant: preferences.variant, size: preferences.size, visible: preferences.visible,
      alwaysOnTop: preferences.alwaysOnTop, motionMode: preferences.motionMode, state,
      subtitle: state === 'speaking' ? this.segment!.text.slice(0, 160) : '',
      attemptId: this.segment?.attemptId, segmentId: this.segment?.segmentId,
      gesture: this.gesture,
      sessionId: this.sessionId, generationId: Math.max(this.generationFloor, this.playbackGeneration),
    };
  }
}
