import type { CubismInternalModel, Live2DModel } from 'untitled-pixi-live2d-engine/cubism'

export type LayerPreview = { id: string; isolate: boolean; focus: boolean; outline: boolean }

/** Mesh boundary in screen coordinates, including the current pose and local edit. */
export class LayerOutline {
  private readonly canvas = document.createElement('canvas')
  private readonly context = this.canvas.getContext('2d')!
  private readonly topology = new WeakMap<Uint16Array, number[][]>()

  constructor(private readonly host: HTMLElement) {
    this.canvas.className = 'live2d-layer-outline'
    this.canvas.setAttribute('aria-hidden', 'true')
    this.canvas.hidden = true
    host.appendChild(this.canvas)
  }

  show(model: Live2DModel<CubismInternalModel>, index: number): void {
    const { clientWidth, clientHeight } = this.host
    const ratio = Math.min(devicePixelRatio, 2)
    const w = Math.round(clientWidth * ratio), h = Math.round(clientHeight * ratio)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    const inner = model.internalModel
    const indices = inner.coreModel.getDrawableVertexIndices(index)
    let edges = this.topology.get(indices)
    if (!edges) {
      const boundary = new Map<string, number[]>()
      const edge = (a: number, b: number) => {
        const key = a < b ? `${a}/${b}` : `${b}/${a}`
        if (!boundary.delete(key)) boundary.set(key, [a * 2, b * 2])
      }
      for (let i = 0; i < indices.length; i += 3) {
        edge(indices[i], indices[i + 1])
        edge(indices[i + 1], indices[i + 2])
        edge(indices[i + 2], indices[i])
      }
      edges = [...boundary.values()]
      this.topology.set(indices, edges)
    }
    const vertices = inner.getDrawableVertices(index)
    const { a, b, c, d, tx, ty } = inner.localTransform
    const { x, y, scale } = model
    const sx = (i: number) => x + scale.x * (a * vertices[i] + c * vertices[i + 1] + tx)
    const sy = (i: number) => y + scale.y * (b * vertices[i] + d * vertices[i + 1] + ty)
    const ctx = this.context
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, clientWidth, clientHeight)
    ctx.beginPath()
    for (const [start, end] of edges) {
      ctx.moveTo(sx(start), sy(start))
      ctx.lineTo(sx(end), sy(end))
    }
    ctx.lineJoin = 'round'
    ctx.lineWidth = 3.5
    ctx.strokeStyle = '#102d30b0'
    ctx.stroke()
    ctx.lineWidth = 1.4
    ctx.strokeStyle = '#9cf5d9'
    ctx.stroke()
    this.canvas.hidden = false
  }

  hide(): void { this.canvas.hidden = true }
  close(): void { this.canvas.remove() }
}
