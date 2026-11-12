import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadTtsRuntime } from '../../packages/tts-adapter/src/runtime.ts';
import { buildDesktop, root } from './build.mjs';

const { values: { smoke: audioSmoke, 'dialogue-smoke': dialogueSmoke, 'tts-smoke': ttsSmoke,
  'pet-smoke': petSmoke, 'real-model': realModel, 'with-live2d': withLive2D, 'input-wav': inputWav } } = parseArgs({ options: {
  smoke: { type: 'boolean' }, 'dialogue-smoke': { type: 'boolean' }, 'tts-smoke': { type: 'boolean' },
  'pet-smoke': { type: 'boolean' }, 'real-model': { type: 'boolean' }, 'with-live2d': { type: 'boolean' }, 'input-wav': { type: 'string' },
} });
const modes = [audioSmoke, dialogueSmoke, ttsSmoke, petSmoke].filter(Boolean);
if (modes.length > 1 || (realModel || withLive2D) && !ttsSmoke) throw new Error('请选择一个冒烟模式。--real-model 和 --with-live2d 用于 TTS 冒烟。');
const smoke = modes.length === 1;
const audioInput = !!(audioSmoke || ttsSmoke);
if (audioInput !== !!inputWav) throw new Error('音频和 TTS 冒烟需要 --input-wav <音频路径>。');
const source = inputWav ? path.resolve(inputWav) : undefined;
if (source) await access(source);
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
try { await access(electronExe); }
catch { throw new Error('Electron 二进制未安装。请先运行 npm exec --no -- install-electron。'); }
await buildDesktop();
const args = [path.join(root, '.cache/desktop-main/apps/desktop/src/main.js')];
const env = { ...process.env, DESKAI_PROJECT_ROOT: root, DESKAI_NODE_EXECUTABLE: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const fixture = source ? path.join(root, '.cache', `smoke-${randomUUID()}.wav`) : undefined;
let timer;
try {
  if (source && fixture) {
    const { ffmpeg } = await loadTtsRuntime(root, path.resolve(env.DESKAI_ASSET_ROOT ?? root));
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ['-v', 'error', '-i', source,
        '-fflags', '+bitexact', '-af', `adelay=3000,apad=pad_dur=${ttsSmoke ? 45 : 5}`, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', fixture],
        { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let error = '';
      child.stderr.on('data', chunk => { error = (error + chunk).slice(-1000); });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Smoke fixture conversion failed: ' + error)));
    });
    args.push(`--use-file-for-fake-audio-capture=${fixture}`);
    env.DESKAI_AUDIO_SMOKE_WAV = source;
  }
  if (smoke && !petSmoke) args.push('--smoke', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio');
  if (petSmoke) args.push('--pet-smoke', '--mute-audio');
  if (dialogueSmoke) args.push('--dialogue-smoke');
  if (ttsSmoke) args.push('--tts-smoke');
  if (realModel) args.push('--real-model');
  if (withLive2D) args.push('--with-live2d');
  const child = spawn(electronExe, args, { cwd: root, env, stdio: 'inherit', windowsHide: smoke });
  if (smoke) timer = setTimeout(() => {
    if (child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }, ttsSmoke ? 300_000 : petSmoke ? 90_000 : 180_000);
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
} finally {
  clearTimeout(timer);
  if (fixture) await rm(fixture, { force: true });
}
