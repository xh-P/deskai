import { CubismParallelMotionManager, type CubismInternalModel } from 'untitled-pixi-live2d-engine/cubism'
import { defaultLive2DIdleTuning, live2DSetting, type Live2DIdleRig,
  type Live2DStyle } from '../../../../../packages/desktop-pet/src/live2d.ts'

type Channel = { id: string; index: number; rest: number; group: string }
const RETURN_MS = 240

/** The authored motion uses its own clock. One-shot motions, gestures and physics keep real time. */
export class IdleMotion {
  private readonly tracks: Channel[]
  private readonly physics: Channel[]
  private readonly queue: CubismParallelMotionManager['queueManager']
  private readonly entry: ReturnType<IdleMotion['queue']['getCubismMotionQueueEntry']>
  private readonly underlying: Float32Array
  private readonly samples: Float32Array
  private delayed = new Map<number, number[]>()
  private time = 0
  private weight = 0
  private physicsWeight = 1
  private tuning = defaultLive2DIdleTuning
  private overrides?: Live2DStyle['motionTracks']
  private scrub?: number

  private constructor(private readonly inner: CubismInternalModel, parameters: readonly string[], rig: Live2DIdleRig,
    motion: NonNullable<Awaited<ReturnType<CubismInternalModel['motionManager']['loadMotion']>>>) {
    const channels = (groups: Live2DIdleRig['tracks']): Channel[] =>
      Object.entries(groups).flatMap(([group, ids]) => ids.flatMap(id => {
        const index = parameters.indexOf(id)
        return index === -1 ? [] : [{ id, index, rest: inner.coreModel.getParameterDefaultValue(index), group }]
      }))
    this.tracks = channels(rig.tracks)
    this.physics = channels(rig.physics)
    this.underlying = new Float32Array(this.tracks.length)
    this.samples = new Float32Array(this.tracks.length)
    const manager = new CubismParallelMotionManager(inner)
    this.queue = manager.queueManager
    motion.setLoop(true)
    motion.setLoopFadeIn(false)
    motion.setFadeInTime(0)
    this.duration = motion.getLoopDuration()
    this.entry = this.queue.getCubismMotionQueueEntry(this.queue.startMotion(motion, false))
    motion.setupMotionQueueEntry(this.entry, 0)
    inner.once('destroy', () => manager.destroy())
    // Only the authored clip supplies breath and the recurring blink on this model.
    inner.breath.getParameters().clear()
    inner.eyeBlink = undefined
  }

  readonly duration: number
  get playhead(): number { return this.time }

  static async load(inner: CubismInternalModel, parameters: readonly string[], rig: Live2DIdleRig): Promise<IdleMotion> {
    const motion = await inner.motionManager.loadMotion(rig.motion.group, rig.motion.index)
    if (!motion) throw new Error('无法加载待机动作。')
    return new IdleMotion(inner, parameters, rig, motion)
  }

  prepare(dt: number, playing: boolean, style: Live2DStyle, reduced = false, scrub?: number): void {
    this.tuning = style.idle ?? defaultLive2DIdleTuning
    if (this.overrides !== style.motionTracks) {
      this.overrides = style.motionTracks
      this.delayed.clear()
      this.tracks.forEach(({ id }, i) => {
        const delay = live2DSetting(this.overrides, id)?.delay
        if (delay) {
          const tracks = this.delayed.get(delay) ?? []
          tracks.push(i)
          this.delayed.set(delay, tracks)
        }
      })
    }
    this.scrub = scrub
    this.physicsWeight = reduced ? 0 : 1
    const change = dt / RETURN_MS
    if (scrub !== undefined) {
      this.time = scrub
      this.weight = 1
    } else {
      this.weight = playing ? Math.min(1, this.weight + change) : Math.max(0, this.weight - change)
      if (playing) this.time = (this.time + dt / 1000 * this.tuning.speed) % this.duration
    }
  }

  private sample(time: number): void {
    const core = this.inner.coreModel
    this.tracks.forEach(({ index, rest }) => core.setParameterValueByIndex(index, rest))
    // The clip is parameter-only. Keep the same sampling origin when scrubbing or sampling delayed tracks.
    this.entry.setStartTime(0)
    this.queue.doUpdateMotion(core, ((time % this.duration) + this.duration) % this.duration)
  }

  apply(): void {
    if (this.weight === 0) return
    const core = this.inner.coreModel
    this.tracks.forEach(({ index }, i) => { this.underlying[i] = core.getParameterValueByIndex(index) })
    this.sample(this.scrub ?? this.time)
    this.tracks.forEach(({ index }, i) => { this.samples[i] = core.getParameterValueByIndex(index) })
    for (const [delay, tracks] of this.delayed) {
      this.sample(this.time - delay)
      for (const i of tracks) this.samples[i] = core.getParameterValueByIndex(this.tracks[i].index)
    }
    const weight = this.weight * this.weight * (3 - 2 * this.weight)
    this.tracks.forEach(({ id, index, rest, group }, i) => {
      const gain = (group === 'base' ? 1 : live2DSetting(this.tuning, group) ?? 1) *
        (live2DSetting(this.overrides, id)?.amplitude ?? 1)
      const value = this.underlying[i] + (this.samples[i] - rest) * gain * weight
      core.setParameterValueByIndex(index, value)
    })
  }

  scalePhysics(): void {
    const core = this.inner.coreModel
    for (const { index, rest, group } of this.physics) {
      const gain = (live2DSetting(this.tuning, group) ?? 1) * this.physicsWeight
      if (gain !== 1) core.setParameterValueByIndex(index, rest + (core.getParameterValueByIndex(index) - rest) * gain)
    }
  }
}
