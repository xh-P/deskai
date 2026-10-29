import { useCallback, useEffect, useRef, useState } from 'react'
import { FrameVAD } from './frame-vad'
import type { DeskaiEvent, DialogueSmokeReport, PersonaId, ReplyLanguage, RuntimeInfo, SessionStart, SmokeReport, Preferences } from './bridge'
import type { DialogueEvent } from '../../../../packages/voice-core/src/dialogue.ts'
import { PcmPlayer } from './player'
import './style.css'

type Entry = { id: number; role: 'user' | 'system' | 'assistant'; text: string; turnId?: string; attemptId?: string;
  generationId?: number; interrupted?: boolean; completed?: boolean }
type Capture = { stream: MediaStream; vad: FrameVAD; context: AudioContext; player: PcmPlayer; sessionId: string }
type Output = { context: AudioContext; player: PcmPlayer; sessionId: string }

function describeMediaError(error: unknown): string {
  if (error instanceof Error && /MISSING_CREDENTIAL/.test(error.message)) return '模型凭据未配置：服务尚未接通。请在 dsh 配置后重试。'
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') return '麦克风权限被拒绝。请在系统或应用权限设置中允许后重试。'
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') return '未找到可用的麦克风。请连接输入设备后重试。'
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') return '麦克风被占用或无法启动。请检查设备连接和其他应用。'
  }
  return error instanceof Error ? error.message : String(error)
}

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [starting, setStarting] = useState(false)
  const [session, setSession] = useState<SessionStart | null>(null)
  const [captureState, setCaptureState] = useState('未开启')
  const [serviceState, setServiceState] = useState('检查服务中')
  const [inputState, setInputState] = useState('OFF')
  const [playback, setPlayback] = useState('空闲')
  const [mediaSettings, setMediaSettings] = useState<MediaTrackSettings | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [error, setError] = useState('')
  const [textDraft, setTextDraft] = useState('')
  const [sendingText, setSendingText] = useState(false)
  const [modelState, setModelState] = useState('idle')
  const [retryable, setRetryable] = useState(false)
  const [preferences, setPreferences] = useState<RuntimeInfo['preferences'] | null>(null)
  const [preferenceNote, setPreferenceNote] = useState('')
  const [ttsState, setTtsState] = useState('尚未准备')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const captureRef = useRef<Capture | null>(null)
  const outputRef = useRef<Output | null>(null)
  const preferencesRef = useRef<Preferences | null>(null)
  preferencesRef.current = preferences
  const startLock = useRef(false)
  const stopLock = useRef(false)
  const currentSession = useRef('')
  const nextEntry = useRef(0)
  const smoke = useRef<SmokeReport | null>(null)
  const smokeDone = useRef(false)
  const smokeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const playbackRef = useRef(false)
  const startEpoch = useRef(0)
  const generationFloor = useRef(0)
  const acknowledged = useRef(new Map<string, number>())
  const dialogueEvents = useRef<DialogueEvent[]>([])
  const dialogueWaiters = useRef(new Set<(event: DialogueEvent) => void>())
  const dialogueSmokeStarted = useRef(false)
  const microphoneOpened = useRef(false)
  const lastTranscript = useRef('')

  const ensureOutput = useCallback(async (opened: SessionStart): Promise<Output> => {
    if (outputRef.current?.sessionId === opened.sessionId) return outputRef.current
    const context = new AudioContext()
    await context.resume()
    const player = new PcmPlayer(context, opened.sessionId, report => {
      window.deskai.playbackState(report)
      playbackRef.current = report.playing
      setPlayback(report.completed ? '播放完成' : report.paused ? '因候选插话暂停' : report.playing ? '播放中' : '空闲')
    }, message => { setError(message); window.deskai.playbackState({ sessionId: opened.sessionId, generationId: generationFloor.current, playing: false, paused: false, errorCode: 'PLAYER_ERROR' }) })
    try {
      await player.initialize()
      player.setVolume(preferencesRef.current?.volume ?? 0.8)
      const sink = preferencesRef.current?.outputDeviceId
      if (sink) {
        const selectable = context as AudioContext & { setSinkId?: (id: string) => Promise<void> }
        if (!selectable.setSinkId) throw new Error('当前音频设备不支持应用内选择，请在 Windows 中选择输出设备。')
        await selectable.setSinkId(sink)
      }
      if (currentSession.current !== opened.sessionId) throw new Error('会话已结束')
      return outputRef.current = { context, player, sessionId: opened.sessionId }
    } catch (cause) { player.close(); await context.close(); throw cause }
  }, [])

  const addEntry = useCallback((role: Entry['role'], text: string) => {
    setEntries(previous => [...previous.slice(-49), { id: ++nextEntry.current, role, text }])
  }, [])

  const addAssistantDelta = useCallback((event: Extract<DialogueEvent, { type: 'assistant-delta' }>) => {
    if (event.generationId < generationFloor.current) return
    setEntries(previous => {
      const current = previous.find(entry => entry.role === 'assistant' && entry.attemptId === event.attemptId && entry.generationId === event.generationId)
      if (current?.interrupted || current?.completed) return previous
      if (current) return previous.map(entry => entry === current ? { ...entry, text: (entry.text + event.text).slice(0, 12000) } : entry)
      return [...previous.slice(-49), { id: ++nextEntry.current, role: 'assistant', text: event.text.slice(0, 12000),
        turnId: event.turnId, attemptId: event.attemptId, generationId: event.generationId }]
    })
  }, [])

  const waitDialogue = useCallback((after: number, predicate: (event: DialogueEvent) => boolean, timeout = 20000): Promise<DialogueEvent> => {
    const existing = dialogueEvents.current.slice(after).find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const listener = (event: DialogueEvent) => { if (predicate(event)) { clearTimeout(timer); dialogueWaiters.current.delete(listener); resolve(event) } }
      const timer = setTimeout(() => { dialogueWaiters.current.delete(listener); reject(new Error('M2 smoke 等待对话事件超时')) }, timeout)
      dialogueWaiters.current.add(listener)
    })
  }, [])

  const finishSmoke = useCallback(() => {
    if (!smoke.current || smokeDone.current) return
    smokeDone.current = true
    if (smokeTimer.current) clearTimeout(smokeTimer.current)
    window.deskai.finishSmoke(smoke.current)
  }, [])

  const handleDialogue = useCallback((event: DialogueEvent) => {
    dialogueEvents.current = [...dialogueEvents.current.slice(-499), event]
    for (const waiter of dialogueWaiters.current) waiter(event)
    switch (event.type) {
      case 'user':
        if (event.source !== 'voice' || lastTranscript.current !== event.text) addEntry('user', event.text)
        lastTranscript.current = ''
        break
      case 'decision':
        if (event.action === 'WAIT') setModelState('waiting')
        else if (event.action === 'SILENT') setModelState('silent')
        break
      case 'assistant-delta': addAssistantDelta(event); break
      case 'assistant-state':
        if (event.state === 'complete' || event.state === 'interrupted' || event.state === 'error') setEntries(previous => previous.map(entry =>
          entry.role === 'assistant' && entry.attemptId === event.attemptId
            ? event.state === 'complete' ? { ...entry, completed: true } : entry.completed ? entry : { ...entry, interrupted: true } : entry))
        break
      case 'output-clear':
        generationFloor.current = Math.max(generationFloor.current, event.generationId)
        setEntries(previous => previous.map(entry => entry.role === 'assistant' && !entry.completed && !entry.interrupted && (entry.generationId ?? 0) < event.generationId
          ? { ...entry, interrupted: true } : entry))
        break
      case 'model-state':
        setModelState(event.state)
        if (event.code === 'MISSING_CREDENTIAL') setError('模型账号未配置。请先在 dsh 设置中配置，再点击“重试回复”。')
        break
      case 'error':
        setError(event.code === 'MISSING_CREDENTIAL' ? '模型账号未配置。请先在 dsh 设置中配置，再点击“重试回复”。' : event.message)
        setRetryable(event.retryable)
        break
      case 'usage': break
    }
  }, [addAssistantDelta, addEntry])

  const runDialogueSmoke = useCallback(async () => {
    if (dialogueSmokeStarted.current) return
    dialogueSmokeStarted.current = true
    const checks: DialogueSmokeReport['checks'] = { headerHidden: false, waitSilentNoBubble: false,
      textQuestionDisplayed: false, shortAnswerWorked: false, retryWorked: false, cancelWorked: false,
      preferencesIndependent: false, noMicrophoneOpened: false }
    const notes: string[] = []
    try {
      const opened = await window.deskai.openConversation()
      currentSession.current = opened.sessionId
      setSession(opened)
      setServiceState(opened.status)
      const send = async (text: string) => {
        const mark = dialogueEvents.current.length
        const result = await window.deskai.sendText({ sessionId: opened.sessionId, text })
        if (!result.accepted) throw new Error(`M2 smoke 未接受文本：${text}`)
        return mark
      }
      const speakMark = await send('M2: speak')
      const speakDone = await waitDialogue(speakMark, e => e.type === 'assistant-state' && e.state === 'complete')
      await new Promise(resolve => setTimeout(resolve, 150))
      const assistantText = speakDone.type === 'assistant-state'
        ? document.querySelector<HTMLElement>(`.entry.assistant[data-attempt-id="${speakDone.attemptId}"] p`)?.textContent ?? '' : ''
      checks.headerHidden = !!assistantText && !/"v"\s*:|"action"\s*:|direct_request|```/u.test(assistantText)
      checks.textQuestionDisplayed = speakDone.type === 'assistant-state' && !!speakDone.attemptId
        && (acknowledged.current.get(speakDone.attemptId) ?? 0) >= assistantText.length && /[?？]/u.test(assistantText)
      const count = () => document.querySelectorAll('.entry.assistant').length
      const beforeQuiet = count()
      const waitMark = await send('M2: wait')
      await waitDialogue(waitMark, e => e.type === 'model-state' && e.state === 'waiting')
      const silentMark = await send('M2: silent')
      await waitDialogue(silentMark, e => e.type === 'model-state' && e.state === 'silent')
      await new Promise(resolve => setTimeout(resolve, 100))
      checks.waitSilentNoBubble = count() === beforeQuiet
      const shortMark = await send('M2: short')
      const shortDone = await waitDialogue(shortMark, e => e.type === 'assistant-state' && e.state === 'complete')
      checks.shortAnswerWorked = shortDone.type === 'assistant-state' && dialogueEvents.current.slice(shortMark)
        .some(e => e.type === 'assistant-delta' && e.attemptId === shortDone.attemptId)
      const malformedMark = await send('M2: malformed')
      await waitDialogue(malformedMark, e => e.type === 'error' && /^PROTOCOL/u.test(e.code))
      const retryMark = dialogueEvents.current.length
      const retry = await window.deskai.retryTurn()
      if (!retry.accepted) throw new Error('M2 smoke 显式重试未接受')
      const retryDone = await waitDialogue(retryMark, e => e.type === 'assistant-state' && e.state === 'complete')
      checks.retryWorked = retryDone.type === 'assistant-state' && dialogueEvents.current.slice(retryMark)
        .some(e => e.type === 'assistant-delta' && e.attemptId === retryDone.attemptId)
      const longMark = await send('M2: long')
      await waitDialogue(longMark, e => e.type === 'assistant-delta')
      const cancelMark = dialogueEvents.current.length
      await window.deskai.cancelTurn()
      await waitDialogue(cancelMark, e => e.type === 'assistant-state' && e.state === 'interrupted')
      checks.cancelWorked = true
      const before = await window.deskai.getRuntime()
      await window.deskai.updatePreferences({ personaId: 'assistant-neutral', replyLanguage: 'ja' })
      const after = await window.deskai.getRuntime()
      checks.preferencesIndependent = before.preferences.voiceId === after.preferences.voiceId
        && after.preferences.personaId === 'assistant-neutral' && after.preferences.replyLanguage === 'ja'
      checks.noMicrophoneOpened = !microphoneOpened.current && !captureRef.current
    } catch (cause) { notes.push(describeMediaError(cause)) }
    window.deskai.finishDialogueSmoke({ simulated: true, checks, notes })
  }, [waitDialogue])

  const stop = useCallback(async (reason?: string) => {
    if (stopLock.current) return
    stopLock.current = true
    if (smokeTimer.current) clearTimeout(smokeTimer.current)
    startEpoch.current++
    currentSession.current = '' // Drop late VAD frames before releasing resources.
    generationFloor.current = 0
    acknowledged.current.clear()
    lastTranscript.current = ''
    const old = captureRef.current
    const oldOutput = outputRef.current
    captureRef.current = null
    outputRef.current = null
    setCaptureState(reason ?? '未开启')
    setInputState('OFF')
    setPlayback('空闲')
    playbackRef.current = false
    setMediaSettings(null)
    setModelState('idle')
    setRetryable(false)
    setStarting(false)
    // Main admission/cancellation must not depend on ONNX/audio cleanup succeeding.
    const stopMain = window.deskai.stopSession().catch(cause => setError(describeMediaError(cause)))
    try {
      if (old) {
        old.stream.getAudioTracks().forEach(track => { track.onended = null; track.stop() })
        try { await old.vad.destroy() } catch { /* The stream may already have ended. */ }
      }
      oldOutput?.player.close()
      await oldOutput?.context.close()
    } catch (cause) {
      setError(describeMediaError(cause))
    } finally {
      await stopMain
      setSession(null)
      stopLock.current = false
    }
  }, [])

  const start = useCallback(async () => {
    if (startLock.current || stopLock.current || captureRef.current) return
    startLock.current = true
    const epoch = ++startEpoch.current
    setStarting(true)
    setError('')
    setCaptureState('准备语音服务和麦克风中')
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let vad: FrameVAD | null = null
    let player: PcmPlayer | null = null
    try {
      const opened = await window.deskai.startSession()
      if (epoch !== startEpoch.current) throw new Error('会话已结束')
      currentSession.current = opened.sessionId
      setSession(opened)
      setServiceState(opened.status)
      const output = await ensureOutput(opened)
      context = output.context
      player = output.player
      if (epoch !== startEpoch.current) throw new Error('会话已结束')
      vad = await FrameVAD.new({
        context,
        getStream: async () => {
          if (epoch !== startEpoch.current) throw new Error('会话已结束')
          microphoneOpened.current = true
          const acquired = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false,
              ...(preferencesRef.current?.inputDeviceId ? { deviceId: { exact: preferencesRef.current.inputDeviceId } } : {}) },
          })
          if (epoch !== startEpoch.current) { acquired.getTracks().forEach(track => track.stop()); throw new Error('会话已结束') }
          stream = acquired
          return acquired
        },
        onError: cause => { setError(describeMediaError(cause)); void stop('采集处理失败，已释放麦克风') },
        onFrameProcessed: (probs, frame16k) => {
          if (currentSession.current !== opened.sessionId) return
          if (smoke.current && playbackRef.current) smoke.current.inputDuringPlayback = true
          window.deskai.sendFrame({ sessionId: opened.sessionId, samples: new Float32Array(frame16k), probability: probs.isSpeech })
        },
      })
      const deviceStream = stream as MediaStream | null
      const track = deviceStream?.getAudioTracks()[0]
      if (!deviceStream || !track) throw new DOMException('No audio input track', 'NotFoundError')
      if (epoch !== startEpoch.current || track.readyState !== 'live') throw new Error('麦克风已断开或会话已结束')
      setMediaSettings(track.getSettings())
      void navigator.mediaDevices.enumerateDevices().then(setDevices).catch(() => {})
      track.onended = () => { void stop('麦克风连接中断') }
      captureRef.current = { stream: deviceStream, vad, context, player, sessionId: opened.sessionId }
      setCaptureState('自动监听中')
      setInputState(previous => previous === 'OFF' ? 'LISTENING' : previous)
      if (smoke.current) {
        smoke.current.vadInitialized = true
        smoke.current.notes.push('Silero v5 initialized; Chromium fake media, not physical microphone/AEC validation')
        smokeTimer.current = setTimeout(finishSmoke, 120_000)
        try {
          const bytes = await window.deskai.loadPlaybackFixture()
          await player.playFixture(bytes)
        } catch (cause) { smoke.current.notes.push(`Fixture playback failed: ${describeMediaError(cause)}`) }
      }
    } catch (cause) {
      const message = describeMediaError(cause)
      if (epoch === startEpoch.current) setError(message)
      setCaptureState(epoch === startEpoch.current ? '启动失败' : '未开启')
      const openStream = stream as MediaStream | null
      if (openStream) openStream.getTracks().forEach(track => { track.onended = null; track.stop() })
      if (vad) { try { await vad.destroy() } catch { /* Initialization may be partial. */ } }
      player?.close()
      if (context) await context.close().catch(() => {})
      outputRef.current = null
      currentSession.current = ''
      setSession(null)
      await window.deskai.stopSession().catch(() => {})
      if (smoke.current) { smoke.current.notes.push(`Start failed: ${message}`); finishSmoke() }
    } finally {
      startLock.current = false
      setStarting(false)
    }
  }, [ensureOutput, finishSmoke, stop])

  const pauseCapture = useCallback(async () => {
    if (startLock.current) { await stop('已取消麦克风准备'); return; }
    const active = captureRef.current
    captureRef.current = null
    await window.deskai.pauseCapture()
    if (active) {
      active.stream.getTracks().forEach(track => { track.onended = null; track.stop() })
      await active.vad.destroy().catch(() => {})
    }
    setCaptureState('已暂停麦克风'); setInputState('OFF'); setMediaSettings(null)
  }, [stop])

  useEffect(() => {
    const unsubscribe = window.deskai.onEvent((event: DeskaiEvent) => {
      if ('sessionId' in event && event.sessionId && event.sessionId !== currentSession.current) return
      switch (event.type) {
        case 'dialogue': handleDialogue(event.event); break
        case 'session-ended': setError(event.reason); void stop(event.reason); break
        case 'status': setServiceState(event.detail ? `${event.status} · ${event.detail}` : event.status); break
        case 'transcript':
          if (event.text.trim()) {
            lastTranscript.current = event.text
            addEntry('user', event.text)
            if (smoke.current) {
              smoke.current.asrTranscriptSeen = true
              if (smoke.current.vadInitialized && smoke.current.inputDuringPlayback) {
                if (smoke.current.completedSessions === 0) {
                  smoke.current.completedSessions = 1
                  smoke.current.asrTranscriptSeen = false
                  smoke.current.inputDuringPlayback = false
                  smoke.current.notes.push('First session completed; verifying stop/restart and a new playback generation')
                  void stop().then(() => start())
                } else {
                  smoke.current.completedSessions = 2
                  requestAnimationFrame(() => requestAnimationFrame(() => {
                    if (smoke.current) smoke.current.transcriptRendered = Boolean(document.querySelector('.entry.user p')?.textContent?.trim())
                    finishSmoke()
                  }))
                }
              }
            }
          }
          break
        case 'input-state': setInputState(event.state); break
        case 'ready-text': if (smoke.current && event.text.trim()) addEntry('system', `待提交：${event.text}`); break
        case 'error': setError(event.code === 'MISSING_CREDENTIAL' ? '模型凭据未配置：语音识别或对话服务尚未接通。请在 dsh 配置后重试。' : event.message); break
        case 'output-command': outputRef.current?.player.command(event); break
        case 'audio-chunk': outputRef.current?.player.enqueue(event); break
        case 'capture-command': void (event.command === 'pause' ? pauseCapture() : start()); break
        case 'tts-status':
          setTtsState(event.status.state + (event.status.code ? ` · ${event.status.code}` : ''))
          if (event.status.state === 'ready') void window.deskai.getRuntime().then(info => { setRuntime(info); setPreferences(info.preferences) })
          break
        case 'speech-state': if (event.state === 'error') setError('语音合成失败，本轮保留文字；可点击恢复语音。'); break
      }
    })
    void window.deskai.getRuntime().then(info => {
      setRuntime(info)
      setPreferences(info.preferences)
      setServiceState(info.speechStatus?.status ?? '尚未准备')
      setTtsState(info.ttsStatus?.state ?? '尚未准备')
      if (!info.assetStatus?.ready) setError('本地运行资源不完整，请查看资源诊断。')
      void navigator.mediaDevices.enumerateDevices().then(setDevices).catch(() => {})
      if (info.ttsSmoke) { void start() }
      else if (info.smoke && info.fakeMedia && !info.dialogueSmoke) {
        smoke.current = { simulated: true, vadInitialized: false, asrTranscriptSeen: false, inputDuringPlayback: false, completedSessions: 0, notes: [] }
        void start()
      } else if (info.dialogueSmoke) {
        void runDialogueSmoke()
      }
    }).catch(cause => setError(describeMediaError(cause)))
    const devicesChanged = async () => {
      void navigator.mediaDevices.enumerateDevices().then(setDevices).catch(() => {})
      const active = captureRef.current
      if (!active) return
      const track = active.stream.getAudioTracks()[0]
      if (!track || track.readyState === 'ended') { await stop('麦克风连接中断'); return }
      const deviceId = track.getSettings().deviceId
      if (!deviceId || deviceId === 'default') return
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        if (!devices.some(device => device.kind === 'audioinput' && device.deviceId === deviceId)) await stop('麦克风设备已移除')
      } catch { /* Track-ended remains the authoritative fallback. */ }
    }
    navigator.mediaDevices?.addEventListener('devicechange', devicesChanged)
    return () => {
      unsubscribe()
      navigator.mediaDevices?.removeEventListener('devicechange', devicesChanged)
      if (smokeTimer.current) clearTimeout(smokeTimer.current)
      void stop()
    }
  }, [addEntry, finishSmoke, handleDialogue, runDialogueSmoke, pauseCapture, start, stop])

  useEffect(() => {
    if (!currentSession.current) return
    for (const entry of entries) {
      if (entry.role !== 'assistant' || !entry.attemptId) continue
      const element = [...document.querySelectorAll<HTMLElement>('.entry.assistant')]
        .find(node => node.dataset.attemptId === entry.attemptId)
      const characters = element?.querySelector('p')?.textContent?.length ?? 0
      if (characters <= (acknowledged.current.get(entry.attemptId) ?? 0)) continue
      acknowledged.current.set(entry.attemptId, characters)
      window.deskai.acknowledgeDisplay({ sessionId: currentSession.current, attemptId: entry.attemptId, characters })
    }
  }, [entries])

  const openTextConversation = async (): Promise<SessionStart> => {
    if (session) return session
    if (stopLock.current) throw new Error('会话正在结束')
    const epoch = ++startEpoch.current
    setStarting(true)
    setError('')
    try {
      const opened = await window.deskai.openConversation()
      if (epoch !== startEpoch.current) throw new Error('会话已结束')
      currentSession.current = opened.sessionId
      setSession(opened)
      setServiceState(opened.status)
      await ensureOutput(opened)
      return opened
    } finally { if (epoch === startEpoch.current) setStarting(false) }
  }

  const sendText = async () => {
    const text = textDraft.trim()
    if (!text || sendingText) return
    setSendingText(true)
    setError('')
    setRetryable(false)
    try {
      const opened = await openTextConversation()
      const result = await window.deskai.sendText({ sessionId: opened.sessionId, text })
      if (result.accepted) setTextDraft('')
      else setError('本轮输入未被接受，请检查当前状态。')
    } catch (cause) { if (!(cause instanceof Error && cause.message === '会话已结束')) setError(describeMediaError(cause)) }
    finally { setSendingText(false) }
  }

  const changePreferences = async (personaId: PersonaId, replyLanguage: ReplyLanguage) => {
    setPreferenceNote('正在切换设置…')
    try {
      const next = await window.deskai.updatePreferences({ personaId, replyLanguage })
      setPreferences(next)
      setPreferenceNote('设置已保存；后续回复生效。切换人格不会重写旧会话提示词。')
    } catch (cause) { setError(describeMediaError(cause)); setPreferenceNote('') }
  }

  const changeSetting = async (patch: Partial<Preferences>) => {
    setPreferenceNote('正在保存设置…')
    try {
      const next = await window.deskai.updatePreferences(patch)
      setPreferences(next)
      outputRef.current?.player.setVolume(next.volume)
      if ('outputDeviceId' in patch && outputRef.current) {
        const context = outputRef.current.context as AudioContext & { setSinkId?: (id: string) => Promise<void> }
        if (!context.setSinkId) throw new Error('当前不支持应用内选择输出，请使用 Windows 声音设置。')
        await context.setSinkId(next.outputDeviceId)
      }
      setPreferenceNote('设置已保存。输入设备在下次开启麦克风时生效。')
      if ('voiceId' in patch || 'referenceId' in patch) {
        const info = await window.deskai.getRuntime(); setRuntime(info)
      }
    } catch (cause) { setError(describeMediaError(cause)); setPreferenceNote('设置未完成，请检查提示') }
  }

  const cancelTurn = async () => {
    try { await window.deskai.cancelTurn() }
    catch (cause) { setError(describeMediaError(cause)) }
  }

  const retryTurn = async () => {
    setError('')
    setRetryable(false)
    try {
      const result = await window.deskai.retryTurn()
      if (!result.accepted) setError('当前没有可重试的回复，或模型服务仍不可用。')
    } catch (cause) { setError(describeMediaError(cause)); setRetryable(true) }
  }

  const voices = runtime?.voices ?? []
  const selectedVoice = voices.find(voice => voice.id === preferences?.voiceId)
  const selectedVoiceName = selectedVoice?.name ?? '常态有希 · v2'
  const ttsLabel = ({ starting: '正在启动', loading: '正在加载模型', warming: '正在预热', switching: '正在切换声音', ready: '已就绪', error: '出错，可恢复', stopped: '已停止' } as Record<string, string>)[ttsState.split(' · ')[0]] ?? ttsState
  const inputLabel = ({ OFF: '未开启', LISTENING: '等待你说话', CAPTURING: '正在收音', TRANSCRIBING: '正在识别', ACCUMULATING: '等待续句', DECIDING: '正在提交' } as Record<string, string>)[inputState] ?? inputState

  return <main className="shell">
    <header><div><h1>DeskAI 语音对话</h1><p>当前声音：{selectedVoiceName}</p></div><span className="stage">桌面预览版</span></header>
    <section className="summary" aria-live="polite">
      <div><small>语音服务</small><strong>{serviceState}</strong></div>
      <div><small>麦克风</small><strong>{captureState}</strong></div>
      <div><small>输入状态</small><strong>{inputLabel}</strong></div>
      <div><small>播放</small><strong>{playback}</strong></div>
    </section>
    <section className="preferences" aria-label="对话设置">
      <label>角色声音<select value={preferences?.voiceId ?? 'nagato-normal-v2'} disabled={!voices.length || starting} onChange={event => void changeSetting({ voiceId: event.target.value, referenceId: '' })}>
        {voices.length ? voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>) : <option value="nagato-normal-v2">常态有希 v2</option>}
      </select></label>
      <label>参考语气<select value={preferences?.referenceId || selectedVoice?.defaultReferenceId || ''} disabled={!selectedVoice || starting} onChange={event => void changeSetting({ referenceId: event.target.value })}>
        {(selectedVoice?.references ?? []).map(ref => <option key={ref.id} value={ref.id}>{ref.name}</option>)}
      </select></label>
      <label>人格风格<select value={preferences?.personaId ?? 'nagato-normal-light'} onChange={event => void changePreferences(event.target.value as PersonaId, preferences?.replyLanguage ?? 'auto')}>
        {(runtime?.personas ?? [{ id: 'nagato-normal-light' as PersonaId, displayName: '常态有希 · 轻量风格', revision: 1 }, { id: 'assistant-neutral' as PersonaId, displayName: '普通助手', revision: 1 }]).map(persona => <option key={persona.id} value={persona.id}>{persona.displayName}</option>)}
      </select></label>
      <label>回复语言<select value={preferences?.replyLanguage ?? 'auto'} onChange={event => void changePreferences(preferences?.personaId ?? 'nagato-normal-light', event.target.value as ReplyLanguage)}>
        <option value="auto">自动跟随</option><option value="zh">中文</option><option value="ja">日语</option><option value="en">英语</option>
      </select></label>
      <span>模型：{modelState === 'waiting' ? '等待续句' : modelState === 'silent' ? '本轮保持安静' : modelState === 'generating' ? '正在回复' : modelState === 'cancelling' ? '正在停止' : modelState === 'error' ? '回复出错' : '空闲'}</span>
    </section>
    {preferenceNote && <p className="hint">{preferenceNote}</p>}
    <details className="settings"><summary>声音与设备设置 · 合成服务：{ttsLabel}</summary>
      <div className="preferences">
        <label>输入设备<select value={preferences?.inputDeviceId ?? ''} onChange={event => void changeSetting({ inputDeviceId: event.target.value })}>
          <option value="">系统默认麦克风</option>{devices.filter(device => device.kind === 'audioinput' && device.deviceId !== 'default').map((device, i) => <option key={device.deviceId || i} value={device.deviceId}>{device.label || `输入设备 ${i + 1}`}</option>)}
        </select></label>
        <label>输出设备<select value={preferences?.outputDeviceId ?? ''} onChange={event => void changeSetting({ outputDeviceId: event.target.value })}>
          <option value="">系统默认扬声器</option>{devices.filter(device => device.kind === 'audiooutput' && device.deviceId !== 'default').map((device, i) => <option key={device.deviceId || i} value={device.deviceId}>{device.label || `输出设备 ${i + 1}`}</option>)}
        </select></label>
        <label>音量 {Math.round((preferences?.volume ?? 0.8) * 100)}%<input aria-label="音量" type="range" min="0" max="1" step="0.05" value={preferences?.volume ?? 0.8} onChange={event => void changeSetting({ volume: Number(event.target.value) })} /></label>
        <label>语速<select value={preferences?.speed ?? 1} onChange={event => void changeSetting({ speed: Number(event.target.value) })}>
          {[0.6, 0.8, 1, 1.2, 1.4, 1.6].map(value => <option key={value} value={value}>{value}×</option>)}
        </select></label>
        <label>关闭主窗口<select value={String(preferences?.closeToTray ?? true)} onChange={event => void changeSetting({ closeToTray: event.target.value === 'true' })}>
          <option value="true">隐藏到托盘（会话继续）</option><option value="false">退出并释放服务</option>
        </select></label>
        <button className="secondary" onClick={() => void window.deskai.retrySpeech().then(() => window.deskai.getRuntime()).then(setRuntime).catch(cause => setError(describeMediaError(cause)))}>恢复语音服务</button>
      </div>
      <p>声音、人格、语言分别设置。系统睡眠会结束会话；恢复后请重新开启。设备名称需麦克风授权后才可能显示。</p>
    </details>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="conversation" aria-label="对话记录">
      {entries.length === 0 ? <p className="empty">可直接输入文字开始对话，或点击“开始语音对话”自动监听和识别。</p> : entries.map(entry => <div className={`entry ${entry.role}`} data-attempt-id={entry.attemptId} key={entry.id}><small>{entry.role === 'user' ? '你' : entry.role === 'assistant' ? `助手${entry.interrupted ? ' · 已中断' : ''}` : '轮次状态'}</small><p>{entry.text}</p></div>)}
    </section>
    <form className="text-entry" onSubmit={event => { event.preventDefault(); void sendText() }}>
      <input value={textDraft} onChange={event => setTextDraft(event.target.value)} maxLength={4000} placeholder="输入文字，不需要开启麦克风" aria-label="文字输入" />
      <button type="submit" disabled={!textDraft.trim() || sendingText}>发送</button>
    </form>
    <nav className="actions">
      {captureRef.current && <button className="secondary" onClick={() => void pauseCapture()}>暂停麦克风</button>}
      {captureRef.current ? <button onClick={() => void stop()}>结束对话</button>
        : starting ? <button onClick={() => void stop()}>取消准备</button>
          : <button onClick={() => void start()}>开始语音对话</button>}
      {session && !starting && <button className="secondary" onClick={() => void stop()}>结束会话</button>}
      <button className="secondary" onClick={() => void cancelTurn()} disabled={!session}>停止回复</button>
      <button className="secondary" onClick={() => void retryTurn()} disabled={!retryable}>重试回复</button>
    </nav>
    <p className="hint">开始语音对话后自动监听；识别文字经 dsh 发送至所选模型服务，原音频在本机处理。等待或安静时仅更新状态。</p>
    <p className="hint">有效回复逐句播放；合成故障保留文字。播放进度是声卡提交估计；真实麦克风、外放回声效果仍需设备验收。</p>
    <details><summary>技术设置与诊断</summary><p>会话：{session?.sessionId ?? '无'} · 运行模式：{runtime?.fakeMedia ? '模拟设备' : '普通设备'}</p>
      {!!runtime?.assetStatus?.missing.length && <p>缺少本地资源：{runtime.assetStatus.missing.join('、')}</p>}
      <p>浏览器实际麦克风设置（仅供诊断，不代表物理 AEC 验收）：</p><pre>{mediaSettings ? JSON.stringify(mediaSettings, null, 2) : '未获取'}</pre></details>
  </main>
}
