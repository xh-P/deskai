const $ = (id) => document.getElementById(id);

const elements = {
  status: $('status-pill'),
  note: $('device-note'),
  inputDevice: $('input-device'),
  outputDevice: $('output-device'),
  actualDevice: $('actual-device'),
  trackSettings: $('track-settings'),
  contextRate: $('context-rate'),
  inputFrames: $('input-frames'),
  inputRms: $('input-rms'),
  outputFrames: $('output-frames'),
  outputRms: $('output-rms'),
  overlapFrames: $('overlap-frames'),
  reportPath: $('report-path'),
  start: $('start-button'),
  stop: $('stop-button'),
  play: $('play-button'),
  refresh: $('refresh-button'),
  simulationBanner: $('simulation-banner')
};

const state = {
  runtime: { smoke: false, fakeMedia: false, fakePermission: false },
  stream: null,
  track: null,
  context: null,
  captureNode: null,
  playerNode: null,
  sourceNode: null,
  mutedNode: null,
  trackSettings: null,
  startedAt: null,
  active: false,
  outputPlaying: false,
  playbackStartedAt: null,
  metrics: null,
  playbackResolver: null
};

function emptyMetrics() {
  return {
    inputFrames: 0,
    inputSampleCount: 0,
    inputRms: 0,
    inputPeak: 0,
    outputPcmFrames: 0,
    outputRenderFrames: 0,
    outputRms: 0,
    outputPeak: 0,
    inputFramesDuringPlayback: 0,
    playbackCount: 0
  };
}

function setStatus(message, phase = 'idle') {
  elements.status.textContent = message;
  elements.status.dataset.state = phase;
}

function formatNumber(value, places = 3) {
  return Number.isFinite(value) ? value.toFixed(places) : '—';
}

function updateMetrics() {
  const metrics = state.metrics ?? emptyMetrics();
  elements.contextRate.textContent = state.context ? `${state.context.sampleRate} Hz` : '—';
  elements.inputFrames.textContent = metrics.inputFrames.toLocaleString('zh-CN');
  elements.inputRms.textContent = metrics.inputSampleCount ? formatNumber(metrics.inputRms) : '—';
  elements.outputFrames.textContent = metrics.outputPcmFrames.toLocaleString('zh-CN');
  elements.outputRms.textContent = metrics.outputPcmFrames ? formatNumber(metrics.outputRms) : '—';
  elements.overlapFrames.textContent = metrics.inputFramesDuringPlayback.toLocaleString('zh-CN');
}

function replaceDeviceOptions(select, devices, kind, previousValue) {
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '系统默认';
  select.replaceChildren(placeholder);

  devices.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `${kind} ${index + 1}`;
    select.append(option);
  });

  if ([...select.options].some((option) => option.value === previousValue)) {
    select.value = previousValue;
  } else {
    select.value = '';
  }
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    elements.note.textContent = '当前 Chromium 环境不支持 enumerateDevices。';
    return;
  }

  const previousInput = elements.inputDevice.value;
  const previousOutput = elements.outputDevice.value;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    replaceDeviceOptions(elements.inputDevice, devices.filter((device) => device.kind === 'audioinput'), '输入设备', previousInput);
    replaceDeviceOptions(elements.outputDevice, devices.filter((device) => device.kind === 'audiooutput'), '输出设备', previousOutput);
    if (!state.active) {
      elements.note.textContent = devices.some((device) => device.label)
        ? '设备列表已刷新。麦克风只会在点击“开始设备验证”后启动。'
        : '设备列表已刷新。部分设备名称会在授予麦克风权限后显示。';
    }
  } catch (error) {
    elements.note.textContent = `设备列表读取失败：${error.message}`;
  }
}

function renderTrackSettings() {
  elements.actualDevice.textContent = state.track
    ? `${state.track.label || '浏览器未返回设备名称'} · ${state.trackSettings?.channelCount ?? '未知'} 声道 · ${state.trackSettings?.sampleRate ?? '未知'} Hz`
    : '尚未采集';
  elements.trackSettings.textContent = state.trackSettings
    ? JSON.stringify(state.trackSettings, null, 2)
    : '开始验证后显示实际值。';
}

function onCaptureMessage(message) {
  if (message.type !== 'capture-stats' || !state.metrics) return;
  const previousFrames = state.metrics.inputFrames;
  const nextFrames = Math.max(previousFrames, Number(message.frames) || 0);
  const delta = nextFrames - previousFrames;
  if (state.outputPlaying) state.metrics.inputFramesDuringPlayback += delta;
  state.metrics.inputFrames = nextFrames;
  state.metrics.inputSampleCount = Number(message.sampleCount) || 0;
  state.metrics.inputRms = Number(message.rms) || 0;
  state.metrics.inputPeak = Number(message.peak) || 0;
  updateMetrics();
}

function onOutputMessage(message) {
  if (!state.metrics) return;
  if (message.type === 'playback-started') {
    state.outputPlaying = true;
    state.playbackStartedAt = performance.now();
    state.metrics.playbackCount += 1;
    elements.note.textContent = 'PCM 测试音正在输出；麦克风采集保持开启。';
    return;
  }

  if (message.type === 'playback-finished') {
    state.outputPlaying = false;
    state.metrics.outputPcmFrames = Number(message.pcmFrames) || 0;
    state.metrics.outputRenderFrames = Number(message.renderFrames) || 0;
    state.metrics.outputRms = Number(message.rms) || 0;
    state.metrics.outputPeak = Number(message.peak) || 0;
    elements.note.textContent = 'PCM 输出完成。采集链路仍在运行。';
    updateMetrics();
    const resolve = state.playbackResolver;
    state.playbackResolver = null;
    if (resolve) resolve();
    return;
  }

  if (message.type === 'playback-stopped') {
    state.outputPlaying = false;
  }
}

async function startVerification() {
  if (state.active) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    throw new Error('getUserMedia 或 AudioWorklet 不可用。');
  }

  elements.start.disabled = true;
  setStatus('正在请求设备', 'active');
  elements.note.textContent = '请在系统权限提示中允许麦克风访问。';
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false
  };
  if (elements.inputDevice.value) audio.deviceId = { exact: elements.inputDevice.value };

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    state.track = state.stream.getAudioTracks()[0];
    if (!state.track) throw new Error('浏览器没有返回音频 track。');
    state.trackSettings = state.track.getSettings();
    state.startedAt = new Date().toISOString();
    state.metrics = emptyMetrics();
    state.active = true;
    renderTrackSettings();

    state.context = new AudioContext({ latencyHint: 'interactive' });
    await state.context.resume();
    if (elements.outputDevice.value && typeof state.context.setSinkId === 'function') {
      await state.context.setSinkId(elements.outputDevice.value);
    } else if (elements.outputDevice.value) {
      elements.note.textContent = '当前 Chromium 不支持 AudioContext.setSinkId；PCM 将输出到系统默认设备。';
    }

    await state.context.audioWorklet.addModule(new URL('./audio-worklet.js', window.location.href));
    state.captureNode = new AudioWorkletNode(state.context, 'm0-capture-stats', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit'
    });
    state.playerNode = new AudioWorkletNode(state.context, 'm0-pcm-output', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    state.captureNode.port.onmessage = (event) => onCaptureMessage(event.data);
    state.playerNode.port.onmessage = (event) => onOutputMessage(event.data);
    state.captureNode.onprocessorerror = () => setStatus('采集 Worklet 错误', 'error');
    state.playerNode.onprocessorerror = () => setStatus('播放 Worklet 错误', 'error');

    state.sourceNode = state.context.createMediaStreamSource(state.stream);
    state.mutedNode = state.context.createGain();
    state.mutedNode.gain.value = 0;
    state.sourceNode.connect(state.captureNode);
    state.captureNode.connect(state.mutedNode);
    state.mutedNode.connect(state.context.destination);
    state.playerNode.connect(state.context.destination);

    elements.inputDevice.disabled = true;
    elements.outputDevice.disabled = true;
    elements.start.disabled = true;
    elements.stop.disabled = false;
    elements.play.disabled = false;
    elements.refresh.disabled = true;
    setStatus('采集运行中', 'active');
    elements.note.textContent = '麦克风已开始采集；播放测试音时仍会继续采集。';
    elements.contextRate.textContent = `${state.context.sampleRate} Hz`;
    await refreshDevices();
  } catch (error) {
    await stopVerification({ saveReport: false });
    elements.start.disabled = false;
    elements.stop.disabled = true;
    elements.play.disabled = true;
    elements.refresh.disabled = false;
    setStatus('启动失败', 'error');
    elements.note.textContent = `无法开始验证：${error.message}`;
    throw error;
  }
}

function buildReport() {
  const trackSettings = state.trackSettings ?? {};
  const metrics = state.metrics ?? emptyMetrics();
  return {
    simulated: state.runtime.fakeMedia === true,
    smoke: state.runtime.smoke === true,
    startedAt: state.startedAt,
    stoppedAt: new Date().toISOString(),
    input: {
      sampleRate: Number(trackSettings.sampleRate) || state.context?.sampleRate || null,
      channelCount: Number(trackSettings.channelCount) || null,
      frames: metrics.inputFrames,
      sampleCount: metrics.inputSampleCount,
      rms: metrics.inputRms,
      peak: metrics.inputPeak,
      trackSettings
    },
    output: {
      sampleRate: state.context?.sampleRate || null,
      pcmFrames: metrics.outputPcmFrames,
      renderFrames: metrics.outputRenderFrames,
      rms: metrics.outputRms,
      peak: metrics.outputPeak,
      frequencyHz: 440,
      inputFramesDuringPlayback: metrics.inputFramesDuringPlayback
    }
  };
}

async function stopVerification({ saveReport = true } = {}) {
  const report = buildReport();
  state.playerNode?.port.postMessage({ type: 'stop' });
  state.sourceNode?.disconnect();
  state.captureNode?.disconnect();
  state.mutedNode?.disconnect();
  state.playerNode?.disconnect();
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
  }
  if (state.context && state.context.state !== 'closed') {
    await state.context.close().catch(() => {});
  }

  state.stream = null;
  state.track = null;
  state.context = null;
  state.captureNode = null;
  state.playerNode = null;
  state.sourceNode = null;
  state.mutedNode = null;
  state.trackSettings = null;
  state.active = false;
  state.outputPlaying = false;
  elements.inputDevice.disabled = false;
  elements.outputDevice.disabled = false;
  elements.start.disabled = false;
  elements.stop.disabled = true;
  elements.play.disabled = true;
  elements.refresh.disabled = false;
  renderTrackSettings();
  updateMetrics();
  setStatus('已停止', 'idle');

  if (saveReport && state.startedAt) {
    try {
      const saved = await window.audioM0.saveReport(report);
      elements.reportPath.textContent = `诊断摘要已保存：${saved.relativePath}（不含原始音频）`;
    } catch (error) {
      elements.reportPath.textContent = `诊断摘要保存失败：${error.message}`;
    }
  }
  state.startedAt = null;
  return report;
}

function playTestTone() {
  if (!state.active || !state.context || !state.playerNode) {
    return Promise.reject(new Error('请先开始设备验证。'));
  }
  if (state.outputPlaying) return Promise.reject(new Error('测试音正在播放。'));

  const sampleRate = state.context.sampleRate;
  const durationSeconds = 1;
  const samples = new Float32Array(sampleRate * durationSeconds);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = 0.18 * Math.sin(2 * Math.PI * 440 * index / sampleRate);
  }

  elements.play.disabled = true;
  const finished = new Promise((resolve) => { state.playbackResolver = resolve; });
  state.playerNode.port.postMessage({ type: 'play', samples }, [samples.buffer]);
  return finished.finally(() => {
    if (state.active) elements.play.disabled = false;
  });
}

function waitFor(predicate, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (performance.now() >= deadline) return reject(new Error(`等待${label}超时。`));
      window.setTimeout(poll, 50);
    };
    poll();
  });
}

async function runSmoke() {
  let report;
  try {
    await startVerification();
    await waitFor(() => (state.metrics?.inputFrames ?? 0) > 0, 8000, '输入帧');
    await playTestTone();
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    report = buildReport();
    const checks = {
      fakeMediaEnabled: state.runtime.fakeMedia,
      inputFramesObserved: report.input.frames > 0,
      inputRmsObserved: report.input.rms > 0,
      pcmOutputObserved: report.output.pcmFrames >= (report.output.sampleRate ?? 48000) * 0.95,
      captureContinuedDuringPlayback: report.output.inputFramesDuringPlayback > 0
    };
    const passed = Object.values(checks).every(Boolean);
    await stopVerification({ saveReport: false });
    await window.audioM0.finishSmoke({ passed, checks, report });
  } catch (error) {
    if (!report) report = buildReport();
    await stopVerification({ saveReport: false });
    try {
      await window.audioM0.finishSmoke({
        passed: false,
        checks: { smokeCompletedWithoutError: false },
        report,
        error: error.message
      });
    } catch (finishError) {
      elements.note.textContent = `模拟验收失败：${error.message}；无法提交结果：${finishError.message}`;
      setStatus('模拟验收失败', 'error');
    }
  }
}

elements.start.addEventListener('click', () => {
  startVerification().catch(() => {});
});
elements.stop.addEventListener('click', () => {
  stopVerification().catch((error) => {
    elements.note.textContent = `停止时发生错误：${error.message}`;
  });
});
elements.play.addEventListener('click', () => {
  playTestTone().catch((error) => { elements.note.textContent = error.message; });
});
elements.refresh.addEventListener('click', () => { void refreshDevices(); });
navigator.mediaDevices?.addEventListener?.('devicechange', () => { void refreshDevices(); });

async function initialize() {
  try {
    state.runtime = await window.audioM0.getRuntime();
    if (state.runtime.smoke) {
      elements.simulationBanner.hidden = false;
      elements.start.textContent = '模拟验收自动启动中';
      elements.start.disabled = true;
      elements.refresh.disabled = true;
      elements.note.textContent = '模拟验收使用 fake-media 自动开始；报告会标记为模拟结果。';
    }
    await refreshDevices();
    if (state.runtime.smoke) await runSmoke();
  } catch (error) {
    setStatus('初始化失败', 'error');
    elements.note.textContent = `初始化失败：${error.message}`;
  }
}

void initialize();
