import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const appPath = path.join(projectRoot, 'apps', 'desktop-m0');
const reportDir = path.join(projectRoot, 'outputs', 'desktop-validation', 'm0');

if (!process.argv.includes('--smoke')) {
  console.error('用法：node scripts/m0/audio-smoke.mjs --smoke');
  console.error('该命令会显式启用 Chromium fake-media，不访问真实麦克风。');
  process.exit(2);
}

try {
  await stat(electronExe);
} catch {
  console.error(`找不到 Electron：${electronExe}`);
  console.error('请先由项目依赖管理流程安装 package.json 中锁定的 Electron。');
  process.exit(2);
}

const child = spawn(electronExe, [
  appPath,
  '--smoke',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream'
], {
  cwd: projectRoot,
  stdio: 'inherit',
  windowsHide: true
});

const exitCode = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    child.kill();
    reject(new Error('Electron smoke 超过 45 秒未结束。'));
  }, 45_000);
  child.once('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once('exit', (code, signal) => {
    clearTimeout(timeout);
    if (signal) resolve(1);
    else resolve(code ?? 1);
  });
});

if (exitCode !== 0) {
  console.error(`Electron smoke 失败，退出码 ${exitCode}。`);
  process.exit(exitCode);
}

const names = (await readdir(reportDir)).filter((name) => /^audio-smoke-.*\.json$/i.test(name));
if (names.length === 0) {
  console.error(`Electron 已退出，但没有生成模拟报告：${reportDir}`);
  process.exit(1);
}

const candidates = await Promise.all(names.map(async (name) => ({
  name,
  modified: (await stat(path.join(reportDir, name))).mtimeMs
})));
candidates.sort((left, right) => right.modified - left.modified);
const reportPath = path.join(reportDir, candidates[0].name);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const valid = report.simulated === true &&
  report.smoke === true &&
  report.test?.passed === true &&
  report.input?.frames > 0 &&
  report.output?.pcmFrames > 0 &&
  report.output?.overlapped === true;

console.log(`模拟报告：${path.relative(projectRoot, reportPath)}`);
console.log(JSON.stringify({
  simulated: report.simulated,
  inputSampleRate: report.input.sampleRate,
  inputFrames: report.input.frames,
  inputRms: report.input.rms,
  outputSampleRate: report.output.sampleRate,
  outputPcmFrames: report.output.pcmFrames,
  inputFramesDuringPlayback: report.output.inputFramesDuringPlayback,
  passed: valid
}, null, 2));

if (!valid) {
  console.error('模拟报告未满足采集、PCM 输出和双工重叠检查。');
  process.exit(1);
}
