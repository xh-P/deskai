import 'pixi.js/unsafe-eval'
import { Application, extensions } from 'pixi.js'
import { configureCubismSDK, Live2DModel, Live2DPlugin, MotionPreloadStrategy, MotionPriority } from 'untitled-pixi-live2d-engine/cubism'

extensions.add(Live2DPlugin)
configureCubismSDK({ memorySizeMB: 64 })

const get = id => document.getElementById(id)
const viewport = get('viewport')
const status = get('status')
const frames = [...document.querySelectorAll('[data-frame]')]
const axes = { yaw: 'ParamAngleX', pitch: 'ParamAngleY', lift: 'ParamArmLift' }
const eyelids = ['ParamEyeLOpen', 'ParamEyeROpen']
const idleParams = [
  axes.yaw, axes.pitch, 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
  'ParamBreath', 'ParamIdleAir', 'ParamArmFollowR', 'ParamArmFollowL',
  ...eyelids, 'ParamEyeBallX', 'ParamEyeBallY', 'ParamBrowLY', 'ParamBrowRY',
]
const headControls = ['yaw', 'pitch']
const breezeGroup = '轻风待机'
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
    // Use an unregistered idle group. The viewer starts its breeze explicitly.
    idleMotionGroup: 'ManualPreview',
    motionPreload: MotionPreloadStrategy.NONE, checkMocConsistency: true,
    eyeBlink: false,
    textureOptions: { lod: 'full', preferCreateImageBitmap: false },
  })
  app.stage.addChild(model)
  const inner = model.internalModel
  // The authored idle track supplies breath along with the head and body motion.
  inner.breath.getParameters().clear()
  const core = inner.coreModel
  const indices = new Map(Array.from({ length: core.getParameterCount() }, (_, index) =>
    [core.getParameterId(index).getString().s, index]))
  const required = [...idleParams, axes.lift, 'ParamGlasses']
  if (required.some(id => !indices.has(id))) throw new Error('模型缺少审阅参数。')
  const write = (id, value) => core.setParameterValueByIndex(indices.get(id), value)
  const read = id => core.getParameterValueByIndex(indices.get(id))
  const restIdle = idleParams.map(id => [id, core.getParameterDefaultValue(indices.get(id))])
  const art = restBounds(inner)
  const crops = {
    full: art,
    upper: { ...art, y: art.y - art.height * 0.009, height: art.height * 0.603 },
    head: { ...art, y: art.y - art.height * 0.012, height: art.height * 0.36 },
    arm: { ...art, y: art.y + art.height * 0.218, height: art.height * 0.414 },
  }
  let frame = 'full'
  let frameSize = ''
  let blinkStart = -Infinity
  let glasses = false
  let playing = false
  let playRequest = 0
  let idle = false
  let lastIdlePose
  let idleStoppedAt = 0
  const idleButton = get('idle')

  const layout = () => {
    const { width, height } = app.screen
    const crop = crops[frame]
    const scale = Math.min(width * 0.92 / crop.width, height * 0.96 / crop.height)
    model.scale.set(scale)
    model.position.set((width - crop.width * scale) / 2 - crop.x * scale,
      (height - crop.height * scale) / 2 - crop.y * scale)
  }
  const setLift = amount => {
    const percent = Math.round(amount * 100)
    get('lift').value = percent
    get('lift-value').value = `${percent}%`
  }
  const finish = () => {
    playing = false
    get('play').textContent = '播放抬手'
  }
  const stop = () => {
    playRequest++
    inner.motionManager.stopAllMotions()
    finish()
  }
  inner.motionManager.on('motionFinish', () => {
    if (!playing) return
    finish()
    setLift(0)
  })

  // Start the clip from neutral each frame so manual head offsets never accumulate.
  inner.on('beforeMotionUpdate', () => {
    for (const [id, value] of restIdle) write(id, value)
  })
  inner.on('afterMotionUpdate', () => {
    if (idle) {
      lastIdlePose = idleParams.map(read)
    } else if (lastIdlePose) {
      const elapsed = performance.now() - idleStoppedAt
      if (elapsed >= 260) lastIdlePose = undefined
      else {
        const weight = 1 - smoothstep(elapsed / 260)
        restIdle.forEach(([id, value], index) => write(id, value + (lastIdlePose[index] - value) * weight))
      }
    }
    // Head offsets also drive hair physics.
    for (const name of headControls) {
      const id = axes[name]
      write(id, read(id) + Number(get(name).value))
    }
  })
  inner.on('beforeModelUpdate', () => {
    write('ParamGlasses', Number(glasses))
    const elapsed = performance.now() - blinkStart
    if (elapsed < 285) {
      const open = elapsed < 100 ? 1 - smoothstep(elapsed / 100)
        : elapsed < 135 ? 0 : smoothstep((elapsed - 135) / 150)
      for (const id of eyelids) write(id, Math.min(read(id), open))
    }
    if (playing) setLift(read(axes.lift))
    else write(axes.lift, Number(get('lift').value) / 100)
  })

  for (const button of frames) button.onclick = () => {
    frame = button.dataset.frame
    for (const item of frames) item.setAttribute('aria-pressed', String(item === button))
    layout()
  }
  for (const name of headControls) get(name).oninput = () => {
    get(`${name}-value`).value = `${get(name).value}°`
  }
  get('lift').oninput = () => {
    stop()
    get('lift-value').value = `${get('lift').value}%`
  }
  get('blink').onclick = () => { blinkStart = performance.now() }
  get('glasses').onclick = () => {
    glasses = !glasses
    get('glasses').setAttribute('aria-pressed', String(glasses))
  }
  const setIdle = enabled => {
    idle = enabled
    idleButton.setAttribute('aria-pressed', String(idle))
    if (!enabled) {
      idleStoppedAt = performance.now()
      inner.parallelMotionManager[0]?.stopAllMotions()
    }
  }
  idleButton.onclick = async () => {
    if (idle) {
      setIdle(false)
      return
    }
    idleButton.disabled = true
    get('reset').disabled = true
    try {
      const [started] = await model.parallelMotion([{ group: breezeGroup, index: 0, priority: MotionPriority.FORCE, loop: true }])
      if (!started) throw new Error('轻风待机动作未能播放。')
      setIdle(true)
    } catch (error) {
      status.textContent = error.message
    } finally {
      idleButton.disabled = false
      get('reset').disabled = false
    }
  }
  get('play').onclick = async () => {
    if (playing) { stop(); return }
    const request = ++playRequest
    setLift(0)
    playing = true
    get('play').textContent = '暂停抬手'
    try {
      const started = await model.motion('右臂抬手', 0, MotionPriority.FORCE, { loop: false })
      if (request !== playRequest && !playing) inner.motionManager.stopAllMotions()
      if (request === playRequest && !started) finish()
    } catch (error) {
      if (request === playRequest) finish()
      status.textContent = error.message
    }
  }
  get('reset').onclick = () => {
    stop()
    setIdle(false)
    lastIdlePose = undefined
    setLift(0)
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
    model.update(Math.min(40, ticker.deltaMS))
  })
  get('controls').disabled = false
  status.textContent = ''
}

mount().catch(error => { status.textContent = error.message })
