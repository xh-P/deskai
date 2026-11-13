import 'pixi.js/unsafe-eval'
import { Application, Assets, Container, extensions, type WebGLRenderer } from 'pixi.js'
import { configureCubismSDK, Live2DModel, Live2DPlugin, MotionPreloadStrategy, MotionPriority,
  type CubismInternalModel } from 'untitled-pixi-live2d-engine/cubism'
import { defaultLive2DLayerShape, type Live2DLayerShape, type Live2DMotion, type Live2DProfile }
  from '../../../../../packages/desktop-pet/src/live2d.ts'
import type { PetGesture, PetState } from '../../../../../packages/desktop-pet/src/types.ts'
import type { GestureName } from '../../../../../packages/voice-core/src/gesture.ts'
import { GestureMotion } from './gesture-motion'
import { IdleMotion } from './idle-motion'
import { LayerAdjustments } from './layer-adjustments'
import { LayerOutline, type LayerPreview } from './layer-outline'
import { LayerPicking, meshProjection } from './layer-picking'
import { shapeHandle } from './soft-shape'

extensions.add(Live2DPlugin)
configureCubismSDK({ memorySizeMB: 64 })

export type ModelInfo = { id: string; parameters: string[]; drawables: string[]; physics: boolean; aspect: number; gestures: readonly GestureName[];
  duration?: number }
export type StageState = {
  state: PetState
  reduced: boolean
  expression?: string
  idlePlaying?: boolean
  framing?: Live2DProfile['style']['frame']
  layerPreview?: LayerPreview
  editShape?: string
  motionPreview?: { time?: number; values: Readonly<Record<string, number>>; physics: boolean; neutral: boolean }
  gesture?: PetGesture
  readMouth: () => { open: number; shape: number }
}
type Model = Live2DModel<CubismInternalModel>
type Rect = { x: number; y: number; width: number; height: number }
type Layer = { profile: Live2DProfile; model: Model; art: Rect; headCenter?: number; parameters: string[];
  mouth: (open: number, shape: number) => void; gestures: GestureMotion; idle?: IdleMotion;
  drawables: string[]; bounds?: Rect[]; adjustments?: LayerAdjustments; picking?: LayerPicking }
const clamp = (x: number, low: number, high: number) => Math.max(low, Math.min(high, x))

function artBounds(model: Model): Rect {
  const inner = model.internalModel
  const core = inner.coreModel
  core.update()
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
  for (let i = 0; i < core.getDrawableCount(); i++) {
    if (core.getDrawableOpacity(i) <= 0.01) continue
    const box = inner.getDrawableBounds(i)
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }
  return Number.isFinite(left) && right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : { x: 0, y: 0, width: inner.width, height: inner.height }
}

function mouthDriver(layer: Omit<Layer, 'mouth'>) {
  const core = layer.model.internalModel.coreModel
  const style = layer.profile.style.mouth
  const find = (id?: string) => id ? layer.parameters.indexOf(id) : -1
  const wideId = find(style.wide), roundId = find(style.round)
  const formId = find(style.form ?? 'ParamMouthForm')
  const ids = style.open ? [style.open] : layer.profile.lipSync.length ? layer.profile.lipSync : ['ParamMouthOpenY']
  const openIds = ids.map(find).filter(index => index >= 0 && index !== wideId && index !== roundId)
  const set = (index: number, value: number) => {
    if (index >= 0) core.setParameterValueByIndex(index, value)
  }
  return (open: number, shape: number) => {
    const wide = wideId >= 0 ? Math.max(0, shape) * 0.72 : 0
    const round = roundId >= 0 ? Math.max(0, -shape) * 0.72 : 0
    for (const index of openIds) set(index, open * (1 - wide - round))
    set(wideId, open * wide)
    set(roundId, open * round)
    if (formId >= 0 && open > 0.02) {
      const base = core.getParameterValueByIndex(formId)
      set(formId, base + shape * open * 0.4)
    }
  }
}

function release(model: Model, profile: Live2DProfile): Promise<unknown> {
  if (model.internalModel) model.destroy({ children: true })
  else {
    model.emit('destroy')
    Container.prototype.destroy.call(model)
  }
  return Promise.allSettled(profile.textures.map(file => {
    const url = new URL(file, profile.url).href
    return Assets.cache.has(url) ? Assets.unload(url) : Promise.resolve()
  }))
}

/** One renderer per presentation surface. Only the latest completed model load may replace the current model. */
export class CubismStage {
  private layer?: Layer
  private wanted?: Live2DProfile
  private queued = Promise.resolve()
  private enabled = false
  private lost = false
  private disposed = false
  private clock = 0
  private open = 0
  private shape = 0
  private lastState?: PetState
  private expression?: string
  private pointer?: { x: number; y: number }
  private outline?: LayerOutline
  private readonly pixel = new Uint8Array(4)
  private readonly observer: ResizeObserver

  private constructor(private readonly app: Application<WebGLRenderer>, private readonly host: HTMLElement,
    private readonly read: () => StageState, private readonly report: (info: ModelInfo) => void,
    private readonly error: (message: string) => void, private readonly recover: () => void) {
    host.appendChild(app.canvas)
    app.canvas.addEventListener('webglcontextlost', this.contextLost)
    app.canvas.addEventListener('webglcontextrestored', this.contextRestored)
    app.ticker.remove(app.render, app)
    app.ticker.maxFPS = 30
    app.ticker.add(ticker => {
      if (!this.layer) return
      try { this.tick(ticker.deltaMS); app.render() }
      catch (error) { app.stop(); this.error(error instanceof Error ? error.message : String(error)) }
    })
    this.observer = new ResizeObserver(this.layout)
    this.observer.observe(host)
    window.addEventListener('resize', this.layout)
  }

  static async create(host: HTMLElement, read: () => StageState, report: (info: ModelInfo) => void,
      error: (message: string) => void, recover: () => void): Promise<CubismStage> {
    const app = new Application<WebGLRenderer>()
    await app.init({ preference: 'webgl', preferWebGLVersion: 2, backgroundAlpha: 0, antialias: true,
      autoStart: false, sharedTicker: false, autoDensity: true, resolution: Math.min(devicePixelRatio, 2),
      preserveDrawingBuffer: true, width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight) })
    return new CubismStage(app, host, read, report, error, recover)
  }

  show(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (enabled && !this.lost) { this.layout(); this.app.start() }
    else { this.app.stop(); this.open = this.shape = 0; this.pointer = undefined; this.layer?.gestures.reset() }
  }

  model(profile: Live2DProfile): void {
    const previous = this.wanted
    this.wanted = profile
    if (this.layer?.profile.id === profile.id) {
      const prior = this.layer.profile.style
      const style = profile.style
      if (prior !== style) {
        this.layer.profile = profile
        if (prior.mouth !== style.mouth) this.layer.mouth = mouthDriver(this.layer)
        if (prior.cues !== style.cues) this.lastState = undefined
        if (prior.frame !== style.frame || prior.zoom !== style.zoom || prior.x !== style.x || prior.y !== style.y) this.layout()
      }
      if (previous?.id !== profile.id || prior.frame !== style.frame) this.reportInfo()
      return
    }
    if (previous?.id === profile.id) return
    this.queued = this.queued.then(() => this.load(profile)).catch(error => {
      if (!this.disposed && this.wanted?.id === profile.id) {
        this.wanted = undefined
        this.error(error instanceof Error ? error.message : String(error))
      }
    })
  }

  frame(): void { this.layout() }

  private async load(profile: Live2DProfile): Promise<void> {
    if (this.disposed || this.wanted?.id !== profile.id) return
    let candidate!: Model
    try {
      await new Promise<void>((resolve, reject) => {
        candidate = Live2DModel.fromSync(profile.url, { autoUpdate: false, autoHitTest: false, autoFocus: false,
          motionPreload: MotionPreloadStrategy.NONE, idleMotionGroup: profile.idle ? 'ManualIdle' : '', checkMocConsistency: true,
          textureOptions: { lod: 'full', preferCreateImageBitmap: false },
          onLoad: resolve, onError: reject }) as Model
      })
    } catch (error) {
      if (candidate) await release(candidate, profile)
      throw error
    }
    if (this.disposed || this.wanted?.id !== profile.id) { await release(candidate, profile); return }
    const core = candidate.internalModel.coreModel
    const parameters = Array.from({ length: core.getParameterCount() }, (_, i) => core.getParameterId(i).getString().s)
    let idle: IdleMotion | undefined
    try {
      if (profile.idle) idle = await IdleMotion.load(candidate.internalModel, parameters, profile.idle)
    } catch (error) {
      await release(candidate, profile)
      throw error
    }
    if (this.disposed || this.wanted?.id !== profile.id) { await release(candidate, profile); return }
    const old = this.layer
    const art = artBounds(candidate)
    const headArea = Object.values(candidate.internalModel.hitAreas).find(area => /^(head|face)$/iu.test(area.name))
    const head = headArea && candidate.internalModel.getDrawableBounds(headArea.index)
    const headCenter = head ? head.x + head.width / 2 : undefined
    const gestures = new GestureMotion(core, parameters)
    const inner = candidate.internalModel
    const drawables = inner.getDrawableIDs()
    const adjustments = profile.layers && new LayerAdjustments(inner, profile, drawables)
    const bounds = adjustments && drawables.map((_, index) => inner.getDrawableBounds(index))
    const picking = profile.layers && new LayerPicking(candidate, drawables, new Set(profile.layers.map(layer => layer.id)))
    const layer = { profile: this.wanted, model: candidate, art, headCenter, parameters, gestures, idle,
      drawables, bounds, adjustments, picking }
    if (old) this.app.stage.removeChild(old.model)
    this.layer = { ...layer, mouth: mouthDriver(layer) }
    this.outline?.reset()
    if (adjustments) {
      const draw = inner.draw.bind(inner)
      inner.draw = gl => {
        const preview = this.read().layerPreview
        const index = preview ? drawables.indexOf(preview.id) : -1
        adjustments.draw(preview?.isolate && index >= 0 ? index : undefined, original => {
          draw(gl)
          if (preview && index >= 0 && (preview.display !== 'off' || this.read().editShape) &&
              (preview.isolate || core.getDrawableOpacity(index) > 0.01)) {
            const base = original(index)
            const handle = this.read().editShape ? this.shapePoint(index, base) : undefined
            this.outline ??= new LayerOutline(this.host)
            this.outline.show(candidate, index, preview.display, base, handle)
          } else this.outline?.hide()
        })
      }
    }
    const glasses = profile.glassesParameter ? parameters.indexOf(profile.glassesParameter) : -1
    // Save Cubism's ordinary motion state before overlaying the authored loop.
    inner.on('afterMotionUpdate', () => gestures.apply())
    const updateNaturalMovements = inner.updateNaturalMovements.bind(inner)
    if (idle) inner.updateNaturalMovements = (dt, now) => {
      updateNaturalMovements(dt, now)
      const preview = this.read().motionPreview
      if (preview?.neutral) {
        for (let index = 0; index < parameters.length; index++) {
          const value = preview.values[parameters[index]] ?? 0
          const rest = core.getParameterDefaultValue(index)
          const limit = value < 0 ? core.getParameterMinimumValue(index) : core.getParameterMaximumValue(index)
          core.setParameterValueByIndex(index, rest + (limit - rest) * Math.abs(value))
        }
      } else {
        idle.apply()
      }
    }
    inner.on('beforeModelUpdate', () => {
      if (this.layer?.model !== candidate) return
      idle?.scalePhysics()
      adjustments?.scaleSway(this.read().motionPreview?.physics !== false)
      if (glasses >= 0 && this.layer.profile.style.glasses) core.setParameterValueByIndex(glasses, 1)
      this.layer.mouth(this.open, this.shape)
    })
    this.app.stage.addChild(candidate)
    this.lastState = undefined
    this.expression = undefined
    this.layout()
    try {
      if (this.enabled && !this.lost) { this.app.render(); this.app.start() }
    } catch (error) {
      this.app.stage.removeChild(candidate)
      this.layer = old
      if (old) this.app.stage.addChild(old.model)
      await release(candidate, profile)
      throw error
    }
    this.reportInfo()
    if (old) await release(old.model, old.profile)
  }

  play(motion: Live2DMotion): void {
    void this.layer?.model.motion(motion.group, motion.index, MotionPriority.FORCE, { loop: false })
      .catch(() => this.error('无法播放该模型动作。'))
  }

  tap(): void {
    const layer = this.layer
    if (!layer || this.read().reduced) return
    const cue = layer.profile.style.cues.tap
    if (cue?.motion) this.play(cue.motion)
    if (cue?.expression) void layer.model.expression(cue.expression).catch(() => {})
  }

  gaze(x: number, y: number): void { this.pointer = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) } }
  restGaze(): void { this.pointer = undefined }
  playhead(): number { return this.layer?.idle?.playhead ?? 0 }

  pick(clientX: number, clientY: number): string[] {
    const layer = this.layer
    if (!this.enabled || this.lost || !layer?.picking || !layer.adjustments || layer.profile.id !== this.wanted?.id) return []
    const rect = this.host.getBoundingClientRect()
    const preview = this.read().layerPreview
    const index = preview?.isolate ? layer.drawables.indexOf(preview.id) : -1
    const adjustments = layer.adjustments
    return layer.picking.at(clientX - rect.left, clientY - rect.top, i => adjustments.vertices(i), index >= 0 ? index : undefined)
  }

  private shapePoint(index: number, base: Float32Array) {
    const layer = this.layer!
    const id = layer.drawables[index]
    const kind = layer.profile.layers?.find(item => item.id === id)?.shape
    if (!kind) return
    return shapeHandle(base, layer.profile.style.layerShapes?.[id] ?? defaultLive2DLayerShape, kind)
  }

  dragShape(clientX: number, clientY: number): ((x: number, y: number) => Live2DLayerShape) | undefined {
    const layer = this.layer
    const preview = this.read().layerPreview
    if (!this.enabled || !layer || !preview || this.read().editShape !== preview.id) return
    const index = layer.drawables.indexOf(preview.id)
    if (index < 0) return
    const core = layer.model.internalModel.coreModel
    if (!preview.isolate && core.getDrawableOpacity(index) <= 0.01) return
    const handle = this.shapePoint(index, core.getDrawableVertexPositions(index))
    if (!handle) return
    const projection = meshProjection(layer.model)
    const [x, y] = projection.screen(handle.x, handle.y)
    const rect = this.host.getBoundingClientRect()
    if (Math.hypot(clientX - rect.left - x, clientY - rect.top - y) > 13) return
    const [vx, vy] = projection.model(clientX - rect.left, clientY - rect.top)
    return (nextX, nextY) => {
      const [mx, my] = projection.model(nextX - rect.left, nextY - rect.top)
      return handle.update(mx - vx, my - vy)
    }
  }

  hit(clientX: number, clientY: number): boolean {
    if (!this.enabled || !this.layer || this.lost) return false
    const canvas = this.app.canvas
    const rect = canvas.getBoundingClientRect()
    const x = Math.floor((clientX - rect.left) * canvas.width / rect.width)
    const y = Math.floor((clientY - rect.top) * canvas.height / rect.height)
    if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return false
    const gl = this.app.renderer.gl
    gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel)
    return this.pixel[3] > 24
  }

  private tick(delta: number): void {
    const layer = this.layer
    if (!layer) return
    const { state, reduced, expression, gesture, readMouth, idlePlaying, motionPreview } = this.read()
    const { profile, model } = layer
    const dt = Math.min(90, delta)
    this.clock += dt / 1000
    const cue = profile.style.cues[state]
    const desired = expression ?? cue?.expression
    if (desired !== this.expression) {
      this.expression = desired
      if (desired) void model.expression(desired).catch(() => {})
      else model.internalModel.motionManager.expressionManager?.resetExpression()
    }
    if (state !== this.lastState) {
      this.lastState = state
      if (!reduced && cue?.motion) this.play(cue.motion)
    }
    const action = layer.gestures.prepare(gesture, dt, reduced)
    const weight = layer.gestures.weight
    layer.idle?.prepare(dt, !reduced && (idlePlaying ?? true), profile.style, reduced, motionPreview?.time)
    layer.adjustments?.prepare(profile.style)
    const fps = reduced ? 24 : !action && !weight && (state === 'off' || state === 'silent') ? 30 : 60
    if (this.app.ticker.maxFPS !== fps) this.app.ticker.maxFPS = fps
    this.host.dataset.gesture = action ?? ''
    this.host.dataset.gestureWeight = weight.toFixed(3)
    const amount = reduced ? 0 : profile.style.gaze * (1 - Math.min(0.78, weight * 1.45))
    const look = state === 'thinking' || state === 'waiting' ? { x: 0.24, y: -0.17 }
      : state === 'listening' ? { x: 0.035, y: 0.08 } : { x: 0, y: 0 }
    const gaze = this.pointer ? { x: this.pointer.x * 0.35, y: this.pointer.y * 0.28 } : layer.idle ? look : {
      x: look.x + Math.sin(this.clock * 0.58) * 0.09 + Math.sin(this.clock * 0.23) * 0.045,
      y: look.y + Math.sin(this.clock * 0.39) * 0.06,
    }
    model.internalModel.focusController.focus(gaze.x * amount, gaze.y * amount)
    const mouth = readMouth()
    const open = state === 'speaking' ? clamp(mouth.open * profile.style.mouthGain, 0, 1) : 0
    this.open = state !== 'speaking' ? 0 : this.open + (open - this.open) * (1 - Math.exp(-dt / (open > this.open ? 33 : 64)))
    this.shape += (mouth.shape - this.shape) * (1 - Math.exp(-dt / 70))
    this.host.dataset.mouth = this.open.toFixed(3)
    try { model.update(dt) }
    finally { layer.gestures.restore() }
  }

  private frameHeight(layer: Layer, frame = layer.profile.style.frame): number { return layer.art.height * (frame === 'portrait' ? 0.57 : 1) }

  private reportInfo(): void {
    const layer = this.layer
    if (layer) this.report({ id: layer.profile.id, parameters: layer.parameters, drawables: layer.drawables,
      physics: !!layer.model.internalModel.physics, gestures: layer.gestures.available, duration: layer.idle?.duration,
      aspect: clamp(layer.art.width / this.frameHeight(layer), 0.35, 2.2) })
  }

  private layout = () => {
    const { clientWidth: w, clientHeight: h } = this.host
    if (this.disposed || this.lost || !w || !h) return
    const resolution = Math.min(devicePixelRatio, 2)
    const view = this.app.renderer
    if (this.app.screen.width !== w || this.app.screen.height !== h || view.resolution !== resolution) view.resize(w, h, resolution)
    const layer = this.layer
    if (!layer) return
    const { model, art, profile: { style } } = layer
    const { layerPreview, framing: previewFrame } = this.read()
    const framing = previewFrame ?? style.frame
    const fit = Math.min(w * 0.95 / art.width, h * 0.97 / art.height)
    const focus = layerPreview?.focus ? layer.bounds?.[layer.drawables.indexOf(layerPreview.id)] : undefined
    if (focus && focus.width > 0 && focus.height > 0) {
      const transform = model.internalModel.localTransform
      const scale = Math.min(w * 0.72 / (focus.width * transform.a), h * 0.72 / (focus.height * transform.d), fit * 14)
      model.scale.set(scale)
      model.position.set(w / 2 - ((focus.x + focus.width / 2) * transform.a + transform.tx) * scale,
        h / 2 - ((focus.y + focus.height / 2) * transform.d + transform.ty) * scale)
      return
    }
    const frame = this.frameHeight(layer, framing)
    const scale = Math.min(w * 0.95 / art.width, h * 0.97 / frame) * style.zoom
    const center = framing === 'portrait' && Number.isFinite(layer.headCenter) ? layer.headCenter! : art.x + art.width / 2
    model.scale.set(scale)
    model.position.set(w * (0.5 + style.x) - center * scale,
      h * (0.99 + style.y) - (art.y + frame) * scale)
  }

  private contextLost = (event: Event) => {
    event.preventDefault()
    this.lost = true
    this.app.stop()
    this.outline?.close()
    this.error('正在恢复 Live2D 图形上下文。')
  }
  private contextRestored = () => this.recover()

  close(): void {
    this.disposed = true
    this.observer.disconnect()
    window.removeEventListener('resize', this.layout)
    this.app.canvas.removeEventListener('webglcontextlost', this.contextLost)
    this.app.canvas.removeEventListener('webglcontextrestored', this.contextRestored)
    this.app.stop()
    this.outline?.close()
    if (this.layer) {
      this.app.stage.removeChild(this.layer.model)
      void release(this.layer.model, this.layer.profile)
    }
    this.app.destroy({ removeView: true }, { children: true })
  }
}
