import { access, copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'

const project = path.resolve(import.meta.dirname, '../..')
const core = path.join(project, '.cache/live2d/live2dcubismcore.min.js')
const bundle = path.join(project, 'apps/desktop/models/live2d/nagato-uniform-review')
const publicDir = path.join(project, '.cache/nagato-preview/public')

try { await access(core) }
catch { throw new Error('请先运行 npm run desktop:prepare-live2d。') }
await mkdir(publicDir, { recursive: true })
const entry = 'nagato-uniform-review.model3.json'
const { FileReferences: refs } = JSON.parse(await readFile(path.join(bundle, entry), 'utf8'))
const files = [entry, refs.Moc, ...refs.Textures, refs.Physics, refs.DisplayInfo,
  ...refs.Expressions.map(expression => expression.File),
  ...Object.values(refs.Motions).flat().map(motion => motion.File)]
await Promise.all([
  copyFile(core, path.join(publicDir, 'core.js')),
  ...files.map(async file => {
    const target = path.join(publicDir, 'model', file)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(path.join(bundle, file), target)
  }),
])

const server = await createServer({
  root: path.join(import.meta.dirname, 'nagato-preview'),
  publicDir,
  configFile: false,
  server: { host: '127.0.0.1', port: 5179 },
})
await server.listen()
server.printUrls()
