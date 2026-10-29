import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildDesktop, root } from './build.mjs';

const dialogueSmoke = process.argv.includes('--dialogue-smoke');
const ttsSmoke = process.argv.includes('--tts-smoke');
const smoke = process.argv.includes('--smoke') || dialogueSmoke || ttsSmoke;
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
try { await access(electronExe); }
catch { throw new Error('Electron 二进制未安装。请先运行 npm exec --no -- install-electron。'); }
await buildDesktop();
const args = [path.join(root, '.cache/desktop-main/apps/desktop/src/main.js')];
if (smoke && !dialogueSmoke) {
  const source = path.join(root, 'outputs/nagato_normal_v5_bilingual_candidates/20261025-154215-bilingual-candidates/zh_v2_normal.wav');
  const target = path.join(root, '.cache/desktop-smoke/input.wav');
  await mkdir(path.dirname(target), { recursive: true });
  // Use the bundled ffmpeg for a genuine 16k conversion and explicit silence.
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'runtime/ffmpeg/bin/ffmpeg.exe'), ['-y', '-v', 'error', '-i', source,
      '-fflags', '+bitexact', '-af', `adelay=3000,apad=pad_dur=${ttsSmoke ? 45 : 5}`, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', target],
      { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-1000); });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Smoke fixture conversion failed: ' + error)));
  });
  args.push(`--use-file-for-fake-audio-capture=${target}`);
}
if (smoke) args.push('--smoke', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio');
if (dialogueSmoke) args.push('--dialogue-smoke');
if (ttsSmoke) args.push('--tts-smoke');
if (ttsSmoke && process.argv.includes('--real-model')) args.push('--real-model');
const env = { ...process.env, DESKAI_PROJECT_ROOT: root, DESKAI_NODE_EXECUTABLE: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronExe, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
let timer;
if (smoke) timer = setTimeout(() => {
  if (child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}, ttsSmoke ? 300_000 : 180_000);
child.once('error', error => { if (timer) clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { if (timer) clearTimeout(timer); process.exitCode = code ?? 1; });
