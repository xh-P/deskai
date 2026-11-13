import { CubismParallelMotionManager, type CubismInternalModel } from 'untitled-pixi-live2d-engine/cubism'
import { defaultLive2DIdleTuning, type Live2DIdlePart, type Live2DIdleRig,
  type Live2DIdleTuning } from '../../../../../packages/desktop-pet/src/live2d.ts'

type Channel = { index: number; rest: number; part: Live2DIdlePart | 'base' }
const RETURN_MS = 240

/** The authored motion uses its own clock. One-shot motions, gestures and physics keep real time. */
export class IdleMotion {
  private readonly tracks: Channel[]
  private readonly physics: Channel[]
  private readonly queue: CubismParallelMotionManager['queueManager']
  private readonly underlying: Float32Array
  private time = 0
  private weight = 0
  private physicsWeight = 1
  private tuning = defaultLive2DIdleTuning

  private constructor(private readonly inner: CubismInternalModel, parameters: readonly string[], rig: Live2DIdleRig) {
    const channels = (groups: Live2DIdleRig['tracks']): Channel[] =>
      (Object.entries(groups) as [Channel['part'], string[]][]).flatMap(([part, ids]) => ids.flatMap(id => {
        const index = parameters.indexOf(id)
        return index === -1 ? [] : [{ index, rest: inner.coreModel.getParameterDefaultValue(index), part }]
      }))
    this.tracks = channels(rig.tracks)
    this.physics = channels(rig.physics)
    this.underlying = new Float32Array(this.tracks.length)
    const manager = new CubismParallelMotionManager(inner)
    this.queue = manager.queueManager
    inner.once('destroy', () => manager.destroy())
    // Only the authored clip supplies breath and the recurring blink on this model.
    inner.breath.getParameters().clear()
    inner.eyeBlink = undefined
  }

  static async load(inner: CubismInternalModel, parameters: readonly string[], rig: Live2DIdleRig): Promise<IdleMotion> {
    const motion = await inner.motionManager.loadMotion(rig.motion.group, rig.motion.index)
    if (!motion) throw new Error('无法加载待机动作。')
    motion.setLoop(true)
    motion.setLoopFadeIn(false)
    const idle = new IdleMotion(inner, parameters, rig)
    idle.queue.startMotion(motion, false)
    return idle
  }

  prepare(dt: number, playing: boolean, tuning = defaultLive2DIdleTuning, reduced = false): void {
    this.tuning = tuning
    this.physicsWeight = reduced ? 0 : 1
    const change = dt / RETURN_MS
    this.weight = playing ? Math.min(1, this.weight + change) : Math.max(0, this.weight - change)
    if (playing) this.time += dt / 1000 * tuning.speed
  }

  apply(): void {
    if (this.weight === 0) return
    const core = this.inner.coreModel
    this.tracks.forEach(({ index, rest }, i) => {
      this.underlying[i] = core.getParameterValueByIndex(index)
      core.setParameterValueByIndex(index, rest)
    })
    this.queue.doUpdateMotion(core, this.time)
    const weight = this.weight * this.weight * (3 - 2 * this.weight)
    this.tracks.forEach(({ index, rest, part }, i) => {
      const gain = part === 'base' ? 1 : this.tuning[part]
      const value = this.underlying[i] + (core.getParameterValueByIndex(index) - rest) * gain * weight
      core.setParameterValueByIndex(index, value)
    })
  }

  scalePhysics(): void {
    const core = this.inner.coreModel
    for (const { index, rest, part } of this.physics) {
      if (part === 'base') continue
      const gain = this.tuning[part] * this.physicsWeight
      if (gain !== 1) core.setParameterValueByIndex(index, rest + (core.getParameterValueByIndex(index) - rest) * gain)
    }
  }
}
