import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const git = promisify(execFile)
const root = path.resolve(import.meta.dirname, '../..')
const { revision, files } = JSON.parse(await readFile(path.join(root, 'services/asr/amadeus-runtime.json'), 'utf8'))
const target = path.join(root, '.cache/amadeus-qwen', revision)
const ready = path.join(target, '.ready')
const installed = await Promise.all([access(ready), ...files.map(file => access(path.join(target, file)))])
  .then(() => true, () => false)
if (!installed) {
  const checkout = path.join(root, '.cache/amadeus-source')
  const sources = await Promise.all(files.map(async file => {
    const cached = await git('git', ['-C', checkout, 'show', `${revision}:${file}`],
      { encoding: 'buffer', windowsHide: true, timeout: 30_000 }).catch(() => undefined)
    if (cached) return [file, cached.stdout]
    const url = `https://raw.githubusercontent.com/Code-Amadeus/Amadeus/${revision}/${file}`
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`Amadeus ASR source ${file}: HTTP ${response.status}`)
    return [file, new Uint8Array(await response.arrayBuffer())]
  }))
  await Promise.all(sources.map(async ([file, content]) => {
    const destination = path.join(target, file)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, content)
  }))
  await writeFile(ready, revision + '\n')
}
console.log(`Amadeus Qwen inference source ${revision.slice(0, 7)} ready`)
