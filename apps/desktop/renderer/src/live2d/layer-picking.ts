import type { CubismInternalModel, Live2DModel } from 'untitled-pixi-live2d-engine/cubism'

export type MeshModel = Live2DModel<CubismInternalModel>
type Atlas = { width: number; height: number; alpha: Uint8Array }

export function meshProjection(model: MeshModel) {
  const { originalWidth, originalHeight, pixelsPerUnit, localTransform } = model.internalModel
  const { a, b, c, d, tx, ty } = localTransform
  const { x, y, scale } = model
  return {
    screen(vx: number, vy: number): [number, number] {
      const lx = vx * pixelsPerUnit + originalWidth / 2
      const ly = originalHeight / 2 - vy * pixelsPerUnit
      return [x + scale.x * (a * lx + c * ly + tx), y + scale.y * (b * lx + d * ly + ty)]
    },
    model(sx: number, sy: number): [number, number] {
      const lx = (sx - x) / scale.x - tx
      const ly = (sy - y) / scale.y - ty
      const det = a * d - b * c
      return [((d * lx - c * ly) / det - originalWidth / 2) / pixelsPerUnit,
        (originalHeight / 2 - (a * ly - b * lx) / det) / pixelsPerUnit]
    },
  }
}

/** Hit tests the same indexed triangles, atlas alpha and clipping masks as the preview. */
export class LayerPicking {
  private readonly atlases = new Map<number, Atlas | undefined>()

  constructor(private readonly model: MeshModel, private readonly ids: string[], private readonly layers: ReadonlySet<string>) {}

  at(screenX: number, screenY: number, positions: (index: number) => Float32Array, isolated?: number): string[] {
    const inner = this.model.internalModel
    const core = inner.coreModel
    const [x, y] = meshProjection(this.model).model(screenX, screenY)
    const masked = core.getDrawableMasks()
    const orders = core.getDrawableRenderOrders()
    const inside = (index: number) => this.contains(index, x, y, positions(index))
    const maskHits = new Map<number, boolean>()
    const hits: number[] = []
    for (let index = 0; index < this.ids.length; index++) {
      if (!this.layers.has(this.ids[index])) continue
      if (isolated === undefined ? !core.getDrawableDynamicFlagIsVisible(index) || core.getDrawableOpacity(index) < 0.08 : index !== isolated) continue
      if (!inside(index)) continue
      const masks = masked[index]
      if (masks?.length) {
        const covered = masks.some(mask => {
          if (!maskHits.has(mask)) maskHits.set(mask, inside(mask))
          return maskHits.get(mask)
        })
        if (covered === core.getDrawableInvertedMaskBit(index)) continue
      }
      hits.push(index)
    }
    return hits.sort((a, b) => orders[b] - orders[a]).map(index => this.ids[index])
  }

  private contains(index: number, x: number, y: number, vertices: Float32Array): boolean {
    const inner = this.model.internalModel
    const core = inner.coreModel
    const triangles = core.getDrawableVertexIndices(index)
    const uv = core.getDrawableVertexUvs(index)
    for (let i = 0; i < triangles.length; i += 3) {
      const a = 2 * triangles[i], b = 2 * triangles[i + 1], c = 2 * triangles[i + 2]
      const abX = vertices[b] - vertices[a], abY = vertices[b + 1] - vertices[a + 1]
      const acX = vertices[c] - vertices[a], acY = vertices[c + 1] - vertices[a + 1]
      const det = abX * acY - abY * acX
      if (Math.abs(det) < 1e-10) continue
      const dx = x - vertices[a], dy = y - vertices[a + 1]
      const v = (dx * acY - dy * acX) / det, w = (abX * dy - abY * dx) / det
      const u = 1 - v - w
      if (u < 0 || v < 0 || w < 0) continue
      const atlas = this.atlas(core.getDrawableTextureIndex(index))
      if (!atlas) return true
      const tu = uv[a] * u + uv[b] * v + uv[c] * w
      const tv = uv[a + 1] * u + uv[b + 1] * v + uv[c + 1] * w
      const px = Math.min(atlas.width - 1, Math.max(0, Math.floor(tu * atlas.width)))
      const py = Math.min(atlas.height - 1, Math.max(0, Math.floor((inner.textureFlipY ? tv : 1 - tv) * atlas.height)))
      if (atlas.alpha[py * atlas.width + px] > 24) return true
    }
    return false
  }

  private atlas(index: number): Atlas | undefined {
    if (this.atlases.has(index)) return this.atlases.get(index)
    const source = this.model.textures[index]?.source
    let atlas: Atlas | undefined
    if (source?.resource && source.pixelWidth && source.pixelHeight) {
      const canvas = document.createElement('canvas')
      canvas.width = source.pixelWidth
      canvas.height = source.pixelHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      try {
        if (ctx) {
          ctx.drawImage(source.resource as CanvasImageSource, 0, 0, canvas.width, canvas.height)
          const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data
          const alpha = new Uint8Array(canvas.width * canvas.height)
          for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3]
          atlas = { width: canvas.width, height: canvas.height, alpha }
        }
      } catch { /* Some imported texture resources only support GPU sampling. */ }
    }
    this.atlases.set(index, atlas)
    return atlas
  }
}
