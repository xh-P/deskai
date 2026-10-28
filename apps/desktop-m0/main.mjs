import { app, BrowserWindow, ipcMain, session } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(appDir, '../..');
const indexFile = path.join(appDir, 'index.html');
const outputDir = path.join(projectRoot, 'outputs', 'desktop-validation', 'm0');
const isSmoke = process.argv.includes('--smoke');
const hasFakeMedia = process.argv.includes('--use-fake-device-for-media-stream');
const hasFakePermission = process.argv.includes('--use-fake-ui-for-media-stream');

if (isSmoke && (!hasFakeMedia || !hasFakePermission)) {
  console.error('M0 smoke requires --use-fake-device-for-media-stream and --use-fake-ui-for-media-stream.');
  app.exit(2);
}

if (isSmoke) {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}

let mainWindow;
let smokeFinished = false;

function isTrustedFrame(event) {
  try {
    const frameUrl = new URL(event.senderFrame?.url ?? '');
    return frameUrl.protocol === 'file:' &&
      path.resolve(fileURLToPath(frameUrl)) === path.resolve(indexFile);
  } catch {
    return false;
  }
}

function requireTrustedFrame(event) {
  if (!isTrustedFrame(event)) {
    throw new Error('Request rejected: untrusted renderer frame.');
  }
}

function finiteNumber(value, fallback = null) {
  return Number.isFinite(value) ? value : fallback;
}

function safeSettings(settings) {
  if (!settings || typeof settings !== 'object') return {};
  const allowedKeys = [
    'sampleRate', 'channelCount', 'latency', 'echoCancellation',
    'noiseSuppression', 'autoGainControl', 'voiceIsolation'
  ];
  return Object.fromEntries(allowedKeys
    .filter((key) => ['number', 'boolean'].includes(typeof settings[key]))
    .map((key) => [key, settings[key]]));
}

function sanitizeReport(input, testResult = undefined) {
  if (!input || typeof input !== 'object') {
    throw new Error('A metadata report is required.');
  }

  const report = {
    schemaVersion: 1,
    mode: input.simulated === true ? 'simulation' : 'device-validation',
    simulated: input.simulated === true,
    smoke: input.smoke === true,
    startedAt: typeof input.startedAt === 'string' ? input.startedAt : null,
    stoppedAt: typeof input.stoppedAt === 'string' ? input.stoppedAt : new Date().toISOString(),
    runtime: {
      electron: process.versions.electron ?? null,
      chromium: process.versions.chrome ?? null,
      platform: process.platform
    },
    requestedConstraints: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false
    },
    input: {
      sampleRate: finiteNumber(input.input?.sampleRate),
      channelCount: finiteNumber(input.input?.channelCount),
      frames: finiteNumber(input.input?.frames, 0),
      sampleCount: finiteNumber(input.input?.sampleCount, 0),
      rms: finiteNumber(input.input?.rms),
      peak: finiteNumber(input.input?.peak),
      trackSettings: safeSettings(input.input?.trackSettings)
    },
    output: {
      sampleRate: finiteNumber(input.output?.sampleRate),
      format: 'float32-pcm',
      pcmFrames: finiteNumber(input.output?.pcmFrames, 0),
      renderFrames: finiteNumber(input.output?.renderFrames, 0),
      rms: finiteNumber(input.output?.rms),
      peak: finiteNumber(input.output?.peak),
      frequencyHz: finiteNumber(input.output?.frequencyHz),
      inputFramesDuringPlayback: finiteNumber(input.output?.inputFramesDuringPlayback, 0),
      overlapped: input.output?.inputFramesDuringPlayback > 0
    }
  };

  if (testResult) {
    report.test = {
      passed: testResult.passed === true,
      checks: testResult.checks && typeof testResult.checks === 'object'
        ? Object.fromEntries(Object.entries(testResult.checks)
          .filter(([, value]) => typeof value === 'boolean'))
        : {},
      note: 'Fake-media simulation only; this result does not validate physical devices or acoustic echo cancellation.'
    };
  }

  return report;
}

async function writeReport(input, testResult = undefined) {
  const report = sanitizeReport(input, testResult);
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const suffix = report.smoke ? 'smoke' : report.simulated ? 'simulation' : 'device';
  const filename = `audio-${suffix}-${stamp}.json`;
  await writeFile(path.join(outputDir, filename), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { filename, relativePath: path.relative(projectRoot, path.join(outputDir, filename)) };
}

ipcMain.handle('audio-m0:get-runtime', (event) => {
  requireTrustedFrame(event);
  return {
    smoke: isSmoke,
    fakeMedia: hasFakeMedia,
    fakePermission: hasFakePermission
  };
});

ipcMain.handle('audio-m0:save-report', async (event, report) => {
  requireTrustedFrame(event);
  if (isSmoke) throw new Error('Smoke reports are saved with the smoke result.');
  return writeReport(report);
});

ipcMain.handle('audio-m0:finish-smoke', async (event, payload) => {
  requireTrustedFrame(event);
  if (!isSmoke || !hasFakeMedia || !hasFakePermission) {
    throw new Error('Smoke completion is only available with explicit fake-media flags.');
  }
  if (smokeFinished) throw new Error('Smoke run has already completed.');
  smokeFinished = true;
  const passed = payload?.passed === true;
  const saved = await writeReport(payload?.report, {
    passed,
    checks: payload?.checks
  });
  console.log(`M0 smoke report: ${saved.relativePath}`);
  app.exit(passed ? 0 : 1);
  return saved;
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const isLocalPage = webContents.getURL().startsWith(pathToFileURL(indexFile).href);
    const requestedMedia = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    const microphoneOnly = permission === 'media' &&
      requestedMedia.includes('audio') &&
      requestedMedia.every((mediaType) => mediaType === 'audio');
    callback(isLocalPage && microphoneOnly);
  });

  mainWindow = new BrowserWindow({
    width: 920,
    height: 780,
    minWidth: 720,
    minHeight: 620,
    show: !isSmoke,
    autoHideMenuBar: true,
    title: isSmoke ? '音频链路模拟验收' : 'M0 音频设备验证',
    webPreferences: {
      preload: path.join(appDir, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, destination) => {
    try {
      const target = new URL(destination);
      if (target.protocol !== 'file:' || path.resolve(fileURLToPath(target)) !== path.resolve(indexFile)) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.loadFile(indexFile);
});

app.on('window-all-closed', () => {
  app.quit();
});
