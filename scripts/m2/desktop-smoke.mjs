import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const reportDirectory = join(root, 'outputs/desktop-validation/m2')
const filename = /^desktop-smoke-.*\.json$/u
const previous = new Map(await Promise.all((await readdir(reportDirectory).catch(() => []))
  .filter(name => filename.test(name)).map(async name => [name, (await stat(join(reportDirectory, name))).mtimeMs])))
const child = spawn(process.execPath, [join(root, 'scripts/desktop/launch.mjs'), '--dialogue-smoke'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
})
const exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject)
  child.once('exit', code => resolveExit(code ?? 1))
})
const candidates = await Promise.all((await readdir(reportDirectory).catch(() => []))
  .filter(name => filename.test(name)).map(async name => ({ name, info: await stat(join(reportDirectory, name)) })))
const current = candidates.filter(item => !previous.has(item.name) || item.info.mtimeMs > previous.get(item.name))
  .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)[0]
if (!current) throw new Error('本次 M2 smoke 未生成新报告；不能读取旧报告冒充通过。')
const path = join(reportDirectory, current.name)
const report = JSON.parse(await readFile(path, 'utf8'))
const required = ['headerHidden', 'waitSilentNoBubble', 'textQuestionDisplayed', 'shortAnswerWorked',
  'retryWorked', 'cancelWorked', 'preferencesIndependent', 'noMicrophoneOpened']
const failed = required.filter(key => report.checks?.[key] !== true)
if (exitCode !== 0 || report.simulated !== true || report.passed !== true || report.microphoneFrames !== 0 ||
    report.requests?.length !== 7 || failed.length) {
  throw new Error(`M2 本地界面回放未通过：退出码 ${exitCode}，未达项 ${failed.join(', ') || '无'}。报告：${path}`)
}
console.log(`M2 本地界面回放通过（模拟模型，未验证真实设备）：${path}`)
