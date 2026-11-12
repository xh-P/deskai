import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const config = JSON.parse(await readFile(path.join(root, 'config/live2d-models.json'), 'utf8'))
const cache = path.join(root, '.cache/live2d-prepare')
const destination = path.join(root, '.cache/live2d')
await mkdir(cache, { recursive: true })
await mkdir(destination, { recursive: true })

async function verified(file, url, sha256) {
  const hash = async filename => createHash('sha256').update(await readFile(filename)).digest('hex')
  if (await hash(file).catch(() => '') === sha256) return
  const partial = `${file}.${process.pid}.tmp`
  execFileSync('curl.exe', ['-fLsS', '--connect-timeout', '15', '--max-time', '120', '-o', partial, url], { stdio: 'inherit', windowsHide: true })
  if (await hash(partial) !== sha256) throw new Error(`校验失败 ${url}`)
  await rename(partial, file)
}

const revision = config.samples.revision
const coreName = 'live2dcubismcore.min.js'
const core = path.join(cache, coreName)
const archive = path.join(cache, 'samples.zip')
await Promise.all([
  verified(core, config.core.url, config.core.sha256),
  verified(archive, `https://codeload.github.com/Live2D/CubismWebSamples/zip/${revision}`, config.samples.sha256),
])
const sources = [...new Set(config.samples.models.map(model => model.file.split('/')[0]))]
  .map(folder => `CubismWebSamples-${revision}/Samples/Resources/${folder}`)
execFileSync('tar', ['-xf', archive, '-C', destination, '--strip-components', '3', ...sources], { stdio: 'inherit', windowsHide: true })
await copyFile(core, path.join(destination, coreName))
console.log(`已准备 ${config.core.version} 和 ${sources.length} 个本地样例。 ${destination}`)
