import { app, BrowserWindow, ipcMain, protocol, session, Tray, Menu, nativeImage, powerMonitor } from 'electron';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalDshSpeech, type SpeechStatus } from '../../../packages/dsh-adapter/src/speech.ts';
import { LocalDshChat } from '../../../packages/dsh-adapter/src/session.ts';
import { createInputController, encodePcm16Wav, type InputController } from '../../../packages/voice-core/src/index.ts';
import { DialogueController, type DialogueEvent, type DialoguePreferences } from '../../../packages/voice-core/src/dialogue.ts';
import { validatePersona } from '../../../packages/voice-core/src/prompts.ts';
import { FixtureChatPort } from './fixture-chat.ts';
import { LocalTtsService, type TtsStatus, type VoiceSelection } from '../../../packages/tts-adapter/src/index.ts';
import { SpeechOutput, type SpeechPlaybackReport } from './speech-output.ts';
import { defaultPreferences, loadPreferences, savePreferences, mergePreferences, inspectAssets, type DesktopPreferences } from './settings.ts';

const root = path.resolve(process.env.DESKAI_PROJECT_ROOT ?? process.cwd());
const assetRoot = path.resolve(process.env.DESKAI_ASSET_ROOT ?? root);
process.env.DESKAI_ASSET_ROOT = assetRoot;
app.setName('DeskAI2');
const rendererRoot = path.join(root, '.cache/desktop-renderer');
const page = 'deskai://app/index.html';
const smokeMode = process.argv.includes('--smoke');
const shellSmoke = process.argv.includes('--shell-smoke');
const dialogueSmoke = smokeMode && process.argv.includes('--dialogue-smoke');
const ttsSmoke = smokeMode && process.argv.includes('--tts-smoke');
const realModelSmoke = ttsSmoke && process.argv.includes('--real-model');
const fakeMedia = process.argv.includes('--use-fake-device-for-media-stream');
const hasInstanceLock = smokeMode || app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
if (smokeMode && (!fakeMedia || !process.argv.includes('--use-fake-ui-for-media-stream'))) {
  throw new Error('Smoke mode requires explicit fake media and permission switches');
}
protocol.registerSchemesAsPrivileged([{ scheme: 'deskai', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true
} }]);
if (smokeMode) app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let window: BrowserWindow | undefined;
let speech: LocalDshSpeech | undefined;
let controller: InputController | undefined;
let sessionId = '';
let captureArmed = false;
let sessionEpoch = 0;
let outputGeneration = 0;
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
  interruptions: [] as { type: string; at: number }[] };
let outputActive = false;

function send(event: object) { if (window && !window.isDestroyed()) window.webContents.send('deskai:event', event); }
function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(captureArmed ? 'DeskAI · 正在监听麦克风' : 'DeskAI · 麦克风关闭');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: captureArmed ? '● 正在监听' : '麦克风关闭', enabled: false },
    { label: '打开主窗口', click: () => { window?.show(); window?.focus(); } },
    { label: captureArmed ? '暂停麦克风' : '恢复麦克风', click: () => {
      window?.show(); window?.focus(); send({ type: 'capture-command', command: captureArmed ? 'pause' : 'resume' });
    } },
    { type: 'separator' }, { label: '退出并释放服务', click: () => app.quit() },
  ]));
}
function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  if (event.sender !== window?.webContents || event.senderFrame?.url !== page) throw new Error('UNTRUSTED_RENDERER');
}
function refreshOutput() {
  controller?.setOutput({ generationId: Math.max(outputGeneration, dialogue?.generationId ?? 0),
    playing: outputActive || outputPaused || outputBusy || dialogue?.isGenerating === true, expectsReply: dialogue?.expectsReply() ?? false });
}
function updateTtsStatus(update: TtsStatus) {
  ttsStatus = update;
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
  voiceOutput = new SpeechOutput({ sessionId, port: tts,
    emit: event => {
      if (event.type === 'audio-chunk') { ttsMetrics.pcmChunks++; ttsMetrics.firstPCMAt ||= performance.now(); }
      if (event.type === 'speech-state') { outputBusy = !['idle', 'error'].includes(event.state); refreshOutput(); }
      send(event);
    },
    onSegment: progress => {
      activeDialogue.recordPlayback(progress); refreshOutput();
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
  if (event.type === 'output-clear') {
    outputGeneration = Math.max(outputGeneration, event.generationId);
    outputActive = outputPaused = false;
    send({ type: 'output-command', sessionId, generationId: outputGeneration, command: 'clear' });
  }
  voiceOutput?.handle(event);
  if (!voiceOutput && event.type === 'assistant-delta' && event.source === 'voice') dialogue?.speechFallback(event.attemptId);
  send({ type: 'dialogue', sessionId, event });
  refreshOutput();
}
function status(update: SpeechStatus) {
  const labels: Record<string, string> = { starting: '正在启动 dsh', preparing: '正在准备 SenseVoice',
    ready: '本地语音识别已就绪', error: '语音服务异常', stopped: '语音服务已停止' };
  const progress = update.totalBytes ? `${Math.round((update.completedBytes ?? 0) / update.totalBytes * 100)}%` : '';
  lastSpeechStatus = { status: labels[update.state], detail: [update.phase ?? update.code, progress].filter(Boolean).join(' · ') };
  send({ type: 'status', ...lastSpeechStatus });
  if (update.state === 'error' && sessionId) {
    send({ type: 'session-ended', sessionId, reason: '语音服务已断开，麦克风已停止；可重新开始会话。' });
    const failed = speech;
    speech = undefined;
    void stopSession().then(() => failed?.dispose());
  }
}
async function stopSession() {
  sessionEpoch++;
  captureArmed = false;
  updateTray();
  controller?.stop();
  const oldDialogue = dialogue;
  const oldOutput = voiceOutput;
  voiceOutput = undefined;
  outputBusy = false;
  dialogue = undefined;
  if (sessionId) send({ type: 'output-command', sessionId, command: 'clear', generationId: ++outputGeneration });
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
}

ipcMain.handle('deskai:runtime', event => {
  trusted(event);
  return { smoke: smokeMode, fakeMedia, dialogueSmoke, ttsSmoke, preferences, personas,
    speechStatus: lastSpeechStatus, assetStatus, ttsStatus, voices: tts?.registry() ?? [],
    versions: { electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '' } };
});
async function openConversation() {
  if (sessionId) return;
  if (opening) return opening;
  const work = (async () => {
  const epoch = ++sessionEpoch;
  if (dialogueSmoke) {
    sessionId = randomUUID();
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
  sessionId = randomUUID();
  metrics.sessionStarts++;
  outputGeneration = 0;
  if (ttsSmoke && !realModelSmoke) fixturePort = new FixtureChatPort();
  dialogue = new DialogueController(ttsSmoke && !realModelSmoke ? fixturePort! : new LocalDshChat(service, root), preferences, dialogueEvent);
  attachOutput();
  // Keep this instance across sessions so a canceled ASR task settles before
  // the new session can start another task on the same recognizer.
  controller ??= createInputController({
    maxSegmentSeconds: Math.min(20, catalog.maxDurationSeconds, (catalog.maxAudioBytes - 44) / 32000),
    maxQueuedSegments: 4,
    transcribe: async (segment, signal) => {
      const started = performance.now();
      const result = await speech!.transcribe(encodePcm16Wav(segment.samples), signal);
      if (!signal.aborted && sessionId === segment.sessionId) {
        metrics.asrCompleted++;
        metrics.asrSeconds.push((performance.now() - started) / 1000);
        if (metrics.asrSeconds.length > 100) metrics.asrSeconds.shift();
      }
      return result.text;
    },
    onSegment: segment => {
      metrics.segments++;
      if (smokeMode && fakeMedia && metrics.firstSegment === null) {
        metrics.firstSegment = { startSample: segment.startSample, endSample: segment.endSample, final: segment.final };
        void mkdir(path.join(root, 'outputs/desktop-validation/m1'), { recursive: true }).then(() =>
          writeFile(path.join(root, 'outputs/desktop-validation/m1/synthetic-first-segment.wav'), encodePcm16Wav(segment.samples)));
      }
    },
    onInputState: state => send({ type: 'input-state', sessionId, state }),
    onInterruption: event => {
      metrics.interruptions.push({ type: event.type, at: performance.now() });
      if (metrics.interruptions.length > 100) metrics.interruptions.shift();
      const command = event.type === 'candidate' ? 'pause' : event.type === 'resume' ? 'resume' : 'clear';
      if (event.type === 'confirmed') outputGeneration = Math.max(outputGeneration, event.generationId + 1);
      if (voiceOutput) voiceOutput.command(command, event.type === 'confirmed' ? outputGeneration : event.generationId);
      else send({ type: 'output-command', sessionId, generationId: event.type === 'confirmed' ? outputGeneration : event.generationId, command });
      if (event.type === 'confirmed') { outputPaused = false; void dialogue?.cancel().catch(() => {}); }
      else outputPaused = event.type === 'candidate';
    },
    onBoundary: event => {
      if (event.type === 'overflow' || event.type === 'discarded' && /ASR|queue/.test(event.reason ?? '')) {
        send({ type: 'error', sessionId, code: 'ASR_SEGMENT_DISCARDED', message: '识别队列或片段处理失败，本片段已丢弃；可以继续说话。' });
      }
    },
    onError: () => send({ type: 'error', sessionId, code: 'ASR_FAILED', message: '本次语音识别失败；后续片段可继续识别。' }),
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
      voiceSubmitting = true;
      const current = controller;
      void dialogue?.submit({ text: ready.text, source: 'voice', continuationOf: ready.continuationOf,
        utteranceIds: ready.utteranceIds, isEligible: () => sessionId === ready.sessionId && current.isEligible(ready.inputRevision, ready.utteranceIds),
        onAccepted: () => {
          if (sessionId === ready.sessionId) {
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
        });
    }
  });
  })();
  opening = work;
  try { await work; } finally { if (opening === work) opening = undefined; }
}
function sessionDescription() {
  return { sessionId, catalog: [{ voiceId: 'nagato-normal-v2', name: '常态有希 v2' }],
    status: dialogueSmoke ? '本地模拟模型验证' : '本地识别就绪；对话使用 dsh 配置的模型' };
}
ipcMain.handle('deskai:open-conversation', async event => { trusted(event); await openConversation(); return sessionDescription(); });
ipcMain.handle('deskai:start', async event => {
  trusted(event);
  await openConversation();
  const startingSession = sessionId;
  // A synthesis failure keeps transcription/text available and is visible in the UI.
  if (!smokeMode || ttsSmoke) await prepareTts().then(() => { if (!voiceOutput) attachOutput(); }).catch(() => {
    send({ type: 'error', message: '语音合成服务准备失败，仍可识别和文字对话；点击“恢复语音服务”可重试。', code: 'TTS_UNAVAILABLE' });
  });
  if (!startingSession || sessionId !== startingSession || shutdown) throw new Error('SESSION_START_CANCELLED');
  captureArmed = true;
  updateTray();
  controller?.start(sessionId);
  refreshOutput();
  return sessionDescription();
});
ipcMain.handle('deskai:stop', async event => { trusted(event); await stopSession(); });
ipcMain.handle('deskai:send-text', async (event, value: unknown) => {
  trusted(event);
  const data = value as { sessionId?: string; text?: string };
  if (!data || data.sessionId !== sessionId || !dialogue || typeof data.text !== 'string' || data.text.length > 4000) throw new Error('INVALID_TEXT_INPUT');
  return dialogue.submit({ text: data.text, source: captureArmed ? 'voice' : 'text' });
});
ipcMain.handle('deskai:cancel-turn', async event => { trusted(event); await dialogue?.cancel(); refreshOutput(); });
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
      await dialogue?.cancel();
      voiceOutput?.command('clear', dialogue?.generationId ?? ++outputGeneration);
      await prepareTts();
      if (!tts) throw new Error('TTS_NOT_READY');
      const voice = tts.registry().find(row => row.id === next.voiceId);
      if (!voice) throw new Error('INVALID_VOICE');
      voiceSelection = await tts.selectVoice(voice.id, next.referenceId || voice.defaultReferenceId);
      next.referenceId = voiceSelection.referenceId;
    }
    if (next.personaId !== preferences.personaId || next.replyLanguage !== preferences.replyLanguage) await dialogue?.updatePreferences(next);
    preferences = next;
    voiceOutput?.setSelection({ ...voiceSelection, language: next.replyLanguage, speed: next.speed });
    if (!smokeMode) await savePreferences(app.getPath('userData'), preferences);
    refreshOutput();
    return preferences;
  });
  preferenceWrite = work.catch(() => {});
  return work;
});
ipcMain.handle('deskai:pause-capture', event => {
  trusted(event); captureArmed = false; controller?.stop(); updateTray();
});
ipcMain.handle('deskai:retry-speech', async event => {
  trusted(event);
  if (recoveringTts) return recoveringTts;
  const work = (async () => {
    await dialogue?.cancel();
    await voiceOutput?.close(); voiceOutput = undefined;
    const pending = ttsPreparing, old = tts; tts = undefined;
    await old?.dispose(); await pending?.catch(() => {});
    await prepareTts(); attachOutput();
  })();
  recoveringTts = work;
  try { await work; } finally { if (recoveringTts === work) recoveringTts = undefined; }
});
ipcMain.on('deskai:frame', (event, frame: unknown) => {
  try {
    trusted(event);
    if (!captureArmed || !controller || !frame || typeof frame !== 'object') return;
    const value = frame as { sessionId: string; samples: Float32Array; probability: number };
    if (value.sessionId !== sessionId || !(value.samples instanceof Float32Array) || value.samples.length > 2048 ||
        !Number.isFinite(value.probability) || value.probability < 0 || value.probability > 1) return;
    metrics.inputFrames++; metrics.inputSamples += value.samples.length;
    if (outputActive) metrics.inputFramesDuringPlayback++;
    refreshOutput();
    controller.pushFrame(value);
  } catch { send({ type: 'error', code: 'INVALID_CAPTURE_FRAME', message: '采集帧格式错误，请重新开始会话。' }); }
});
ipcMain.on('deskai:playback', (event, report: unknown) => {
  trusted(event);
  if (!report || typeof report !== 'object') return;
  const value = report as { sessionId: string; generationId: number; playing: boolean; paused: boolean };
  if (value.sessionId !== sessionId || !Number.isSafeInteger(value.generationId) || value.generationId < outputGeneration) return;
  outputGeneration = value.generationId;
  outputActive = value.playing === true;
  outputPaused = value.paused === true;
  voiceOutput?.playback(value as SpeechPlaybackReport);
  refreshOutput();
});
ipcMain.handle('deskai:playback-fixture', async event => {
  trusted(event);
  if (!sessionId) throw new Error('SESSION_NOT_ACTIVE');
  return new Uint8Array(await readFile(path.join(assetRoot, 'assets/凉宫春日参考语音包/predef_ref/正常有希/01_有希_平静.wav')));
});
ipcMain.on('deskai:finish-smoke', (event, input: unknown) => {
  trusted(event);
  if (!smokeMode || !fakeMedia || smokeCompleted || !input || typeof input !== 'object') return;
  smokeCompleted = true;
  const data = input as Record<string, unknown>;
  const checks = ['vadInitialized', 'asrTranscriptSeen', 'transcriptRendered', 'inputDuringPlayback'];
  const passed = data.simulated === true && checks.every(key => data[key] === true) && metrics.asrCompleted > 0 && data.completedSessions === 2;
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
    shutdown = true;
    app.exit(passed ? 0 : 1);
  })().catch(() => app.exit(1));
});

ipcMain.on('deskai:finish-dialogue-smoke', (event, input: unknown) => {
  trusted(event);
  if (!dialogueSmoke || !fakeMedia || smokeCompleted || !input || typeof input !== 'object') return;
  smokeCompleted = true;
  const data = input as { checks?: Record<string, unknown>; notes?: unknown[]; simulated?: unknown };
  const checks = Object.fromEntries(Object.entries(data.checks ?? {}).filter(([, value]) => typeof value === 'boolean'));
  const required = ['headerHidden', 'waitSilentNoBubble', 'textQuestionDisplayed', 'shortAnswerWorked',
    'retryWorked', 'cancelWorked', 'preferencesIndependent', 'noMicrophoneOpened'];
  const report = { simulated: true, provider: 'local-interface-fixture', realModelValidated: false,
    passed: data.simulated === true && required.every(key => checks[key] === true) && metrics.inputFrames === 0 &&
      fixturePort?.requests.length === 7,
    checks, microphoneFrames: metrics.inputFrames, model: dialogue?.stats, requests: fixturePort?.requests,
    physicalDevicesTested: false, notes: (data.notes ?? []).filter(item => typeof item === 'string').slice(0, 10), timestamp: new Date().toISOString() };
  void (async () => {
    const dir = path.join(root, 'outputs/desktop-validation/m2');
    await mkdir(dir, { recursive: true });
    if (window && !window.isDestroyed()) await writeFile(path.join(dir, 'desktop-smoke.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(path.join(dir, `desktop-smoke-${Date.now()}.json`), JSON.stringify(report, null, 2));
    await stopSession(); await speech?.dispose(); shutdown = true; app.exit(report.passed ? 0 : 1);
  })().catch(() => app.exit(1));
});

function maybeFinishTtsSmoke() {
  const attempts = dialogue?.ledger.snapshot();
  if (!ttsSmoke || smokeCompleted || !dialogue || dialogue.isGenerating || ttsMetrics.playedSegments < 1 ||
    !attempts?.length || attempts.some(row => row.unplayed.trim().length > 0)) return;
  smokeCompleted = true;
  const report = { timestamp: new Date().toISOString(), simulatedMicrophone: true, simulatedModel: !realModelSmoke,
    realDshModel: realModelSmoke,
    realSenseVoice: true, realGpuTts: true, physicalMicrophoneTested: false, physicalSpeakerTested: false, aecValidated: false,
    metrics, tts: ttsMetrics, model: dialogue.stats, ledger: dialogue.ledger.snapshot(),
    passed: metrics.asrCompleted > 0 && metrics.inputFramesDuringPlayback > 0 && ttsMetrics.pcmChunks > 0 &&
      ttsMetrics.voiceFailures === 0 && dialogue.stats.modelRequests === 1 };
  void (async () => {
    const directory = path.join(root, 'outputs/desktop-validation/m3');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `desktop-smoke-${Date.now()}.json`), JSON.stringify(report, null, 2));
    if (window && !window.isDestroyed()) await writeFile(path.join(directory, 'desktop-smoke.png'), (await window.webContents.capturePage()).toPNG());
    await stopSession(); await speech?.dispose(); await tts?.dispose(); shutdown = true; app.exit(report.passed ? 0 : 1);
  })().catch(() => app.exit(1));
}

app.whenReady().then(async () => {
  if (!hasInstanceLock) return;
  await mkdir(app.getPath('userData'), { recursive: true });
  if (!smokeMode && !shellSmoke) preferences = await loadPreferences(app.getPath('userData'));
  assetStatus = await inspectAssets(assetRoot);
  personas = await Promise.all(['nagato-normal-light', 'assistant-neutral'].map(async id => {
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
        '.css': 'text/css', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };
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
  window = new BrowserWindow({ width: 960, height: 760, minWidth: 700, minHeight: 560, show: !smokeMode && !shellSmoke,
    autoHideMenuBar: true, webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, destination) => { if (destination !== page) event.preventDefault(); });
  window.webContents.on('render-process-gone', () => { void stopSession(); });
  window.on('close', event => {
    if (!shutdown && preferences.closeToTray && tray) { event.preventDefault(); window?.hide(); }
  });
  if (smokeMode) window.webContents.on('console-message', event => {
    // Fixture-only diagnostics: avoid logging renderer content during real conversations.
    const details = event as Electron.Event & { level?: string | number; message?: string };
    if (details.level === 3 || details.level === 'error') console.error('Renderer smoke:', String(details.message ?? '').slice(0, 500));
  });
  await window.loadURL(page);
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
});
app.on('second-instance', () => { window?.show(); window?.focus(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shutdown) return;
  event.preventDefault();
  shutdown = true;
  tray?.destroy();
  void stopSession().then(() => Promise.allSettled([speech?.dispose(), tts?.dispose()])).finally(() => app.quit());
});
