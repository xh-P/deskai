import { app, BrowserWindow, dialog, ipcMain, protocol, session, screen, Tray, Menu, nativeImage, powerMonitor } from 'electron';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { LocalDshSpeech, type SpeechStatus } from '../../../packages/dsh-adapter/src/speech.ts';
import { createChatRuntime } from './chat-runtime.ts';
import { createInputController, encodePcm16Wav, type InputController, type InputDiagnostic } from '../../../packages/voice-core/src/index.ts';
import { VAD_FRAME_SAMPLES } from '../../../packages/voice-core/src/input-config.ts';
import type { CaptureFrame } from '../renderer/src/bridge.d.ts';
import { DialogueController, type DialogueEvent, type DialoguePreferences } from '../../../packages/voice-core/src/dialogue.ts';
import { validatePersona } from '../../../packages/voice-core/src/prompts.ts';
import { PERSONA_IDS } from '../../../packages/voice-core/src/persona-catalog.ts';
import { FixtureChatPort } from './fixture-chat.ts';
import { LocalTtsService, type TtsStatus, type VoiceSelection } from '../../../packages/tts-adapter/src/index.ts';
import { SpeechOutput, type SpeechPlaybackReport } from './speech-output.ts';
import { OutputTimeline } from '../../../packages/voice-core/src/diagnostics.ts';
import { defaultPreferences, loadPreferences, savePreferences, mergePreferences, inspectAssets, type DesktopPreferences } from './settings.ts';
import { PetActivity } from '../../../packages/desktop-pet/src/projection.ts';
import { PET_VARIANTS, type PetGeometry, type PetSnapshot } from '../../../packages/desktop-pet/src/types.ts';
import { PetWindowManager, petPage } from './pet-window.ts';
import { loadInputRuntimeConfig, SpeechRuntime } from './speech-runtime.ts';
import { WakeGate } from './wake-gate.ts';
import { WorkWindow } from './work-window.ts';
import { HostClient } from '../../host/src/client.ts';
import { dialogueContext, planningContext } from '../../host/src/context.ts';
import { hostDirectory } from '../../host/src/state-directory.ts';
import type { HostSelection, HostSnapshot } from '../../host/src/protocol.ts';
import type { ExportReceipt } from '../../../packages/app-core/src/exports.ts';
import { connectHost } from './host-connection.ts';
import { WorkPlanner } from './work-planner.ts';
import { ArtifactWindows } from './artifact-window.ts';
import type { DialogueInput } from '../../../packages/voice-core/src/dialogue.ts';
import type { WorkUiCommand } from '../../../packages/work-core/src/types.ts';
import { completionLabel, type CompletionAssessment } from '../../../packages/work-core/src/completion.ts';
import type { AppStateVersion } from '../../../packages/app-core/src/index.ts';
import type { EngagementMode } from '../../../packages/app-core/src/auip-contract.ts';

const root = path.resolve(process.env.DESKAI_PROJECT_ROOT ?? process.cwd());
const assetRoot = path.resolve(process.env.DESKAI_ASSET_ROOT ?? root);
process.env.DESKAI_ASSET_ROOT = assetRoot;
app.setName('DeskAI2');
const rendererRoot = path.join(root, '.cache/desktop-renderer');
const page = 'deskai://app/index.html';
const petSmoke = process.argv.includes('--pet-smoke');
const smokeMode = process.argv.includes('--smoke') || petSmoke;
const shellSmoke = process.argv.includes('--shell-smoke');
const dialogueSmoke = smokeMode && process.argv.includes('--dialogue-smoke');
const ttsSmoke = smokeMode && process.argv.includes('--tts-smoke');
const realModelSmoke = ttsSmoke && process.argv.includes('--real-model');
const fakeMedia = process.argv.includes('--use-fake-device-for-media-stream');
const hasInstanceLock = smokeMode || app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
if (smokeMode && !petSmoke && (!fakeMedia || !process.argv.includes('--use-fake-ui-for-media-stream'))) {
  throw new Error('Smoke mode requires explicit fake media and permission switches');
}
protocol.registerSchemesAsPrivileged([{ scheme: 'deskai', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true
} }]);
if (smokeMode) app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let window: BrowserWindow | undefined;
const workWindow = new WorkWindow();
const ownedSmokeHost = smokeMode && !process.env.DESKAI_HOST_DIR;
let desktopHost: HostClient | undefined;
let hostPreparing: Promise<HostClient> | undefined;
let stopHostWatch: (() => void) | undefined;
let planner: WorkPlanner | undefined;
let planning = false;
let planningRevision = 0;
const artifactWindows = new ArtifactWindows();
const pendingNotices: string[] = [];
let speech: LocalDshSpeech | undefined;
let controller: InputController | undefined;
let sessionId = '';
let captureArmed = false;
let sessionEpoch = 0;
let shutdown = false;
let smokeCompleted = false;
let preparingService: LocalDshSpeech | undefined;
let dialogue: DialogueController | undefined;
let fixturePort: FixtureChatPort | undefined;
let opening: Promise<void> | undefined;
let outputPaused = false;
let voiceSubmitting = false;
let preferences: DesktopPreferences = { ...defaultPreferences };
let personas: { id: string; displayName: string; revision: number }[] = [];
let tray: Tray | undefined;
let petWindow: PetWindowManager | undefined;
const petActivity = new PetActivity();
let lastSpeechStatus: { status: string; detail?: string } = { status: '尚未准备语音识别' };
let assetStatus: { ready: boolean; missing: string[] } = { ready: false, missing: [] };
let preferenceWrite: Promise<unknown> = Promise.resolve();
let tts: LocalTtsService | undefined;
let ttsPreparing: Promise<void> | undefined;
let recoveringTts: Promise<void> | undefined;
let ttsStatus: TtsStatus = { state: 'stopped' };
let voiceSelection: VoiceSelection = { voiceId: 'nagato-normal-v2', referenceId: 'ref-01', voiceRevision: 0 };
let voiceOutput: SpeechOutput | undefined;
let outputBusy = false;
const ttsMetrics = { pcmChunks: 0, playedSegments: 0, firstPCMAt: 0, voiceFailures: 0 };
const metrics = { inputFrames: 0, inputSamples: 0, inputFramesDuringPlayback: 0, segments: 0,
  asrCompleted: 0, asrSeconds: [] as number[], readyTurns: 0, fixtureTranscriptPrefixMatched: null as boolean | null, sessionStarts: 0,
  firstSegment: null as { startSample: number; endSample: number; final: boolean } | null,
  inputTimeline: [] as InputDiagnostic[] };
let outputActive = false;
const inputRuntimeConfig = await loadInputRuntimeConfig(root);
const continuationWindowMs = inputRuntimeConfig.endpoint.continuationWindowMs;
const effectiveWakePhrases = () => preferences.wakePhrases ?? inputRuntimeConfig.wake.phrases;
const wakeGate = new WakeGate(effectiveWakePhrases(), inputRuntimeConfig.wake.idleTimeoutMs);
const inputRoutes = new Map<number, ReturnType<WakeGate['snapshot']>>();
let speechRuntime: SpeechRuntime | undefined;
let listeningMode = '';
function refreshListeningMode(force = false) {
  if (!captureArmed || smokeMode) return;
  const mode = wakeGate.snapshot(performance.now()).mode;
  if (mode === listeningMode && !force) return;
  listeningMode = mode;
  if (mode === 'wake') speechRuntime?.standby();
  send({ type: 'status', status: mode === 'wake'
    ? '等待唤醒：' + effectiveWakePhrases().join(' / ')
    : '连续对话中；空闲后自动回到唤醒待机' });
}
const outputTimeline = new OutputTimeline();

function send(event: object) { if (window && !window.isDestroyed()) window.webContents.send('deskai:event', event); }
function syncPet() { if (petWindow) petWindow.setActivity(petActivity.snapshot(petWindow.getPreferences())); }
function showMainWindow() { window?.show(); window?.focus(); }
function stopCurrentReply() {
  if (!sessionId || !(planning || dialogue?.isGenerating || outputBusy || outputActive || outputPaused)) return;
  planningRevision++;
  void planner?.cancel().catch(() => {});
  void dialogue?.cancelOutput().catch(() => {});
}
function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(captureArmed ? 'DeskAI · 正在监听麦克风' : 'DeskAI · 麦克风关闭');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: captureArmed ? '● 正在监听' : '麦克风关闭', enabled: false },
    { label: '打开主窗口', click: showMainWindow },
    { label: '桌宠', submenu: petWindow?.menuTemplate() ?? [{ label: '正在准备桌宠', enabled: false }] },
    { label: captureArmed ? '暂停麦克风' : '恢复麦克风', click: () => {
      window?.show(); window?.focus(); send({ type: 'capture-command', command: captureArmed ? 'pause' : 'resume' });
    } },
    { type: 'separator' }, { label: '退出桌面客户端', click: () => app.quit() },
  ]));
}
function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  if (event.sender !== window?.webContents || event.senderFrame?.url !== page) throw new Error('UNTRUSTED_RENDERER');
}
function refreshOutput() {
  controller?.setOutput({ playing: outputActive, expectsReply: dialogue?.expectsReply() ?? false });
}
function updateTtsStatus(update: TtsStatus) {
  ttsStatus = update;
  if (update.state === 'error') { petActivity.fail(); syncPet(); }
  send({ type: 'tts-status', status: update });
}
async function prepareTts(): Promise<void> {
  if (dialogueSmoke || smokeMode && !process.argv.includes('--tts-smoke')) return;
  if (ttsPreparing) return ttsPreparing;
  if (tts?.getStatus().state === 'ready') return;
  const service = tts ??= new LocalTtsService(root, updateTtsStatus);
  const work = (async () => {
    await service.start();
    const catalog = service.registry();
    const selected = catalog.find(row => row.id === preferences.voiceId) ?? catalog.find(row => row.id === 'nagato-normal-v2');
    if (!selected) throw new Error('VOICE_RESOURCE_NOT_FOUND');
    const referenceId = selected.references.some(row => row.id === preferences.referenceId) ? preferences.referenceId : selected.defaultReferenceId;
    voiceSelection = await service.selectVoice(selected.id, referenceId);
    preferences = { ...preferences, voiceId: voiceSelection.voiceId, referenceId: voiceSelection.referenceId };
    voiceOutput?.setSelection({ ...voiceSelection, language: preferences.replyLanguage, speed: preferences.speed });
  })();
  ttsPreparing = work;
  try { await work; }
  catch (error) {
    updateTtsStatus({ state: 'error', code: error instanceof Error ? error.message : 'TTS_START_FAILED' });
    if (tts === service) tts = undefined;
    await service.dispose();
    throw error;
  } finally { if (ttsPreparing === work) ttsPreparing = undefined; }
}
function attachOutput() {
  const activeDialogue = dialogue;
  if (!tts || !activeDialogue || ttsStatus.state !== 'ready') return;
  const activeTts = tts;
  voiceOutput = new SpeechOutput({ sessionId, port: {
    synthesize: async (request, onPCM, signal) => {
      const started = performance.now();
      const identity = { sessionId: request.sessionId, turnId: request.turnId, segmentId: request.segmentId, generationId: request.generationId };
      const current = () => sessionId === request.sessionId;
      if (current()) outputTimeline.record('tts-started', identity);
      try {
        const result = await activeTts.synthesize(request, pcm => {
          if (current()) outputTimeline.record('tts-first-pcm', { ...identity, durationMs: performance.now() - started }, true);
          onPCM(pcm);
        }, signal);
        if (current()) outputTimeline.record('tts-finished', { ...identity, durationMs: performance.now() - started });
        return result;
      } catch (error) {
        if (current()) outputTimeline.record('tts-failed', { ...identity, durationMs: performance.now() - started });
        throw error;
      }
    },
  },
    emit: event => {
      if (event.sessionId !== sessionId) { send(event); return; }
      if (event.type === 'audio-chunk') {
        ttsMetrics.pcmChunks++; ttsMetrics.firstPCMAt ||= performance.now();
        if (event.sessionId === sessionId) outputTimeline.record('playback-enqueued', event, true);
      }
      if (event.type === 'speech-state') { outputBusy = !['idle', 'error'].includes(event.state); refreshOutput(); }
      if (event.type === 'output-command') { petActivity.output(event.command, event.generationId); syncPet(); }
      if (event.type === 'speech-state' && event.state === 'error') { petActivity.fail(); syncPet(); }
      send(event);
    },
    onSegment: progress => {
      if (dialogue !== activeDialogue || !sessionId) return;
      activeDialogue.recordPlayback(progress); refreshOutput();
      petActivity.spoken(progress); syncPet();
      if (progress.completed) ttsMetrics.playedSegments++;
      if (ttsSmoke) maybeFinishTtsSmoke();
    },
    onFinalSegment: (attemptId, segmentId) => { activeDialogue.finalSegment(attemptId, segmentId); refreshOutput(); },
    onError: (_code, attemptId) => { ttsMetrics.voiceFailures++; if (attemptId) activeDialogue.speechFallback(attemptId); },
  });
  voiceOutput.setSelection({ ...voiceSelection, language: preferences.replyLanguage, speed: preferences.speed });
}
function dialogueEvent(event: DialogueEvent) {
  if (!sessionId) return;
  if (event.type === 'model-state' && event.state === 'generating') {
    outputTimeline.record('model-started', { sessionId, generationId: dialogue?.generationId });
  } else if (event.type === 'assistant-delta') {
    outputTimeline.record('model-first-text', { ...event, sessionId }, true);
  } else if (event.type === 'decision') {
    outputTimeline.record('model-decision', { ...event, sessionId });
  }
  if (event.type === 'output-clear') {
    outputTimeline.record('output-cleared', { sessionId, generationId: event.generationId });
    outputActive = outputPaused = outputBusy = false;
    if (!voiceOutput) send({ type: 'output-command', sessionId, generationId: event.generationId, command: 'clear' });
  }
  voiceOutput?.handle(event);
  if (!voiceOutput && event.type === 'assistant-delta' && event.source === 'voice') dialogue?.speechFallback(event.attemptId);
  petActivity.dialogue(event); syncPet();
  send({ type: 'dialogue', sessionId, event });
  refreshOutput();
  if (event.type === 'model-state' && event.state === 'idle') queueMicrotask(flushHostNotices);
}
function status(update: SpeechStatus) {
  const labels: Record<string, string> = { starting: '正在启动 dsh', preparing: '正在准备 SenseVoice',
    ready: '本地语音识别已就绪', error: '语音服务异常', stopped: '语音服务已停止' };
  const progress = update.totalBytes ? `${Math.round((update.completedBytes ?? 0) / update.totalBytes * 100)}%` : '';
  lastSpeechStatus = { status: labels[update.state], detail: [update.phase ?? update.code, progress].filter(Boolean).join(' · ') };
  send({ type: 'status', ...lastSpeechStatus });
  if (update.state === 'error') { petActivity.fail(); syncPet(); }
  if (update.state === 'error' && sessionId) {
    send({ type: 'session-ended', sessionId, reason: '语音服务已断开，麦克风已停止；可重新开始会话。' });
    const failed = speech;
    speech = undefined;
    void stopSession(true).then(() => failed?.dispose());
  }
}
async function stopSession(retainPetError = false) {
  sessionEpoch++;
  captureArmed = false;
  wakeGate.reset(); inputRoutes.clear(); listeningMode = '';
  petActivity.stopSession(retainPetError); syncPet();
  updateTray();
  controller?.stop();
  planningRevision++;
  await planner?.cancel(); planner = undefined;
  const oldDialogue = dialogue;
  const oldOutput = voiceOutput;
  const oldSpeechRuntime = speechRuntime;
  void oldDialogue?.cancelOutput().catch(() => {});
  speechRuntime = undefined;
  voiceOutput = undefined;
  outputBusy = false;
  dialogue = undefined;
  sessionId = '';
  outputActive = false;
  outputPaused = false;
  if (preparingService) {
    const pending = preparingService;
    preparingService = undefined;
    if (speech === pending) speech = undefined;
    await pending.dispose();
  }
  await oldDialogue?.close().catch(() => {});
  await oldOutput?.close().catch(() => {});
  await oldSpeechRuntime?.dispose();
}

async function getDesktopHost(): Promise<HostClient> {
  if (desktopHost) return desktopHost;
  return hostPreparing ??= (async () => {
    const directory = ownedSmokeHost ? path.join(root, '.cache/host-smoke', randomUUID()) : hostDirectory(app.getPath('userData'));
    const host = new HostClient(directory);
    const initial = await connectHost(host, root);
    desktopHost = host;
    const seen = new Set(initial.work.events.map(event => event.id));
    if (!shutdown) stopHostWatch = host.watch(snapshot => publishHostSnapshot(snapshot, seen));
    return host;
  })().finally(() => { hostPreparing = undefined; });
}
function publishHostSnapshot(snapshot: HostSnapshot, seen: Set<string>) {
  if (window && !window.isDestroyed()) {
    window.webContents.send('deskai:host-snapshot', snapshot);
    window.webContents.send('deskai:work-status', snapshot.runtime);
  }
  for (const event of snapshot.work.events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (!['settled', 'permission', 'question'].includes(event.type)) continue;
    const data = event.data as { outcome?: string; assessment?: CompletionAssessment };
    const label = snapshot.work.tasks.find(task => task.id === event.taskId)?.title ?? '后台任务';
    const state = data.outcome === 'completed' ? `执行已结束，${completionLabel(data.assessment)}` :
      ({ failed: '执行失败', cancelled: '已取消', interrupted: '已中断', unknown: '结果尚不确定' } as Record<string,string>)[data.outcome ?? ''] ?? '有更新';
    const text = event.type === 'settled' ? `${label}，${state}。` : label + '需要你的答复，请查看任务面板。';
    pendingNotices.push(text);
    send({ type: 'host-notice', text });
  }
  flushHostNotices();
}
async function closeHostClient() {
  stopHostWatch?.();
  if (ownedSmokeHost) {
    const host = await (hostPreparing ?? Promise.resolve(desktopHost)).catch(() => undefined);
    await host?.command({ type: 'shutdown' }).catch(() => {});
  }
}
function flushHostNotices() {
  if (shutdown || !dialogue || planning || voiceSubmitting || controller?.hasPendingInput ||
      dialogue.isGenerating || outputActive || outputBusy || outputPaused || !pendingNotices.length) return;
  dialogue.announce(pendingNotices.splice(0).join('\n').slice(0, 1800), captureArmed ? 'voice' : 'text');
}
async function submitCoordinated(input: DialogueInput): Promise<{ accepted: boolean }> {
  const current = dialogue, currentSession = sessionId;
  if (!current || !currentSession) return { accepted: false };
  if (!input.speculation) current.discardSpeculative();
  if (smokeMode && !realModelSmoke || !planner) {
    const host = await getDesktopHost();
    return current.submit({ ...input, hostContext: dialogueContext(await host.snapshot(), { kind: 'chat' }) });
  }
  if (planning) throw new Error('COORDINATOR_BUSY');
  planning = true;
  const revision = ++planningRevision;
  send({ type: 'coordination-state', state: 'planning' });
  let committed = false;
  try {
    const host = await getDesktopHost();
    const snapshot = await host.snapshot();
    if (revision !== planningRevision || current !== dialogue || currentSession !== sessionId) return { accepted: false };
    const decision = await planner.plan(input.text, planningContext(snapshot));
    if (revision !== planningRevision || current !== dialogue || currentSession !== sessionId || input.isEligible?.() === false) return { accepted: false };
    if (realModelSmoke && decision.intent !== 'chat') throw new Error('VOICE_SMOKE_EXPECTED_CHAT');
    if (decision.intent !== 'chat') current.discardSpeculative(input.speculation);
    const app = decision.intent === 'app' ? snapshot.apps.find(item => item.id === decision.sessionId) : undefined;
    const appVersion = app ? { revision: app.revision, generation: app.generation } : undefined;
    const facts = decision.intent === 'chat' ? { kind: 'chat' } : await host.command({ type: 'plan', plan: decision, appVersion });
    committed = decision.intent !== 'chat';
    if (committed) input.onAccepted?.();
    const context = dialogueContext(committed ? await host.snapshot() : snapshot, facts);
    if (revision !== planningRevision || current !== dialogue || currentSession !== sessionId) return { accepted: committed };
    const result = await current.submit({ ...input, ...(committed ? { onAccepted: undefined, isEligible: undefined } : {}), hostContext: context });
    return { accepted: committed || result.accepted };
  } catch (error) {
    if (revision !== planningRevision) return { accepted: committed };
    send({ type: 'error', code: 'COORDINATION_FAILED', message: '任务协调失败：' + (error instanceof Error ? error.message : String(error)) });
    return { accepted: committed };
  } finally {
    if (input.speculation) current.discardSpeculative(input.speculation);
    planning = false; send({ type: 'coordination-state', state: 'idle' }); flushHostNotices();
  }
}
ipcMain.handle('deskai:work-open', async event => { trusted(event); return workWindow.open(await getDesktopHost()); });
ipcMain.handle('deskai:work-status', event => { trusted(event); return desktopHost?.cached()?.runtime ?? { state: 'stopped' }; });
ipcMain.handle('deskai:host-snapshot', async event => { trusted(event); return (await getDesktopHost()).snapshot(); });
ipcMain.handle('deskai:host-select', async (event, selection: HostSelection) => {
  trusted(event); return (await getDesktopHost()).command({ ...selection, type: 'select' });
});
async function executeWorkCommand(command: WorkUiCommand) {
  const host = await getDesktopHost();
  if (command.type !== 'native-open') return host.command({ type: 'work', command });
  const { work } = await host.snapshot();
  const task = work.tasks.find(item => item.id === command.taskId);
  const nativeId = work.attempts.find(attempt => attempt.id === task?.attemptIds.at(-1))?.providerSessionId;
  if (!nativeId) throw new Error('WORK_SESSION_UNAVAILABLE');
  const status = await workWindow.open(host, nativeId);
  if (status.state !== 'ready') throw new Error(status.code ?? 'WORK_SESSION_UI_UNAVAILABLE');
  return status;
}
ipcMain.handle('deskai:work-command', (event, command: WorkUiCommand) => { trusted(event); return executeWorkCommand(command); });
ipcMain.handle('deskai:work-diff', async (event, attemptId: string) => {
  trusted(event); return (await getDesktopHost()).command<string>({ type: 'diff', attemptId });
});
ipcMain.handle('deskai:artifact-open', async (event, id: string, interact: boolean) => {
  trusted(event); return artifactWindows.open(await getDesktopHost(), id, interact === true);
});
ipcMain.handle('deskai:artifact-export', async (event, artifactId: string) => {
  trusted(event); const host = await getDesktopHost();
  const artifact = (await host.snapshot()).artifacts.find(item => item.id === artifactId);
  if (!artifact || !window) throw new Error('ARTIFACT_NOT_AVAILABLE');
  const approval = await dialog.showSaveDialog(window, { title: '导出任务产物', buttonLabel: '确认导出',
    defaultPath: path.join(app.getPath('documents'), path.basename(artifact.relativePath)) });
  if (approval.canceled || !approval.filePath) return null;
  return host.command<ExportReceipt>({ type: 'artifact-export', artifactId, destination: approval.filePath });
});
ipcMain.handle('deskai:app-action', async (event, input: { sessionId: string; action: string; payload: unknown; expected: AppStateVersion }) => {
  trusted(event); return (await getDesktopHost()).command({ ...input, type: 'app-action' });
});
ipcMain.handle('deskai:app-mode', async (event, sessionId: string, mode: EngagementMode) => {
  trusted(event); return (await getDesktopHost()).command({ type: 'app-mode', sessionId, mode });
});
ipcMain.handle('deskai:app-close', async (event, id: string) => { trusted(event); return (await getDesktopHost()).command({ type: 'app-close', sessionId: id }); });

ipcMain.handle('deskai:runtime', event => {
  trusted(event);
  return { smoke: smokeMode, fakeMedia, dialogueSmoke, ttsSmoke, preferences, personas, aecMode: preferences.aecMode ?? inputRuntimeConfig.aec.mode, defaultWakePhrases: inputRuntimeConfig.wake.phrases,
    interruption: inputRuntimeConfig.interruption, endpoint: inputRuntimeConfig.endpoint,
    speechStatus: lastSpeechStatus, assetStatus, ttsStatus, voices: tts?.registry() ?? [],
    voiceDiagnostics: { continuationWindowMs, input: metrics.inputTimeline, output: outputTimeline.snapshot(), asr: speechRuntime?.diagnostics() },
    versions: { electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '' } };
});
ipcMain.handle('deskai:pet-snapshot', event => {
  trusted(event);
  if (!petWindow) throw new Error('PET_NOT_READY');
  return petWindow.getSnapshot();
});
ipcMain.handle('deskai:pet-preferences', (event, value: unknown) => {
  trusted(event);
  if (!petWindow) throw new Error('PET_NOT_READY');
  return petWindow.update(value);
});
ipcMain.handle('pet:get-snapshot', event => {
  if (!petWindow?.owns(event)) throw new Error('UNTRUSTED_PET_RENDERER');
  return petWindow.getSnapshot();
});
ipcMain.on('pet:opaque-hit', (event, opaque: unknown) => {
  if (petWindow?.owns(event) && typeof opaque === 'boolean') petWindow.setOpaqueHit(opaque);
});
ipcMain.on('pet:drag', (event, phase: unknown, pointerId: unknown) => {
  if (petWindow?.owns(event) && (phase === 'start' || phase === 'move' || phase === 'end') &&
      typeof pointerId === 'number' && Number.isSafeInteger(pointerId) && pointerId >= 0) petWindow.drag(phase, pointerId);
});
ipcMain.on('pet:context-menu', event => { if (petWindow?.owns(event)) petWindow.showContextMenu(); });
ipcMain.on('pet:geometry', (event, value: unknown) => {
  if (petWindow?.owns(event)) petWindow.reportGeometry(value as PetGeometry);
});
async function openConversation() {
  if (sessionId) return;
  if (opening) return opening;
  const work = (async () => {
  const epoch = ++sessionEpoch;
  if (dialogueSmoke) {
    sessionId = randomUUID();
    petActivity.startSession(sessionId); syncPet();
    fixturePort = new FixtureChatPort();
    dialogue = new DialogueController(fixturePort, preferences, dialogueEvent);
    return;
  }
  const service = speech ??= new LocalDshSpeech(root, status);
  preparingService = service;
  let catalog;
  try { catalog = await service.start(); }
  catch (error) { if (speech === service) speech = undefined; await service.dispose(); throw error; }
  finally { if (preparingService === service) preparingService = undefined; }
  if (epoch !== sessionEpoch || shutdown) throw new Error('SESSION_START_CANCELLED');
  if (ttsSmoke && !realModelSmoke) fixturePort = new FixtureChatPort();
  const chat = ttsSmoke && !realModelSmoke ? { port: fixturePort!, speculative: undefined } : await createChatRuntime(service, root);
  if (epoch !== sessionEpoch || shutdown) { await chat.port.cancel(); throw new Error('SESSION_START_CANCELLED'); }
  planner = new WorkPlanner(service, root);
  speechRuntime = new SpeechRuntime(service, inputRuntimeConfig.conversation, root);
  sessionId = randomUUID();
  petActivity.startSession(sessionId); syncPet();
  metrics.sessionStarts++;
  metrics.inputTimeline = [];
  outputTimeline.clear();

  dialogue = new DialogueController(chat.port, preferences, dialogueEvent, chat.speculative && {
    ...chat.speculative, diagnostic: event => {
      if (sessionId === event.sessionId) outputTimeline.record(event.type, event);
    },
  });
  attachOutput();
  // Keep this instance across sessions so a canceled ASR task settles before
  // the new session can start another task on the same recognizer.
  controller ??= createInputController({
    ...inputRuntimeConfig.endpoint,
    maxSegmentSeconds: Math.min(20, catalog.maxDurationSeconds, (catalog.maxAudioBytes - 44) / 32000),
    maxQueuedSegments: 4,
    onDiagnostic: event => {
      metrics.inputTimeline.push(event);
      if (metrics.inputTimeline.length > 100) metrics.inputTimeline.shift();
    },
    transcribe: async (segment, signal) => {
      const started = performance.now();
      const route = wakeGate.snapshot(performance.now());
      inputRoutes.set(segment.utteranceId, route);
      const wav = encodePcm16Wav(segment.samples);
      const result = await speechRuntime!.transcribe(smokeMode ? 'conversation' : route.mode, wav, signal);
      if (!signal.aborted && sessionId === segment.sessionId) {
        metrics.asrCompleted++;
        metrics.asrSeconds.push((performance.now() - started) / 1000);
        if (metrics.asrSeconds.length > 100) metrics.asrSeconds.shift();
      }
      return result;
    },
    onSegment: segment => {
      metrics.segments++;
      if (smokeMode && fakeMedia && metrics.firstSegment === null) {
        metrics.firstSegment = { startSample: segment.startSample, endSample: segment.endSample, final: segment.final };
        void mkdir(path.join(root, 'outputs/desktop-validation/m1'), { recursive: true }).then(() =>
          writeFile(path.join(root, 'outputs/desktop-validation/m1/synthetic-first-segment.wav'), encodePcm16Wav(segment.samples)));
      }
    },
    onInputState: state => {
      petActivity.input(state); syncPet(); send({ type: 'input-state', sessionId, state });
      if (state === 'LISTENING') queueMicrotask(flushHostNotices);
    },
    onStop: stopCurrentReply,
    onCandidate: candidate => {
      const host = desktopHost?.cached();
      if (smokeMode && !realModelSmoke || !captureArmed || candidate.sessionId !== sessionId || !host ||
          planning || voiceSubmitting || outputActive || outputBusy || outputPaused) return;
      const route = inputRoutes.get(candidate.utteranceIds[0]);
      const preview = smokeMode ? { accepted: true, text: candidate.text } : route && wakeGate.preview(candidate.text, route, performance.now());
      if (!preview?.accepted) return;
      dialogue?.prepareSpeculative({
        text: preview.text, source: 'voice', continuationOf: candidate.continuationOf, utteranceIds: candidate.utteranceIds,
        hostContext: dialogueContext(host, { kind: 'chat' }), speculation: candidate,
      });
    },
    onCandidateRevoked: candidate => dialogue?.discardSpeculative(candidate),
    onBoundary: event => {
      if (event.type === 'discarded' || event.type === 'overflow') for (const id of event.utteranceIds) inputRoutes.delete(id);
      if (event.type === 'overflow' || event.type === 'discarded' && /ASR|queue/.test(event.reason ?? '')) {
        petActivity.fail(); syncPet();
        send({ type: 'error', sessionId, code: 'ASR_SEGMENT_DISCARDED', message: '识别队列或片段处理失败，本片段已丢弃；可以继续说话。' });
      }
    },
    onError: () => { petActivity.fail(); syncPet(); send({ type: 'error', sessionId, code: 'ASR_FAILED', message: '本次语音识别失败；后续片段可继续识别。' }); },
    onReady: ready => {
      if (sessionId !== ready.sessionId || !controller?.isEligible(ready.inputRevision, ready.utteranceIds)) return;
      metrics.readyTurns++;
      if (smokeMode && metrics.fixtureTranscriptPrefixMatched === null) {
        metrics.fixtureTranscriptPrefixMatched = ready.text.replace(/[\s\p{P}]/gu, '').startsWith('你回来了');
      }
      if (smokeMode && !dialogueSmoke && !ttsSmoke) {
        send({ type: 'transcript', sessionId, text: ready.text });
        send({ type: 'ready-text', sessionId, text: ready.text, eligible: true });
        controller.markSubmitted(ready.utteranceIds);
        return;
      }
      if (voiceSubmitting) return;
      let text = ready.text;
      if (!smokeMode) {
        const route = inputRoutes.get(ready.utteranceIds[0]);
        const admitted = route && wakeGate.accept(text, route, performance.now());
        for (const id of ready.utteranceIds) inputRoutes.delete(id);
        refreshListeningMode();
        if (admitted?.woke) {
          const wakingSession = sessionId;
          send({ type: 'status', status: '已唤醒，正在准备对话识别' });
          void speechRuntime?.prepare().then(() => {
            if (sessionId === wakingSession && wakeGate.snapshot(performance.now()).mode === 'conversation') {
              send({ type: 'status', status: '连续对话中；空闲后自动回到唤醒待机' });
            }
          }).catch(() => {
            if (sessionId === wakingSession) send({ type: 'error', sessionId, code: 'CONVERSATION_ASR_UNAVAILABLE',
              message: '对话识别服务启动失败；文字对话仍可使用，请检查语音运行配置。' });
          });
        }
        if (!admitted?.accepted) { controller.discardReady(ready.utteranceIds); return; }
        text = admitted.text;
      }
      voiceSubmitting = true;
      outputTimeline.record('input-submitted', ready);
      const current = controller;
      void submitCoordinated({ text, source: 'voice', continuationOf: ready.continuationOf,
        speculation: ready,
        utteranceIds: ready.utteranceIds, isEligible: () => sessionId === ready.sessionId && current.isEligible(ready.inputRevision, ready.utteranceIds),
        onAccepted: () => {
          if (sessionId === ready.sessionId) {
            outputTimeline.record('input-accepted', ready);
            try { current.markAccepted(ready.inputRevision, ready.utteranceIds); }
            catch { /* A later failed ASR accumulation may already have removed this prefix. The accepted model turn remains in DialogueController history. */ }
          }
        } }).then(result => {
          if (!result.accepted && sessionId === ready.sessionId && current.isEligible(ready.inputRevision, ready.utteranceIds)) {
            current.discardReady(ready.utteranceIds);
            send({ type: 'transcript', sessionId, text: ready.text + '（本轮未提交）' });
          }
        }).catch(() => {
          if (sessionId === ready.sessionId) {
            current.discardReady(ready.utteranceIds);
            send({ type: 'error', sessionId, code: 'SUBMIT_FAILED', message: '本轮提交失败，可以继续说话或使用文字输入。' });
          }
        }).finally(() => {
          voiceSubmitting = false;
          if (sessionId) current.reevaluateReady();
          flushHostNotices();
        });
    }
  });
  })();
  opening = work;
  try { await work; } finally { if (opening === work) opening = undefined; }
}
function sessionDescription() {
  return { sessionId, catalog: [{ voiceId: 'nagato-normal-v2', name: '常态有希 v2' }],
    status: dialogueSmoke ? '本地模拟模型验证' : captureArmed
      ? (wakeGate.snapshot(performance.now()).mode === 'wake' ? '等待唤醒：' + effectiveWakePhrases().join(' / ') : '连续对话中；空闲后自动回到唤醒待机') : '文字对话已就绪' };
}
ipcMain.handle('deskai:open-conversation', async event => { trusted(event); await openConversation(); return sessionDescription(); });
ipcMain.handle('deskai:start', async event => {
  trusted(event);
  await openConversation();
  const startingSession = sessionId;
  const conversationPreparation = inputRuntimeConfig.conversation.idlePolicy === 'unload' ? undefined : speechRuntime?.prepare().catch(() => {
    if (sessionId === startingSession) send({ type: 'error', sessionId, code: 'CONVERSATION_ASR_UNAVAILABLE',
      message: '对话识别服务启动失败；文字对话仍可使用，请检查语音运行配置。' });
  });
  // A synthesis failure keeps transcription/text available and is visible in the UI.
  if (!smokeMode || ttsSmoke) await prepareTts().then(() => { if (!voiceOutput) attachOutput(); }).catch(() => {
    send({ type: 'error', message: '语音合成服务准备失败，仍可识别和文字对话；点击“恢复语音服务”可重试。', code: 'TTS_UNAVAILABLE' });
  });
  await conversationPreparation;
  if (!startingSession || sessionId !== startingSession || shutdown) throw new Error('SESSION_START_CANCELLED');
  captureArmed = true;
  petActivity.setCaptureArmed(true); syncPet();
  updateTray();
  wakeGate.reset(); inputRoutes.clear(); listeningMode = '';
  controller?.start(sessionId);
  refreshListeningMode();
  refreshOutput();
  return sessionDescription();
});
ipcMain.handle('deskai:stop', async event => { trusted(event); await stopSession(); });
ipcMain.handle('deskai:send-text', async (event, value: unknown) => {
  trusted(event);
  const data = value as { sessionId?: string; text?: string };
  if (!data || data.sessionId !== sessionId || !dialogue || typeof data.text !== 'string' || data.text.length > 4000) throw new Error('INVALID_TEXT_INPUT');
  return submitCoordinated({ text: data.text, source: captureArmed ? 'voice' : 'text' });
});
ipcMain.handle('deskai:cancel-turn', async event => { trusted(event); planningRevision++; await planner?.cancel(); await dialogue?.cancelOutput(); refreshOutput(); });
ipcMain.handle('deskai:retry-turn', async event => { trusted(event); return dialogue?.retry() ?? { accepted: false }; });
ipcMain.on('deskai:displayed', (event, value: unknown) => {
  trusted(event);
  const data = value as { sessionId?: string; attemptId?: string; characters?: number };
  if (data?.sessionId === sessionId && typeof data.attemptId === 'string' && Number.isSafeInteger(data.characters)) {
    dialogue?.displayed(data.attemptId, data.characters!); refreshOutput();
  }
});
ipcMain.handle('deskai:preferences', async (event, value: unknown) => {
  trusted(event);
  const work = preferenceWrite.then(async () => {
    const next = mergePreferences(preferences, value);
    if (next.voiceId !== preferences.voiceId || next.referenceId !== preferences.referenceId) {
      await dialogue?.cancelOutput();
      await prepareTts();
      if (!tts) throw new Error('TTS_NOT_READY');
      const voice = tts.registry().find(row => row.id === next.voiceId);
      if (!voice) throw new Error('INVALID_VOICE');
      voiceSelection = await tts.selectVoice(voice.id, next.referenceId || voice.defaultReferenceId);
      next.referenceId = voiceSelection.referenceId;
    }
    if (next.personaId !== preferences.personaId || next.replyLanguage !== preferences.replyLanguage || next.relationshipMode !== preferences.relationshipMode) await dialogue?.updatePreferences(next);
    const wakeChanged = JSON.stringify(next.wakePhrases) !== JSON.stringify(preferences.wakePhrases);
    if (!smokeMode) await savePreferences(app.getPath('userData'), next);
    preferences = next;
    voiceOutput?.setSelection({ ...voiceSelection, language: next.replyLanguage, speed: next.speed });
    if (wakeChanged) { wakeGate.setPhrases(effectiveWakePhrases()); refreshListeningMode(true); }
    refreshOutput();
    return preferences;
  });
  preferenceWrite = work.catch(() => {});
  return work;
});
ipcMain.handle('deskai:pause-capture', event => {
  trusted(event); captureArmed = false; petActivity.setCaptureArmed(false); syncPet(); controller?.stop(); updateTray();
});
ipcMain.handle('deskai:retry-speech', async event => {
  trusted(event);
  if (recoveringTts) return recoveringTts;
  const work = (async () => {
    await dialogue?.cancelOutput();
    await voiceOutput?.close(); voiceOutput = undefined;
    const pending = ttsPreparing, old = tts; tts = undefined;
    await old?.dispose(); await pending?.catch(() => {});
    await prepareTts(); attachOutput(); petActivity.clearError(); syncPet();
  })();
  recoveringTts = work;
  try { await work; } finally { if (recoveringTts === work) recoveringTts = undefined; }
});
ipcMain.on('deskai:frame', (event, frame: unknown) => {
  try { trusted(event); } catch { return; }
  if (!captureArmed || !controller || !frame || typeof frame !== 'object') return;
  const value = frame as CaptureFrame;
  if (value.sessionId !== sessionId) return;
  try {
    const generationId = value.interruptGeneration;
    if (!(value.samples instanceof Float32Array) || value.samples.length !== VAD_FRAME_SAMPLES ||
        !Number.isSafeInteger(value.sampleStart) || value.sampleStart < 0 ||
        !Number.isFinite(value.probability) || value.probability < 0 || value.probability > 1 ||
        generationId !== undefined && (!Number.isSafeInteger(generationId) || generationId < 0)) throw new Error('INVALID_CAPTURE_FRAME');
    metrics.inputFrames++; metrics.inputSamples += value.samples.length;
    if (outputActive) metrics.inputFramesDuringPlayback++;
    if (outputActive || outputBusy || outputPaused || dialogue?.isGenerating || value.probability >= inputRuntimeConfig.endpoint.vadThreshold) wakeGate.touch(performance.now());
    refreshListeningMode();
    refreshOutput();
    controller.pushFrame({ ...value, duringPlayback: generationId !== undefined });
    if (generationId !== undefined && dialogue?.generationId === generationId) {
      outputTimeline.record('interruption-confirmed', { sessionId, generationId });
      void dialogue.cancelOutput(generationId).catch(() => {});
    }
  } catch {
    captureArmed = false;
    petActivity.setCaptureArmed(false); petActivity.fail(); syncPet();
    controller.stop();
    updateTray();
    send({ type: 'capture-command', command: 'pause' });
    send({ type: 'error', code: 'INVALID_CAPTURE_FRAME', message: '音频采集出现缺帧或格式异常，已暂停麦克风；请重新开始语音对话。' });
  }
});
ipcMain.on('deskai:playback', (event, report: unknown) => {
  trusted(event);
  if (!report || typeof report !== 'object') return;
  const value = report as { sessionId: string; generationId: number; playing: boolean; paused: boolean };
  if (value.sessionId !== sessionId || !Number.isSafeInteger(value.generationId) || value.generationId !== dialogue?.generationId) return;
  outputActive = value.playing === true;
  outputPaused = value.paused === true;
  petActivity.playback(value);
  voiceOutput?.playback(value as SpeechPlaybackReport);
  syncPet();
  refreshOutput();
  flushHostNotices();
});
ipcMain.handle('deskai:playback-fixture', async event => {
  trusted(event);
  if (!dialogue) throw new Error('SESSION_NOT_ACTIVE');
  const generationId = dialogue.generationId;
  const wav = new Uint8Array(await readFile(path.join(assetRoot, 'assets/凉宫春日参考语音包/predef_ref/正常有希/01_有希_平静.wav')));
  return { generationId, wav };
});
ipcMain.on('deskai:finish-smoke', (event, input: unknown) => {
  trusted(event);
  if (!smokeMode || !fakeMedia || smokeCompleted || !input || typeof input !== 'object') return;
  smokeCompleted = true;
  const data = input as Record<string, unknown>;
  const checks = ['vadInitialized', 'asrTranscriptSeen', 'transcriptRendered', 'inputDuringPlayback'];
  const passed = data.simulated === true && checks.every(key => data[key] === true) && metrics.asrCompleted > 0 &&
    metrics.inputFramesDuringPlayback > 0 && data.completedSessions === 2;
  const report = { simulated: true, vadInitialized: data.vadInitialized === true,
    asrTranscriptSeen: data.asrTranscriptSeen === true, inputDuringPlayback: data.inputDuringPlayback === true,
    transcriptRendered: data.transcriptRendered === true,
    completedSessions: data.completedSessions,
    physicalMicrophoneTested: false, physicalSpeakerTested: false, acousticEchoCancellationValidated: false,
    passed, metrics, versions: process.versions, timestamp: new Date().toISOString(),
    notes: Array.isArray(data.notes) ? data.notes.filter(item => typeof item === 'string').map(item => String(item).slice(0, 400)).slice(0, 10) : [] };
  void (async () => {
    const dir = path.join(root, 'outputs/desktop-validation/m1');
    await mkdir(dir, { recursive: true });
    if (window && !window.isDestroyed()) {
      const screenshot = await window.webContents.capturePage();
      await writeFile(path.join(dir, 'desktop-smoke.png'), screenshot.toPNG());
    }
    await writeFile(path.join(dir, `audio-smoke-${Date.now()}.json`), JSON.stringify(report, null, 2));
    await stopSession();
    await speech?.dispose();
    shutdown = true; await closeHostClient();
    app.exit(passed ? 0 : 1);
  })().catch(() => app.exit(1));
});

ipcMain.on('deskai:finish-dialogue-smoke', (event, input: unknown) => {
  trusted(event);
  if (!dialogueSmoke || !fakeMedia || smokeCompleted || !input || typeof input !== 'object') return;
  smokeCompleted = true;
  const data = input as { checks?: Record<string, unknown>; notes?: unknown[]; simulated?: unknown };
  const checks = Object.fromEntries(Object.entries(data.checks ?? {}).filter(([, value]) => typeof value === 'boolean'));
  const required = ['directTextDisplayed', 'localQuietNoBubble', 'textQuestionDisplayed', 'shortAnswerWorked',
    'retryWorked', 'cancelWorked', 'preferencesIndependent', 'roleplaySelectable', 'relationshipSelectable', 'noMicrophoneOpened', 'hostPanelsReady'];
  const report = { simulated: true, provider: 'local-interface-fixture', realModelValidated: false,
    passed: data.simulated === true && required.every(key => checks[key] === true) && metrics.inputFrames === 0 &&
      fixturePort?.requests.length === 5,
    checks, microphoneFrames: metrics.inputFrames, model: dialogue?.stats, requests: fixturePort?.requests,
    physicalDevicesTested: false, notes: (data.notes ?? []).filter(item => typeof item === 'string').slice(0, 10), timestamp: new Date().toISOString() };
  void (async () => {
    const dir = path.join(root, 'outputs/desktop-validation/m2');
    await mkdir(dir, { recursive: true });
    if (window && !window.isDestroyed()) await writeFile(path.join(dir, 'desktop-smoke.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(path.join(dir, `desktop-smoke-${Date.now()}.json`), JSON.stringify(report, null, 2));
    await stopSession(); await speech?.dispose(); shutdown = true; await closeHostClient(); app.exit(report.passed ? 0 : 1);
  })().catch(() => app.exit(1));
});

function maybeFinishTtsSmoke() {
  const attempts = dialogue?.ledger.snapshot();
  if (!ttsSmoke || smokeCompleted || !dialogue || dialogue.isGenerating || ttsMetrics.playedSegments < 1 ||
    !attempts?.length || attempts.some(row => row.unplayed.trim().length > 0)) return;
  smokeCompleted = true;
  const report = { timestamp: new Date().toISOString(), simulatedMicrophone: true, simulatedModel: !realModelSmoke,
    realDshModel: realModelSmoke,
    conversationAsr: inputRuntimeConfig.conversation.provider,
    realSenseVoice: inputRuntimeConfig.conversation.provider === 'dsh', realQwen: inputRuntimeConfig.conversation.provider === 'qwen-local',
    realGpuTts: true, physicalMicrophoneTested: false, physicalSpeakerTested: false, aecValidated: false,
    metrics, tts: ttsMetrics, model: dialogue.stats, ledger: dialogue.ledger.snapshot(),
    asr: speechRuntime?.diagnostics(), outputTimeline: outputTimeline.snapshot(),
    passed: metrics.asrCompleted > 0 && metrics.inputFramesDuringPlayback > 0 && ttsMetrics.pcmChunks > 0 &&
      ttsMetrics.voiceFailures === 0 && dialogue.stats.modelRequests > 0 && dialogue.stats.modelRequests <= metrics.readyTurns };
  void (async () => {
    const directory = path.join(root, 'outputs/desktop-validation/m3');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `desktop-smoke-${Date.now()}.json`), JSON.stringify(report, null, 2));
    if (window && !window.isDestroyed()) await writeFile(path.join(directory, 'desktop-smoke.png'), (await window.webContents.capturePage()).toPNG());
    await stopSession(); await speech?.dispose(); await tts?.dispose(); shutdown = true; await closeHostClient(); app.exit(report.passed ? 0 : 1);
  })().catch(() => app.exit(1));
}

async function waitForPetRender(pet: BrowserWindow, variant: string, state?: string): Promise<{
  variant: string; state: string; width: number; height: number;
}> {
  return pet.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const expectedVariant = ${JSON.stringify(variant)};
    const expectedState = ${JSON.stringify(state ?? null)};
    const finish = () => {
      const root = document.querySelector('.pet-root');
      const canvas = document.querySelector('canvas.pet-body');
      if (!root || root.dataset.variant !== expectedVariant || root.dataset.ready !== 'true' ||
          expectedState && root.dataset.state !== expectedState || !canvas || !canvas.width || !canvas.height) return;
      cleanup(); resolve({ variant: root.dataset.variant, state: root.dataset.state, width: canvas.width, height: canvas.height });
    };
    const observer = new MutationObserver(finish);
    const timeout = setTimeout(() => { cleanup(); reject(new Error('PET_RENDER_TIMEOUT:' + expectedVariant + ':' + expectedState)); }, 15000);
    const cleanup = () => { clearTimeout(timeout); observer.disconnect(); };
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    finish();
  })`);
}

async function waitForPetMotion(pet: BrowserWindow, mode: 'gentle' | 'system'): Promise<{
  systemReduced: boolean; enabled: boolean; animationName: string;
}> {
  return pet.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const mode = ${JSON.stringify(mode)};
    const finish = () => {
      const root = document.querySelector('.pet-root');
      const canvas = document.querySelector('canvas.pet-body');
      const systemReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const enabled = mode === 'gentle' || !systemReduced;
      const animationName = canvas ? getComputedStyle(canvas).animationName : '';
      if (!root || !canvas || root.dataset.ready !== 'true' || root.dataset.motionMode !== mode ||
          root.dataset.motion !== (enabled ? 'on' : 'off') ||
          (animationName !== 'none') !== enabled) return;
      cleanup(); resolve({ systemReduced, enabled, animationName });
    };
    const observer = new MutationObserver(finish);
    const timeout = setTimeout(() => { cleanup(); reject(new Error('PET_MOTION_TIMEOUT:' + mode)); }, 5000);
    const cleanup = () => { clearTimeout(timeout); observer.disconnect(); };
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    finish();
  })`);
}

async function capturePet(pet: BrowserWindow, file: string): Promise<number> {
  await pet.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const image: Electron.NativeImage = await pet.webContents.capturePage();
  await writeFile(file, image.toPNG());
  return image.toBitmap()[3];
}

async function runPetSmoke(rendererErrors: string[]): Promise<boolean> {
  const pet = petWindow?.getWindow();
  const report: { passed: boolean; checks: Record<string, boolean>; variants: object[]; rendererErrors: string[];
    simulatedStates: boolean; realAudioPlaybackTested: boolean; physicalDevicesTested: boolean; error?: string } = {
    passed: false, checks: {}, variants: [], rendererErrors,
    simulatedStates: true, realAudioPlaybackTested: false, physicalDevicesTested: false,
  };
  const directory = path.join(assetRoot, 'outputs/desktop-pet/validation');
  try {
    assert(pet && petWindow, '真实桌宠窗口未创建');
    pet.showInactive();
    assert(pet.isAlwaysOnTop(), '桌宠未置顶');
    assert(pet.isVisible(), '桌宠未显示');
    report.checks.realAppWindow = true;
    await mkdir(directory, { recursive: true });
    let priorCenter: number | undefined;
    for (const variant of PET_VARIANTS) {
      petWindow.update({ variant, size: 360 });
      const rendered = await waitForPetRender(pet, variant, 'off');
      const bounds: Electron.Rectangle = pet.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      assert(bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width &&
        bounds.y + bounds.height <= area.y + area.height, `桌宠越出显示器：${variant}`);
      const center = bounds.x + bounds.width / 2;
      if (priorCenter !== undefined) assert(Math.abs(center - priorCenter) <= 2, `切换造型时脚部水平跳动：${variant}`);
      priorCenter = center;
      const alpha = await capturePet(pet, path.join(directory, `app-pet-${variant}.png`));
      assert.equal(alpha, 0, '透明窗角点应穿透');
      report.variants.push({ ...rendered, bounds, transparentCornerAlpha: alpha });
    }
    report.checks.fourVariants = true;
    petWindow.update({ size: 120 });
    assert.equal(pet.getBounds().height, 208);
    petWindow.update({ size: 360 });
    assert.equal(pet.getBounds().height, 448);
    report.checks.sizeBounds = true;
    petWindow.update({ alwaysOnTop: false });
    assert.equal(pet.isAlwaysOnTop(), false);
    petWindow.update({ alwaysOnTop: true });
    assert.equal(pet.isAlwaysOnTop(), true);
    petWindow.update({ visible: false });
    assert.equal(pet.isVisible(), false);
    petWindow.update({ visible: true });
    assert.equal(pet.isVisible(), true);
    report.checks.windowControls = true;
    petWindow.update({ motionMode: 'gentle' });
    await waitForPetMotion(pet, 'gentle');
    petWindow.update({ motionMode: 'system' });
    await waitForPetMotion(pet, 'system');
    petWindow.update({ motionMode: 'gentle' });
    await waitForPetMotion(pet, 'gentle');
    report.checks.motionPreference = true;
    assert(petWindow.menuTemplate().some(item => item.label === '停止当前回复'));
    report.checks.contextMenu = true;

    petActivity.startSession('pet-smoke-session', true); syncPet();
    await waitForPetRender(pet, 'witch-normal', 'listening');
    petActivity.input('TRANSCRIBING'); syncPet();
    await waitForPetRender(pet, 'witch-normal', 'recognizing');
    petActivity.dialogue({ type: 'model-state', state: 'generating' }); syncPet();
    await waitForPetRender(pet, 'witch-normal', 'thinking');
    petActivity.spoken({ generationId: 1, text: '没有播放回执', completed: false }); syncPet();
    assert.notEqual(petWindow.getSnapshot().state, 'speaking');
    petActivity.playback({ sessionId: 'pet-smoke-session', generationId: 1, playing: true, paused: false });
    petActivity.spoken({ generationId: 1, text: '真实文本的模拟播放回执', completed: false }); syncPet();
    await waitForPetRender(pet, 'witch-normal', 'speaking');
    petActivity.output('pause', 1); syncPet();
    await waitForPetRender(pet, 'witch-normal', 'paused');
    await capturePet(pet, path.join(directory, 'app-pet-paused.png'));
    petActivity.output('clear', 2);
    petActivity.playback({ sessionId: 'pet-smoke-session', generationId: 1, playing: true, paused: false });
    petActivity.spoken({ generationId: 1, text: '已取消旧音频', completed: false }); syncPet();
    assert.notEqual(petWindow.getSnapshot().state, 'speaking');
    petActivity.dialogue({ type: 'model-state', state: 'waiting' }); syncPet();
    await waitForPetRender(pet, 'witch-normal', 'waiting');
    await capturePet(pet, path.join(directory, 'app-pet-waiting.png'));
    assert.equal(petWindow.getSnapshot().subtitle, '');
    petActivity.dialogue({ type: 'model-state', state: 'silent' }); syncPet();
    await waitForPetRender(pet, 'witch-normal', 'silent');
    await capturePet(pet, path.join(directory, 'app-pet-silent.png'));
    assert.equal(petWindow.getSnapshot().subtitle, '');
    petActivity.fail(); syncPet();
    await waitForPetRender(pet, 'witch-normal', 'error');
    await capturePet(pet, path.join(directory, 'app-pet-error.png'));
    petActivity.stopSession(true); syncPet();
    await waitForPetRender(pet, 'witch-normal', 'error');
    assert.equal(petWindow.getSnapshot().sessionId, null);
    report.checks.errorState = true;
    petActivity.startSession('pet-smoke-restarted', true); syncPet();
    await waitForPetRender(pet, 'witch-normal', 'listening');
    petActivity.stopSession(); syncPet();
    await waitForPetRender(pet, 'witch-normal', 'off');
    report.checks.stateProjection = true;
    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('PET_CLOSE_TIMEOUT')), 5000);
      pet.once('closed', () => { clearTimeout(timeout); resolve(); });
    });
    pet.close();
    await closed;
    assert.equal(petWindow.getWindow(), undefined, '关闭桌宠后应释放旧窗口');
    assert.equal(petWindow.getSnapshot().visible, false, '系统关闭桌宠后显示选项应取消');
    petWindow.update({ visible: true });
    let reopened: BrowserWindow | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      reopened = petWindow.getWindow();
      if (reopened && reopened.webContents.getURL() === petPage && !reopened.webContents.isLoading()) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(reopened && reopened !== pet && !reopened.isDestroyed(), '显示桌宠未重新创建窗口');
    await waitForPetRender(reopened, 'witch-normal', 'off');
    assert(reopened.isVisible(), '重建的桌宠未显示');
    report.checks.closeAndReopen = true;
    report.passed = Object.values(report.checks).every(Boolean) && rendererErrors.length === 0;
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'app-pet-smoke.json'), JSON.stringify(report, null, 2));
  return report.passed;
}

app.whenReady().then(async () => {
  if (!hasInstanceLock) return;
  await mkdir(app.getPath('userData'), { recursive: true });
  if (!smokeMode && !shellSmoke) preferences = await loadPreferences(app.getPath('userData'));
  wakeGate.setPhrases(effectiveWakePhrases());
  assetStatus = await inspectAssets(assetRoot);
  personas = await Promise.all(PERSONA_IDS.map(async id => {
    const card = validatePersona(JSON.parse(await readFile(path.join(root, 'config/personas', id + '.json'), 'utf8')));
    return { id: card.id, displayName: card.displayName, revision: card.revision };
  }));
  protocol.handle('deskai', async request => {
    const url = new URL(request.url);
    let relative;
    try { relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'; }
    catch { return new Response(null, { status: 400 }); }
    const file = path.resolve(rendererRoot, relative);
    if (url.hostname !== 'app' || !file.startsWith(rendererRoot + path.sep)) return new Response(null, { status: 403 });
    try {
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
        '.css': 'text/css', '.png': 'image/png', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };
      return new Response(new Uint8Array(await readFile(file)), { headers: {
        'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; img-src 'self' data:; object-src 'none'",
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'
      } });
    } catch { return new Response(null, { status: 404 }); }
  });
  const allowMicrophone = (contents: Electron.WebContents | null, permission: string, mediaTypes?: string[]) =>
    contents === window?.webContents && contents?.getURL() === page && captureArmed && permission === 'media' &&
    (!mediaTypes || mediaTypes.length > 0 && mediaTypes.every(type => type === 'audio'));
  const allowSpeaker = (contents: Electron.WebContents | null, permission: string) =>
    contents === window?.webContents && contents?.getURL() === page && !shutdown && permission === 'speaker-selection';
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(allowSpeaker(contents, permission) || allowMicrophone(contents, permission, 'mediaTypes' in details ? details.mediaTypes : [])));
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    allowSpeaker(contents, permission) || allowMicrophone(contents, permission, details.mediaType === 'audio' ? ['audio'] : details.mediaType === 'video' ? ['video'] : undefined));
  petWindow = new PetWindowManager(app.getPath('userData'), {
    showMain: showMainWindow,
    stopReply: stopCurrentReply,
    changed: (snapshot: PetSnapshot) => {
      if (window && !window.isDestroyed()) window.webContents.send('deskai:pet-snapshot', snapshot);
      updateTray();
    },
  }, !smokeMode);
  await petWindow.start(false);
  screen.on('display-removed', () => petWindow?.ensureVisible());
  screen.on('display-metrics-changed', () => petWindow?.ensureVisible());
  window = new BrowserWindow({ width: 960, height: 760, minWidth: 700, minHeight: 560, show: !smokeMode && !shellSmoke,
    autoHideMenuBar: true, webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, destination) => { if (destination !== page) event.preventDefault(); });
  window.webContents.on('render-process-gone', () => { void stopSession(); });
  window.on('close', event => {
    if (!shutdown && preferences.closeToTray && tray) { event.preventDefault(); window?.hide(); }
    else if (!shutdown) { event.preventDefault(); app.quit(); }
  });
  if (smokeMode) window.webContents.on('console-message', event => {
    // Fixture-only diagnostics: avoid logging renderer content during real conversations.
    const details = event as Electron.Event & { level?: string | number; message?: string };
    if (details.level === 3 || details.level === 'error') console.error('Renderer smoke:', String(details.message ?? '').slice(0, 500));
  });
  await window.loadURL(page);
  if (!smokeMode && !shellSmoke) petWindow.showIfVisible();
  if (petSmoke) {
    const rendererErrors: string[] = [];
    petWindow.getWindow()?.webContents.on('console-message', event => {
      const details = event as Electron.Event & { level?: string | number; message?: string };
      if (details.level === 3 || details.level === 'error') rendererErrors.push(String(details.message ?? '').slice(0, 400));
    });
    const passed = await runPetSmoke(rendererErrors);
    shutdown = true; await closeHostClient();
    app.exit(passed ? 0 : 1);
    return;
  }
  if (!smokeMode) {
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const offset = (y * 16 + x) * 4;
      const microphone = (x >= 6 && x <= 9 && y >= 2 && y <= 9) || (y === 11 && x >= 4 && x <= 11) || (x === 8 && y >= 11 && y <= 14);
      pixels[offset] = microphone ? 230 : 70; pixels[offset + 1] = microphone ? 245 : 110;
      pixels[offset + 2] = microphone ? 255 : 170; pixels[offset + 3] = 255;
    }
    const icon = nativeImage.createFromBitmap(pixels, { width: 16, height: 16 });
    tray = new Tray(icon); tray.on('double-click', () => { window?.show(); window?.focus(); }); updateTray();
    if (shellSmoke) {
      window.close();
      const report = { timestamp: new Date().toISOString(), packaged: app.isPackaged, trayCreated: !tray.isDestroyed(),
        closeHidesWindow: !window.isDestroyed() && !window.isVisible(), assetsReady: assetStatus.ready,
        physicalDevicesTested: false, microphoneOpened: false, modelRequests: 0,
        passed: !tray.isDestroyed() && !window.isDestroyed() && !window.isVisible() && assetStatus.ready };
      const directory = path.join(assetRoot, 'outputs/desktop-validation/m4');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `package-smoke-${Date.now()}.json`), JSON.stringify(report, null, 2));
      app.quit(); return;
    }
    powerMonitor.on('suspend', () => {
      send({ type: 'session-ended', sessionId, reason: '系统进入睡眠，已停止采集；唤醒后请重新开始。' });
      void stopSession().then(async () => {
        const oldSpeech = speech, oldTts = tts; speech = undefined; tts = undefined;
        await Promise.allSettled([oldSpeech?.dispose(), oldTts?.dispose()]);
      });
    });
    powerMonitor.on('resume', () => send({ type: 'status', status: '系统已唤醒；请重新开始会话' }));
    // Prepare local models without opening the microphone or making a model request.
    const service = speech ??= new LocalDshSpeech(root, status);
    void service.start().catch(async () => { if (speech === service) speech = undefined; await service.dispose(); });
    void prepareTts().catch(() => {});
  }
}).catch(error => {
  console.error('DeskAI startup failed:', error);
  if (petSmoke) {
    const directory = path.join(assetRoot, 'outputs/desktop-pet/validation');
    void mkdir(directory, { recursive: true }).then(() => writeFile(path.join(directory, 'app-pet-smoke.json'), JSON.stringify({
      passed: false, startupError: error instanceof Error ? error.message : String(error),
      simulatedStates: true, realAudioPlaybackTested: false, physicalDevicesTested: false,
    }, null, 2))).catch(() => {}).finally(() => app.exit(1));
    return;
  }
  if (!smokeMode) dialog.showErrorBox('DeskAI 启动失败', String(error instanceof Error ? error.message : error).slice(0, 500));
  app.exit(1);
});
app.on('second-instance', () => { window?.show(); window?.focus(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shutdown) return;
  event.preventDefault();
  shutdown = true;
  petWindow?.prepareToQuit();
  tray?.destroy();
  artifactWindows.close();
  workWindow.close();
  void Promise.allSettled([stopSession(), closeHostClient()])
    .then(() => Promise.allSettled([speech?.dispose(), tts?.dispose(), petWindow?.flush()])).finally(() => app.quit());
});
