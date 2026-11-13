import { live2DLayerLimits, type Live2DLayerShape, type Live2DSoftShape }
  from '../../../../../packages/desktop-pet/src/live2d.ts'

export function shapeFrame(vertices: Float32Array) {
  let left = Infinity, right = -Infinity, top = -Infinity, bottom = Infinity
  for (let i = 0; i < vertices.length; i += 2) {
    left = Math.min(left, vertices[i])
    right = Math.max(right, vertices[i])
    top = Math.max(top, vertices[i + 1])
    bottom = Math.min(bottom, vertices[i + 1])
  }
  return { center: (left + right) / 2, halfWidth: (right - left) / 2, top, height: top - bottom }
}

const influence = (kind: Live2DSoftShape, t: number) => kind === 'seamed' ? Math.sin(Math.PI * t) ** 2 : t * t

export function deformShape(source: Float32Array, output: Float32Array, shape: Live2DLayerShape, kind: Live2DSoftShape): void {
  const { center, halfWidth, top, height } = shapeFrame(source)
  for (let i = 0; i < source.length; i += 2) {
    const y = source[i + 1] - top
    const weight = influence(kind, -y / (height || 1))
    output[i] = source[i] + ((source[i] - center) * (shape.width - 1) + halfWidth * shape.bend) * weight
    output[i + 1] = source[i + 1] + y * (shape.height - 1) * weight
  }
}

export function shapeHandle(source: Float32Array, shape: Live2DLayerShape, kind: Live2DSoftShape) {
  const { center, halfWidth, top, height } = shapeFrame(source)
  const t = kind === 'seamed' ? 0.56 : 1
  const weight = influence(kind, t)
  const bendScale = halfWidth * weight
  const heightScale = -height * t * weight
  const x = center + shape.bend * bendScale
  const y = top - height * t + (shape.height - 1) * heightScale
  const limit = (value: number, [min, max]: readonly [number, number]) => Math.round(100 * Math.max(min, Math.min(max, value))) / 100
  return { x, y, update: (dx: number, dy: number): Live2DLayerShape => ({
    ...shape,
    bend: limit(shape.bend + dx / (bendScale || 1), live2DLayerLimits.bend),
    height: limit(shape.height + dy / (heightScale || 1), live2DLayerLimits.height),
  }) }
}
