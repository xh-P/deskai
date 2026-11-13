import 'pixi.js/unsafe-eval'
import { Application, extensions } from 'pixi.js'
import { configureCubismSDK, Live2DModel, Live2DPlugin, MotionPreloadStrategy } from 'untitled-pixi-live2d-engine/cubism'
import modelLayers from '../../../apps/desktop/models/live2d/nagato-uniform-review/nagato-uniform-review.layers.json'
import { defaultLive2DStyle } from '../../../packages/desktop-pet/src/live2d.ts'
import { IdleMotion } from '../../../apps/desktop/renderer/src/live2d/idle-motion.ts'

extensions.add(Live2DPlugin)
configureCubismSDK({ memorySizeMB: 64 })

const get = id => document.getElementById(id)
const viewport = get('viewport')
const status = get('status')
const frames = [...document.querySelectorAll('[data-frame]')]
const axes = { yaw: 'ParamAngleX', pitch: 'ParamAngleY' }
const eyelids = ['ParamEyeLOpen', 'ParamEyeROpen']
const headControls = ['yaw', 'pitch']
const rig = modelLayers.idle
const smoothstep = x => x * x * (3 - 2 * x)

function restBounds(inner) {
  const core = inner.coreModel
  core.update()
  const boxes = []
  for (let i = 0; i < core.getDrawableCount(); i++) {
    if (core.getDrawableOpacity(i) > 0.01) boxes.push(inner.getDrawableBounds(i))
  }
  const x = Math.min(...boxes.map(box => box.x))
  const y = Math.min(...boxes.map(box => box.y))
  return {
    x, y,
    width: Math.max(...boxes.map(box => box.x + box.width)) - x,
    height: Math.max(...boxes.map(box => box.y + box.height)) - y,
  }
}

async function mount() {
  const app = new Application()
  await app.init({
    preference: 'webgl', resizeTo: viewport, backgroundAlpha: 0, antialias: true,
    autoDensity: true, resolution: Math.min(devicePixelRatio, 2),
  })
  viewport.append(app.canvas)
  const model = await Live2DModel.from('/model/nagato-uniform-review.model3.json', {
    autoUpdate: false, autoFocus: false, autoHitTest: false,
    // The review uses the same authored idle sampler as the desktop preview.
    idleMotionGroup: 'ManualPreview',
    motionPreload: MotionPreloadStrategy.NONE, checkMocConsistency: true,
    eyeBlink: false,
    textureOptions: { lod: 'full', preferCreateImageBitmap: false },
  })
  app.stage.addChild(model)
  const inner = model.internalModel
  const core = inner.coreModel
  const indices = new Map(Array.from({ length: core.getParameterCount() }, (_, index) =>
    [core.getParameterId(index).getString().s, index]))
  const required = [...Object.values(rig.tracks).flat(), 'ParamGlasses']
  if (required.some(id => !indices.has(id))) throw new Error('模型缺少审阅参数。')
  const write = (id, value) => core.setParameterValueByIndex(indices.get(id), value)
  const read = id => core.getParameterValueByIndex(indices.get(id))
  const idle = await IdleMotion.load(inner, [...indices.keys()], rig)
  const art = restBounds(inner)
  const crops = {
    full: art,
    upper: { ...art, y: art.y - art.height * 0.009, height: art.height * 0.603 },
    head: { ...art, y: art.y - art.height * 0.012, height: art.height * 0.36 },
    arm: { ...art, y: art.y + art.height * 0.218, height: art.height * 0.414 },
    legs: { ...art, y: art.y + art.height * 0.51, height: art.height * 0.49 },
  }
  let frame = 'full'
  let frameSize = ''
  let blinkStart = -Infinity
  let glasses = false
  let playing = true
  let scrub
  const idleButton = get('idle')
  const time = get('time')
  time.max = String(idle.duration)

  const layout = () => {
    const { width, height } = app.screen
    const crop = crops[frame]
    const scale = Math.min(width * 0.92 / crop.width, height * 0.96 / crop.height)
    model.scale.set(scale)
    model.position.set((width - crop.width * scale) / 2 - crop.x * scale,
      (height - crop.height * scale) / 2 - crop.y * scale)
  }
  inner.updateNaturalMovements = () => {
    idle.apply()
    for (const name of headControls) {
      const id = axes[name]
      write(id, read(id) + Number(get(name).value))
    }
  }
  inner.on('beforeModelUpdate', () => {
    write('ParamGlasses', Number(glasses))
    const elapsed = performance.now() - blinkStart
    if (elapsed < 285) {
      const open = elapsed < 100 ? 1 - smoothstep(elapsed / 100)
        : elapsed < 135 ? 0 : smoothstep((elapsed - 135) / 150)
      for (const id of eyelids) write(id, Math.min(read(id), open))
    }
  })

  for (const button of frames) button.onclick = () => {
    frame = button.dataset.frame
    for (const item of frames) item.setAttribute('aria-pressed', String(item === button))
    layout()
  }
  for (const name of headControls) get(name).oninput = () => {
    get(`${name}-value`).value = `${get(name).value}°`
  }
  get('blink').onclick = () => { blinkStart = performance.now() }
  get('glasses').onclick = () => {
    glasses = !glasses
    get('glasses').setAttribute('aria-pressed', String(glasses))
  }
  const syncPlayButton = () => {
    idleButton.setAttribute('aria-pressed', String(playing))
    idleButton.textContent = playing ? '暂停待机' : '播放待机'
  }
  idleButton.onclick = () => {
    scrub = playing ? idle.playhead : undefined
    playing = !playing
    syncPlayButton()
  }
  time.oninput = () => {
    scrub = Number(time.value)
    playing = false
    syncPlayButton()
  }
  get('reset').onclick = () => {
    playing = false
    scrub = 0
    syncPlayButton()
    for (const name of headControls) {
      get(name).value = 0
      get(name).oninput()
    }
    blinkStart = -Infinity
    glasses = false
    get('glasses').setAttribute('aria-pressed', 'false')
  }
  app.ticker.add(ticker => {
    const size = `${app.screen.width}x${app.screen.height}`
    if (size !== frameSize) {
      frameSize = size
      layout()
    }
    const dt = Math.min(40, ticker.deltaMS)
    idle.prepare(dt, playing, defaultLive2DStyle, false, scrub)
    if (playing || scrub === 0) time.value = String(idle.playhead)
    get('time-value').textContent = `${idle.playhead.toFixed(2)} / ${idle.duration.toFixed(2)} s`
    model.update(dt)
  })
  syncPlayButton()
  get('controls').disabled = false
  status.textContent = ''
}

mount().catch(error => { status.textContent = error.message })
