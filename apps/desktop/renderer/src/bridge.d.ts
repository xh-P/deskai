import type { DialogueEvent } from '../../../../packages/voice-core/src/dialogue.ts'
import type { VoiceDiagnostics } from '../../../../packages/voice-core/src/diagnostics.ts'
import type { PetGeometry, PetPreferencePatch, PetSnapshot } from '../../../../packages/desktop-pet/src/types.ts'
import type { AecMode } from '../../../../packages/voice-core/src/aec-mode.ts'

import type { ChatPersonaId, RelationshipMode } from '../../../../packages/voice-core/src/persona-catalog.ts'
export type PersonaId = ChatPersonaId
export type ReplyLanguage = 'auto' | 'zh' | 'ja' | 'en'
export type WorkStatus = { state: 'stopped' | 'starting' | 'ready' | 'error'; code?: string }
export interface Preferences { personaId: PersonaId; relationshipMode: RelationshipMode; replyLanguage: ReplyLanguage; voiceId: string; referenceId: string;
  inputDeviceId: string; outputDeviceId: string; volume: number; speed: number; closeToTray: boolean; wakePhrases: string[] | null;
  aecMode: AecMode | null }

export interface RuntimeInfo {
  smoke: boolean
  dialogueSmoke: boolean
  ttsSmoke?: boolean
  fakeMedia: boolean
  aecMode: NonNullable<Preferences['aecMode']>
  defaultWakePhrases: string[]
  versions: Record<string, string>
  preferences: Preferences
  personas: { id: PersonaId; displayName: string; revision: number }[]
  speechStatus: { status: string; detail?: string }
  assetStatus: { ready: boolean; missing: string[] }
  voices?: { id: string; name: string; defaultReferenceId: string; references: { id: string; name: string }[] }[]
  ttsStatus?: { state: string; code?: string }
  voiceDiagnostics?: VoiceDiagnostics
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
  /** Session-local sample position; a gap must fail instead of deleting audio. */
  sampleStart: number
  /** Mono, 16 kHz, processed by the configured AEC path and Silero's resampler. */
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
  turnId?: string
  attemptId?: string
  voiceRevision?: number
  segmentId?: string
  chunkSeq?: number
  segmentCompleted?: boolean
  chunkAccepted?: boolean
  queuedSeconds?: number
  errorCode?: string
}

export type DeskaiEvent =
  | { type: 'dialogue'; sessionId: string; event: DialogueEvent }
  | { type: 'session-ended'; sessionId: string; reason: string }
  | { type: 'status'; sessionId?: string; status: string; detail?: string }
  | { type: 'transcript'; sessionId: string; text: string; utteranceId?: number }
  | { type: 'input-state'; sessionId: string; state: string }
  | { type: 'ready-text'; sessionId: string; text: string; eligible?: boolean }
  | { type: 'error'; sessionId?: string; code: string; message: string }
  | { type: 'capture-command'; command: 'pause' | 'resume' }
  | { type: 'tts-status'; status: { state: string; code?: string; voiceId?: string } }
  | { type: 'speech-state'; sessionId: string; state: string; code?: string }
  | { type: 'output-command'; sessionId: string; command: 'pause' | 'resume' | 'clear'; generationId: number }
  | { type: 'audio-chunk'; sessionId: string; generationId: number; samples: Float32Array; sampleRate: number; final?: boolean;
      turnId?: string; attemptId?: string; voiceRevision?: number; segmentId?: string; chunkSeq?: number; segmentFinal?: boolean }

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
    directTextDisplayed: boolean
    localQuietNoBubble: boolean
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
  openWork(): Promise<WorkStatus>
  getWorkStatus(): Promise<WorkStatus>
  onWorkStatus(listener: (status: WorkStatus) => void): () => void
  getRuntime(): Promise<RuntimeInfo>
  getPetSnapshot(): Promise<PetSnapshot>
  updatePetPreferences(input: PetPreferencePatch): Promise<PetSnapshot>
  onPetSnapshot(listener: (snapshot: PetSnapshot) => void): () => void
  openConversation(): Promise<SessionStart>
  startSession(): Promise<SessionStart>
  stopSession(): Promise<void>
  pauseCapture(): Promise<void>
  retrySpeech(): Promise<void>
  sendText(input: { sessionId: string; text: string }): Promise<{ accepted: boolean }>
  updatePreferences(input: Partial<Preferences>): Promise<Preferences>
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
    deskPet: {
      getSnapshot(): Promise<PetSnapshot>
      onSnapshot(listener: (snapshot: PetSnapshot) => void): () => void
      setOpaqueHit(opaque: boolean): void
      drag(phase: 'start' | 'move' | 'end', pointerId: number): void
      showContextMenu(): void
      reportGeometry(geometry: PetGeometry): void
    }
  }
}
