import { meshProjection, type MeshModel } from './layer-picking'

export type LayerPreview = { id: string; isolate: boolean; focus: boolean; display: 'outline' | 'mesh' | 'compare' | 'off' }
type Edge = [number, number]
type Topology = { outline: Edge[]; mesh: Edge[] }

/** Cubism triangles in the current pose, with an optional unedited reference. */
export class LayerOutline {
  private readonly canvas = document.createElement('canvas')
  private readonly context = this.canvas.getContext('2d')!
  private readonly topology = new Map<number, Topology>()

  constructor(private readonly host: HTMLElement) {
    this.canvas.className = 'live2d-layer-outline'
    this.canvas.setAttribute('aria-hidden', 'true')
    this.canvas.hidden = true
    host.appendChild(this.canvas)
  }

  show(model: MeshModel, index: number, mode: LayerPreview['display'], original: Float32Array, handle?: { x: number; y: number }): void {
    const { clientWidth, clientHeight } = this.host
    const ratio = Math.min(devicePixelRatio, 2)
    const w = Math.round(clientWidth * ratio), h = Math.round(clientHeight * ratio)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    const core = model.internalModel.coreModel
    let topology = this.topology.get(index)
    if (!topology) {
      const indices = core.getDrawableVertexIndices(index)
      const edges = new Map<string, { edge: Edge; count: number }>()
      const edge = (a: number, b: number) => {
        const key = a < b ? `${a}/${b}` : `${b}/${a}`
        const existing = edges.get(key)
        if (existing) existing.count++
        else edges.set(key, { edge: [a * 2, b * 2], count: 1 })
      }
      for (let i = 0; i < indices.length; i += 3) {
        edge(indices[i], indices[i + 1])
        edge(indices[i + 1], indices[i + 2])
        edge(indices[i + 2], indices[i])
      }
      const unique = [...edges.values()]
      topology = { outline: unique.filter(edge => edge.count === 1).map(item => item.edge), mesh: unique.map(item => item.edge) }
      this.topology.set(index, topology)
    }
    const vertices = core.getDrawableVertexPositions(index)
    const project = meshProjection(model).screen
    const toScreen = (values: Float32Array) => {
      const points: [number, number][] = []
      for (let i = 0; i < values.length; i += 2) points.push(project(values[i], values[i + 1]))
      return points
    }
    const points = toScreen(vertices)
    const ctx = this.context
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, clientWidth, clientHeight)
    const trace = (edges: Edge[], positions: [number, number][]) => {
      ctx.beginPath()
      for (const [start, end] of edges) {
        ctx.moveTo(...positions[start / 2])
        ctx.lineTo(...positions[end / 2])
      }
    }
    if (mode === 'compare' && original !== vertices) {
      trace(topology.mesh, toScreen(original))
      ctx.setLineDash([3, 3])
      ctx.strokeStyle = '#ffc689b0'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
    }
    if (mode === 'mesh' || mode === 'compare') {
      trace(topology.mesh, points)
      ctx.strokeStyle = '#9cf5d995'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = '#ceffec'
      const step = Math.max(1, Math.ceil(points.length / 400))
      for (let i = 0; i < points.length; i += step) ctx.fillRect(points[i][0] - 1, points[i][1] - 1, 2, 2)
    }
    if (mode !== 'off') {
      trace(topology.outline, points)
      ctx.lineJoin = 'round'
      ctx.lineWidth = 3.5
      ctx.strokeStyle = '#102d30b0'
      ctx.stroke()
      ctx.lineWidth = 1.4
      ctx.strokeStyle = '#9cf5d9'
      ctx.stroke()
    }
    if (handle) {
      const [x, y] = project(handle.x, handle.y)
      ctx.beginPath()
      ctx.arc(x, y, 7, 0, Math.PI * 2)
      ctx.fillStyle = '#b3ffe8'
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = '#193a39'
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(x - 3, y)
      ctx.lineTo(x + 3, y)
      ctx.moveTo(x, y - 3)
      ctx.lineTo(x, y + 3)
      ctx.stroke()
    }
    this.canvas.dataset.mode = mode
    this.canvas.hidden = false
  }

  reset(): void { this.topology.clear(); this.hide() }
  hide(): void { this.canvas.hidden = true }
  close(): void { this.canvas.remove() }
}
