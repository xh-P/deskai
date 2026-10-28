import type { DialogueEvent } from '../../../../packages/voice-core/src/dialogue.ts'

export type PersonaId = 'nagato-normal-light' | 'assistant-neutral'
export type ReplyLanguage = 'auto' | 'zh' | 'ja' | 'en'
export interface Preferences { personaId: PersonaId; replyLanguage: ReplyLanguage; voiceId: string }

export interface RuntimeInfo {
  smoke: boolean
  dialogueSmoke: boolean
  fakeMedia: boolean
  versions: Record<string, string>
  preferences: Preferences
  personas: { id: PersonaId; displayName: string; revision: number }[]
}

export interface VoiceCatalogEntry {
  voiceId: string
  name: string
}

export interface SessionStart {
  sessionId: string
  catalog: VoiceCatalogEntry[]
  status: string
}

export interface CaptureFrame {
  sessionId: string
  /** Mono, 16 kHz, post-AEC PCM produced by Silero VAD's resampler. */
  samples: Float32Array
  probability: number
}

export interface PlaybackReport {
  sessionId: string
  generationId: number
  playing: boolean
  paused: boolean
  completed?: boolean
  /** Estimated samples rendered by AudioWorklet, never a claim of audibility. */
  renderedSamples?: number
  sampleRate?: number
}

export type DeskaiEvent =
  | { type: 'dialogue'; sessionId: string; event: DialogueEvent }
  | { type: 'session-ended'; sessionId: string; reason: string }
  | { type: 'status'; sessionId?: string; status: string; detail?: string }
  | { type: 'transcript'; sessionId: string; text: string; utteranceId?: number }
  | { type: 'input-state'; sessionId: string; state: string }
  | { type: 'ready-text'; sessionId: string; text: string; eligible?: boolean }
  | { type: 'error'; sessionId?: string; code: string; message: string }
  | { type: 'output-command'; sessionId: string; command: 'pause' | 'resume' | 'clear'; generationId: number }
  | { type: 'audio-chunk'; sessionId: string; generationId: number; samples: Float32Array; sampleRate: number; final?: boolean }

export interface SmokeReport {
  simulated: true
  vadInitialized: boolean
  asrTranscriptSeen: boolean
  transcriptRendered?: boolean
  inputDuringPlayback: boolean
  completedSessions: number
  notes: string[]
}

export interface DialogueSmokeReport {
  simulated: true
  checks: {
    headerHidden: boolean
    waitSilentNoBubble: boolean
    textQuestionDisplayed: boolean
    shortAnswerWorked: boolean
    retryWorked: boolean
    cancelWorked: boolean
    preferencesIndependent: boolean
    noMicrophoneOpened: boolean
    [key: string]: boolean
  }
  notes: string[]
}

export interface DeskaiBridge {
  getRuntime(): Promise<RuntimeInfo>
  openConversation(): Promise<SessionStart>
  startSession(): Promise<SessionStart>
  stopSession(): Promise<void>
  sendText(input: { sessionId: string; text: string }): Promise<{ accepted: boolean }>
  updatePreferences(input: { personaId: PersonaId; replyLanguage: ReplyLanguage }): Promise<Preferences>
  cancelTurn(): Promise<void>
  retryTurn(): Promise<{ accepted: boolean }>
  acknowledgeDisplay(input: { sessionId: string; attemptId: string; characters: number }): void
  sendFrame(frame: CaptureFrame): void
  onEvent(listener: (event: DeskaiEvent) => void): () => void
  playbackState(report: PlaybackReport): void
  loadPlaybackFixture(): Promise<Uint8Array>
  finishSmoke(report: SmokeReport): void
  finishDialogueSmoke(report: DialogueSmokeReport): void
}

declare global {
  interface Window {
    deskai: DeskaiBridge
  }
}
