import type { PetVariant } from '../../../../../packages/desktop-pet/src/types.ts'

export type Rect = { x: number; y: number; width: number; height: number }
type FaceLayout = { source: [number, number]; eyes: Rect[]; mouth: Rect }

// Regions are in the original illustration's pixel coordinates. Each expression image
// contributes only these small feathered patches; the original body is never replaced.
const layouts: Record<PetVariant, FaceLayout> = {
  'uniform-chibi': { source: [1254, 1254], eyes: [
    { x: 419, y: 493, width: 153, height: 151 },
    { x: 629, y: 441, width: 176, height: 153 },
  ], mouth: { x: 591, y: 646, width: 46, height: 43 } },
  'uniform-normal': { source: [1024, 1536], eyes: [
    { x: 417, y: 196, width: 60, height: 54 },
    { x: 491, y: 162, width: 69, height: 59 },
  ], mouth: { x: 491, y: 249, width: 34, height: 28 } },
  'witch-chibi': { source: [1254, 1254], eyes: [
    { x: 469, y: 530, width: 123, height: 127 },
    { x: 642, y: 490, width: 141, height: 127 },
  ], mouth: { x: 607, y: 647, width: 48, height: 39 } },
  'witch-normal': { source: [1024, 1536], eyes: [
    { x: 451, y: 289, width: 52, height: 49 },
    { x: 510, y: 265, width: 54, height: 53 },
  ], mouth: { x: 511, y: 341, width: 39, height: 29 } },
}

export function faceRegions(variant: PetVariant, width: number, height: number) {
  const layout = layouts[variant]
  const scaleX = width / layout.source[0]
  const scaleY = height / layout.source[1]
  const scale = ({ x, y, width: w, height: h }: Rect): Rect =>
    ({ x: x * scaleX, y: y * scaleY, width: w * scaleX, height: h * scaleY })
  return { eyes: layout.eyes.map(scale), mouth: scale(layout.mouth) }
}

export function alphaBounds(image: HTMLImageElement): { bounds: Rect; alpha: Uint8Array } {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('无法读取桌宠图片像素')
  context.drawImage(image, 0, 0)
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
  const alpha = new Uint8Array(canvas.width * canvas.height)
  let left = canvas.width, top = canvas.height, right = -1, bottom = -1
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const value = rgba[(y * canvas.width + x) * 4 + 3]
      alpha[y * canvas.width + x] = value
      if (value <= 8) continue
      left = Math.min(left, x); top = Math.min(top, y)
      right = Math.max(right, x); bottom = Math.max(bottom, y)
    }
  }
  if (right < left || bottom < top) throw new Error('桌宠图片没有可见像素')
  const padding = Math.max(2, Math.round((bottom - top + 1) * 0.012))
  left = Math.max(0, left - padding); top = Math.max(0, top - padding)
  right = Math.min(canvas.width - 1, right + padding)
  bottom = Math.min(canvas.height - 1, bottom + padding)
  return { bounds: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }, alpha }
}

export function paintFacePatch(
  target: CanvasRenderingContext2D,
  source: HTMLImageElement,
  baseBounds: Rect,
  sourceBounds: Rect,
  region: Rect,
): void {
  const { x, y, width, height } = region
  const patch = document.createElement('canvas')
  patch.width = Math.max(1, Math.ceil(width))
  patch.height = Math.max(1, Math.ceil(height))
  const context = patch.getContext('2d')
  if (!context) return
  const sx = sourceBounds.x + (x - baseBounds.x) * sourceBounds.width / baseBounds.width
  const sy = sourceBounds.y + (y - baseBounds.y) * sourceBounds.height / baseBounds.height
  const sw = width * sourceBounds.width / baseBounds.width
  const sh = height * sourceBounds.height / baseBounds.height
  context.drawImage(source, sx, sy, sw, sh, 0, 0, patch.width, patch.height)
  context.globalCompositeOperation = 'destination-in'
  // A narrow rectangular feather covers the full original eye, including lashes at
  // its corners. A radial mask left parts of the open eye visible under closed lids.
  const horizontal = context.createLinearGradient(0, 0, patch.width, 0)
  horizontal.addColorStop(0, 'rgba(0,0,0,0)')
  horizontal.addColorStop(0.08, 'rgba(0,0,0,1)')
  horizontal.addColorStop(0.92, 'rgba(0,0,0,1)')
  horizontal.addColorStop(1, 'rgba(0,0,0,0)')
  context.fillStyle = horizontal
  context.fillRect(0, 0, patch.width, patch.height)
  const vertical = context.createLinearGradient(0, 0, 0, patch.height)
  vertical.addColorStop(0, 'rgba(0,0,0,0)')
  vertical.addColorStop(0.08, 'rgba(0,0,0,1)')
  vertical.addColorStop(0.92, 'rgba(0,0,0,1)')
  vertical.addColorStop(1, 'rgba(0,0,0,0)')
  context.fillStyle = vertical
  context.fillRect(0, 0, patch.width, patch.height)
  target.drawImage(patch, x, y, width, height)
}
