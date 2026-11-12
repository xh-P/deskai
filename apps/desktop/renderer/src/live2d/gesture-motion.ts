import type { CubismInternalModel } from 'untitled-pixi-live2d-engine/cubism'
import { GESTURE_NAMES, type GestureName } from '../../../../../packages/voice-core/src/gesture.ts'
import type { PetGesture } from '../../../../../packages/desktop-pet/src/types.ts'

const parameterIds = {
  headX: 'ParamAngleX', headY: 'ParamAngleY', headZ: 'ParamAngleZ',
  bodyX: 'ParamBodyAngleX', bodyY: 'ParamBodyAngleY', bodyZ: 'ParamBodyAngleZ',
  eyeX: 'ParamEyeBallX', eyeY: 'ParamEyeBallY',
} as const
type Axis = keyof typeof parameterIds
type Keyframes = readonly (readonly [progress: number, offset: number])[]
type Track = readonly [axis: Axis, gain: number, delayMs?: number]
type Motion = { required: Axis; durationMs: number; curve: Keyframes; tracks: readonly Track[] }

const tilt = (direction: number): Motion => ({
  required: 'headZ', durationMs: 1120,
  curve: [[0, 0], [0.31, 1], [0.62, 0.91], [1, 0]],
  tracks: [['headZ', 0.5 * direction], ['headX', 0.13 * direction, 55], ['bodyZ', 0.23 * direction, 115]],
})
const glance = (eye: Axis, head: Axis, body: Axis, direction: number): Motion => ({
  required: eye, durationMs: 1130,
  curve: [[0, 0], [0.21, 1], [0.62, 0.94], [1, 0]],
  tracks: [[eye, 0.72 * direction], [head, 0.34 * direction, 90], [body, 0.16 * direction, 165]],
})
const motions: Record<GestureName, Motion> = {
  nod: {
    required: 'headY', durationMs: 790,
    curve: [[0, 0], [0.14, -0.14], [0.41, 1], [0.8, -0.1], [1, 0]],
    tracks: [['headY', -0.48], ['bodyY', -0.22, 95], ['eyeY', -0.15, 20]],
  },
  shake_head: {
    required: 'headX', durationMs: 1190,
    curve: [[0, 0], [0.12, 0.16], [0.3, -1], [0.53, 0.91], [0.75, -0.48], [1, 0]],
    tracks: [['headX', 0.6], ['headZ', 0.13, 36], ['bodyX', 0.27, 105], ['eyeX', -0.24, 45]],
  },
  tilt_left: tilt(-1),
  tilt_right: tilt(1),
  look_left: glance('eyeX', 'headX', 'bodyX', -1),
  look_right: glance('eyeX', 'headX', 'bodyX', 1),
  look_up: glance('eyeY', 'headY', 'bodyY', 1),
  look_down: glance('eyeY', 'headY', 'bodyY', -1),
}

function interpolate(curve: Keyframes, phase: number): number {
  if (phase <= 0 || phase >= 1) return 0
  const right = curve.findIndex(([progress]) => progress >= phase)
  const [start, from] = curve[right - 1]
  const [end, to] = curve[right]
  const t = (phase - start) / (end - start)
  return from + (to - from) * t * t * (3 - 2 * t)
}

type Channel = { axis: Axis; index: number; positive: number; negative: number; offset: number; base?: number }
type CoreModel = CubismInternalModel['coreModel']

/** Apply a transient pose to the rig's real ranges while Cubism evaluates physics. */
export class GestureMotion {
  readonly available: readonly GestureName[]
  private readonly channels: Channel[]
  weight = 0

  constructor(private readonly core: CoreModel, parameters: readonly string[]) {
    this.channels = Object.entries(parameterIds).flatMap(([axis, id]) => {
      const index = parameters.indexOf(id)
      if (index < 0) return []
      const rest = core.getParameterDefaultValue(index)
      const positive = core.getParameterMaximumValue(index) - rest
      const negative = rest - core.getParameterMinimumValue(index)
      return positive > 0 && negative > 0 ? [{ axis: axis as Axis, index, positive, negative, offset: 0 }] : []
    })
    this.available = GESTURE_NAMES.filter(name => this.channels.some(channel => channel.axis === motions[name].required))
  }

  prepare(gesture: PetGesture | undefined, dt: number, reduced: boolean): GestureName | undefined {
    const motion = gesture && this.available.includes(gesture.name) ? motions[gesture.name] : undefined
    const elapsed = gesture ? Math.max(0, Date.now() - gesture.startedAt) : 0
    const active = motion && elapsed < motion.durationMs ? motion : undefined
    const intensity = (gesture?.strength === 'subtle' ? 0.64 : 1) * (reduced ? 0.58 : 1)
    const blend = 1 - Math.exp(-dt / 38)
    this.weight = 0
    for (const channel of this.channels) {
      const track = active?.tracks.find(([axis]) => axis === channel.axis)
      const delay = track?.[2] ?? 0
      const target = active && track
        ? track[1] * intensity * interpolate(active.curve, (elapsed - delay) / (active.durationMs - delay)) : 0
      channel.offset += (target - channel.offset) * blend
      if (target === 0 && Math.abs(channel.offset) < 0.001) channel.offset = 0
      this.weight = Math.max(this.weight, Math.abs(channel.offset))
    }
    return active ? gesture?.name : undefined
  }

  apply(): void {
    for (const channel of this.channels) {
      if (!channel.offset) continue
      channel.base = this.core.getParameterValueByIndex(channel.index)
      const range = channel.offset > 0 ? channel.positive : channel.negative
      this.core.setParameterValueByIndex(channel.index, channel.base + channel.offset * range)
    }
  }

  restore(): void {
    let applied = false
    for (const channel of this.channels) {
      if (channel.base === undefined) continue
      this.core.setParameterValueByIndex(channel.index, channel.base)
      channel.base = undefined
      applied = true
    }
    // Cubism saves parameters after the motion hook. Restore the unmodified pose for the next tick.
    if (applied) this.core.saveParameters()
  }

  reset(): void {
    for (const channel of this.channels) channel.offset = 0
    this.weight = 0
  }
}
