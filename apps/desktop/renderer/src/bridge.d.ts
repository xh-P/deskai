import type { DialogueEvent, DialogueHistoryEntry } from '../../../../packages/voice-core/src/dialogue.ts'
import type { Persona } from '../../../../packages/voice-core/src/prompts.ts'
import type { CharacterDraft, CharacterSummary, ConversationSummary } from '../../src/character-store.ts'
import type { ReferenceClarification, ReferenceSelection } from '../../../../packages/voice-core/src/coordination.ts'
import type { HostSnapshot } from '../../../host/src/protocol.ts'
import type { ExportReceipt } from '../../../../packages/app-core/src/exports.ts'
import type { AppStateVersion } from '../../../../packages/app-core/src/app-host.ts'
import type { EngagementMode } from '../../../../packages/app-core/src/auip-contract.ts'
import type { WorkUiCommand } from '../../../../packages/work-core/src/types.ts'
import type { WorkTracePage, WorkTraceUpdate } from '../../../../packages/work-core/src/telemetry.ts'
import type { VoiceDiagnostics } from '../../../../packages/voice-core/src/diagnostics.ts'
import type { PetGeometry, PetPreferencePatch, PetSnapshot } from '../../../../packages/desktop-pet/src/types.ts'
import type { Live2DApply, Live2DCatalog, MouthFrame } from '../../../../packages/desktop-pet/src/live2d.ts'
import type { AecMode } from '../../../../packages/voice-core/src/aec-mode.ts'
import type { EndpointConfig, InterruptionConfig } from '../../../../packages/voice-core/src/input-config.ts'

import type { ChatPersonaId, RelationshipMode } from '../../../../packages/voice-core/src/persona-catalog.ts'
export type PersonaId = ChatPersonaId
export type ReplyLanguage = 'auto' | 'zh' | 'ja' | 'en'
export type WorkStatus = { state: 'stopped' | 'starting' | 'ready' | 'error'; code?: string }
export interface Preferences { personaId: PersonaId; relationshipMode: RelationshipMode; replyLanguage: ReplyLanguage; voiceId: string; referenceId: string;
  inputDeviceId: string; outputDeviceId: string; volume: number; speed: number; closeToTray: boolean; wakePhrases: string[] | null;
  aecMode: AecMode | null; characterKnowledge: boolean }

export interface RuntimeInfo {
  smoke: boolean
  dialogueSmoke: boolean
  ttsSmoke?: boolean
  fakeMedia: boolean
  aecMode: NonNullable<Preferences['aecMode']>
  endpoint: EndpointConfig
  interruption: InterruptionConfig
  defaultWakePhrases: string[]
  versions: Record<string, string>
  preferences: Preferences
  personas: CharacterSummary[]
  speechStatus: { status: string; detail?: string }
  assetStatus: { ready: boolean; missing: string[] }
  voices?: { id: string; name: string; defaultReferenceId: string; references: { id: string; name: string }[] }[]
  ttsStatus?: { state: string; code?: string }
  voiceDiagnostics?: VoiceDiagnostics
}

export interface SessionStart {
  sessionId: string
  conversation: ConversationSummary
  history: DialogueHistoryEntry[]
  status: string
}

export interface CaptureFrame {
  sessionId: string
  /** Session-local sample position; a gap must fail instead of deleting audio. */
  sampleStart: number
  /** Mono, 16 kHz, admitted by the capture and echo guard pipeline. */
  samples: Float32Array
  probability: number
  interruptGeneration?: number
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
  segmentStarted?: boolean
  chunkAccepted?: boolean
  queuedSeconds?: number
  errorCode?: string
}

export type DeskaiEvent =
  | { type: 'host-notice'; text: string }
  | { type: 'coordination-state'; state: 'planning' | 'idle' }
  | { type: 'dialogue'; sessionId: string; event: DialogueEvent }
  | { type: 'conversation-changed'; sessionId: string; conversation: ConversationSummary }
  | { type: 'reference-card'; sessionId: string; card: ReferenceClarification }
  | { type: 'reference-closed'; sessionId: string; clarificationId: string }
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
    hostPanelsReady: boolean
    [key: string]: boolean
  }
  notes: string[]
}

export interface DeskaiBridge {
  getHostSnapshot(): Promise<HostSnapshot>
  onHostSnapshot(listener: (snapshot: HostSnapshot) => void): () => void
  selectHost(selection: { projectId?: string; taskId?: string; appSessionId?: string }): Promise<void>
  workCommand(command: WorkUiCommand): Promise<unknown>
  workTracePage(taskId: string, before: string): Promise<WorkTracePage>
  watchWorkTrace(taskId: string, callback: (update: WorkTraceUpdate) => void): () => void
  openArtifact(id: string, interact: boolean): Promise<unknown>
  exportArtifact(id: string): Promise<ExportReceipt | null>
  workDiff(attemptId: string): Promise<string>
  appAction(input: { sessionId: string; action: string; payload: unknown; expected: AppStateVersion }): Promise<unknown>
  setAppMode(id: string, mode: EngagementMode): Promise<unknown>
  closeApp(id: string): Promise<void>
  openWork(): Promise<WorkStatus>
  getRuntime(): Promise<RuntimeInfo>
  getPetSnapshot(): Promise<PetSnapshot>
  updatePetPreferences(input: PetPreferencePatch): Promise<PetSnapshot>
  onPetSnapshot(listener: (snapshot: PetSnapshot) => void): () => void
  openConversation(id?: string): Promise<SessionStart>
  listConversations(): Promise<ConversationSummary[]>
  getCharacter(id: string): Promise<Persona>
  saveCharacter(draft: CharacterDraft): Promise<Persona>
  startSession(): Promise<SessionStart>
  stopSession(): Promise<void>
  pauseCapture(): Promise<void>
  retrySpeech(): Promise<void>
  sendText(input: { sessionId: string; text: string; turnId?: string }): Promise<{ accepted: boolean }>
  selectReference(selection: ReferenceSelection): Promise<unknown>
  dismissReference(id: string): Promise<void>
  updatePreferences(input: Partial<Preferences>): Promise<Preferences>
  cancelTurn(): Promise<void>
  retryTurn(): Promise<{ accepted: boolean }>
  acknowledgeDisplay(input: { sessionId: string; attemptId: string; characters: number }): void
  sendFrame(frame: CaptureFrame): void
  onEvent(listener: (event: DeskaiEvent) => void): () => void
  playbackState(report: PlaybackReport): void
  mouthFrame(frame: MouthFrame): void
  getLive2DCatalog(): Promise<Live2DCatalog>
  importLive2D(): Promise<{ catalog: Live2DCatalog; id: string } | null>
  applyLive2D(input: Live2DApply): Promise<Live2DCatalog>
  loadPlaybackFixture(): Promise<{ generationId: number; wav: Uint8Array }>
  finishSmoke(report: SmokeReport): void
  finishDialogueSmoke(report: DialogueSmokeReport): void
}

declare global {
  interface Window {
    deskai: DeskaiBridge
    deskPet: {
      getSnapshot(): Promise<PetSnapshot>
      onSnapshot(listener: (snapshot: PetSnapshot) => void): () => void
      onMouth(listener: (frame: MouthFrame) => void): () => void
      setOpaqueHit(opaque: boolean): void
      drag(phase: 'start' | 'move' | 'end', pointerId: number): void
      showContextMenu(): void
      reportGeometry(geometry: PetGeometry): void
    }
  }
}
