import { spawn } from 'node:child_process'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const reportDirectory = join(root, 'outputs/desktop-validation/m1')
const previous = new Map(await Promise.all((await readdir(reportDirectory).catch(() => []))
  .filter(name => /^audio-smoke-.*\.json$/.test(name))
  .map(async name => [name, (await stat(join(reportDirectory, name))).mtimeMs])))
const child = spawn(process.execPath, [join(root, 'scripts/desktop/launch.mjs'), '--smoke'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
})
const exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject)
  child.once('exit', code => resolveExit(code ?? 1))
})

const names = (await readdir(reportDirectory).catch(() => [])).filter(name => /^audio-smoke-.*\.json$/.test(name))
const candidates = await Promise.all(names.map(async name => ({ name, info: await stat(join(reportDirectory, name)) })))
const current = candidates.filter(item => !previous.has(item.name) || item.info.mtimeMs > previous.get(item.name)).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)[0]
if (!current) throw new Error('本次 smoke 未生成报告；不能读取旧报告冒充通过。')
const raw = JSON.parse(await readFile(join(reportDirectory, current.name), 'utf8'))
const report = raw.report ?? raw
const onsetProcess = spawn(join(root, '.conda/gsv-v5/python.exe'), [join(root, 'scripts/desktop/check-onset.py')], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
})
let onsetText = ''
onsetProcess.stdout.on('data', bytes => { onsetText += bytes.toString() })
const onsetCode = await new Promise((resolveCode, reject) => {
  onsetProcess.once('error', reject)
  onsetProcess.once('exit', resolveCode)
})
report.onsetAudio = onsetCode === 0 ? JSON.parse(onsetText) : { passed: false, error: 'Waveform comparison failed' }
report.passed = report.passed === true && report.onsetAudio.passed === true
await writeFile(join(reportDirectory, current.name), JSON.stringify(raw, null, 2))
if (report.simulated !== true) throw new Error('smoke 报告必须明确标记 simulated=true。')
const fields = ['vadInitialized', 'asrTranscriptSeen', 'transcriptRendered', 'inputDuringPlayback']
const failed = fields.filter(field => report[field] !== true)
if (exitCode !== 0 || failed.length || report.passed !== true) {
  throw new Error(`M1 模拟音频链路未通过：进程退出码 ${exitCode}；未达项 ${failed.join(', ') || '无'}。报告：${join(reportDirectory, current.name)}`)
}
console.log(`M1 模拟链路通过（不代表物理麦克风或 AEC）：${join(reportDirectory, current.name)}`)
