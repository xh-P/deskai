import type { CubismInternalModel } from 'untitled-pixi-live2d-engine/cubism'
import type { Live2DLayerShape, Live2DProfile, Live2DStyle } from '../../../../../packages/desktop-pet/src/live2d.ts'

type Core = CubismInternalModel['coreModel']
type Sway = { id: string; index: number; rest: number; particles: { base: number; set: (delay: number) => void }[] }

export class LayerAdjustments {
  private readonly core: Core
  private readonly sway: Sway[]
  private edits = new Map<number, { shape: Live2DLayerShape; vertices: Float32Array }>()
  private readonly resetMasks = new Set<number>()
  private style?: Live2DStyle

  constructor(inner: CubismInternalModel, profile: Live2DProfile, private readonly ids: readonly string[]) {
    this.core = inner.coreModel
    const rig = inner.physics?._physicsRig
    const parameters = this.core.getModel().parameters.ids
    const channels = new Set(profile.layers?.flatMap(layer => layer.sway ?? []))
    this.sway = []
    if (!rig) return
    for (let i = 0; i < rig.subRigCount; i++) {
      const setting = rig.settings.at(i)
      const particles = Array.from({ length: setting.particleCount - 1 }, (_, j) => {
        const particle = rig.particles.at(setting.baseParticleIndex + j + 1)
        return { base: particle.delay, set: (delay: number) => { particle.delay = delay } }
      })
      for (let j = 0; j < setting.outputCount; j++) {
        const id = rig.outputs.at(setting.baseOutputIndex + j).destination.id.getString().s
        const index = parameters.indexOf(id)
        if (channels.has(id) && index >= 0) this.sway.push({ id, index, rest: this.core.getParameterDefaultValue(index), particles })
      }
    }
  }

  prepare(style: Live2DStyle): void {
    if (style === this.style) return
    this.style = style
    const edits = new Map<number, { shape: Live2DLayerShape; vertices: Float32Array }>()
    this.ids.forEach((id, index) => {
      const shape = style.layerShapes?.[id]
      if (!shape || (shape.width === 1 && shape.height === 1 && shape.bend === 0)) return
      const vertices = this.edits.get(index)?.vertices ?? new Float32Array(this.core.getDrawableVertexCount(index) * 2)
      edits.set(index, { shape, vertices })
    })
    for (const index of this.edits.keys()) if (!edits.has(index)) this.resetMasks.add(index)
    this.edits = edits
    for (const { id, particles } of this.sway) {
      const response = style.layerSway?.[id]?.response ?? 1
      for (const particle of particles) particle.set(particle.base * response)
    }
  }

  scaleSway(): void {
    if (!this.style?.layerSway) return
    for (const { id, index, rest } of this.sway) {
      const amplitude = this.style.layerSway[id]?.amplitude ?? 1
      if (amplitude === 1) continue
      const value = this.core.getParameterValueByIndex(index)
      this.core.setParameterValueByIndex(index, rest + (value - rest) * amplitude)
    }
  }

  draw(isolated: number | undefined, render: () => void): void {
    const core = this.core
    const opacity = core.getDrawableOpacity
    const visible = core.getDrawableDynamicFlagIsVisible
    const changed = core.getDrawableDynamicFlagVertexPositionsDidChange
    const positions = core.getDrawableVertexPositions
    const isolate = isolated !== undefined
    if (!isolate && !this.edits.size && !this.resetMasks.size) { render(); return }
    try {
      for (const [index, { vertices, shape: { width, height, bend } }] of this.edits) {
        const live = positions.call(core, index)
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
        for (let i = 0; i < live.length; i += 2) {
          minX = Math.min(minX, live[i])
          maxX = Math.max(maxX, live[i])
          minY = Math.min(minY, live[i + 1])
          maxY = Math.max(maxY, live[i + 1])
        }
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
        const span = maxY - minY || 1
        const halfWidth = (maxX - minX) / 2
        for (let i = 0; i < live.length; i += 2) {
          const t = (maxY - live[i + 1]) / span
          vertices[i] = cx + (live[i] - cx) * width + halfWidth * bend * t * t
          vertices[i + 1] = cy + (live[i + 1] - cy) * height
        }
      }
      // Masks use the original texture and the same deformed vertices as the color pass.
      core.getDrawableVertexPositions = i => this.edits.get(i)?.vertices ?? positions.call(core, i)
      core.getDrawableDynamicFlagVertexPositionsDidChange = i => this.edits.has(i) || this.resetMasks.has(i) || changed.call(core, i)
      if (isolate) {
        core.getDrawableDynamicFlagIsVisible = i => i === isolated
        core.getDrawableOpacity = i => i === isolated ? 1 : opacity.call(core, i)
      }
      render()
    } finally {
      core.getDrawableOpacity = opacity
      core.getDrawableDynamicFlagIsVisible = visible
      core.getDrawableVertexPositions = positions
      core.getDrawableDynamicFlagVertexPositionsDidChange = changed
      this.resetMasks.clear()
    }
  }
}
