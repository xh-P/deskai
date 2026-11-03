import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { PetSnapshot, PetVariant } from '../../../../../packages/desktop-pet/src/types.ts'
import { petMotionEnabled } from '../../../../../packages/desktop-pet/src/motion.ts'
import { alphaBounds, faceRegions, paintFacePatch, type Rect } from './face'
import './pet.css'

type Pose = 'idle' | 'blink' | 'speaking'
type Asset = { image: HTMLImageElement; bounds: Rect; alpha: Uint8Array }
type Set = { variant: PetVariant; idle: Asset; blink: Asset | null; speaking: Asset | null }

const cache = new Map<PetVariant, Promise<Set>>()

function loadImage(variant: PetVariant, pose: Pose): Promise<Asset> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      try { resolve({ image, ...alphaBounds(image) }) }
      catch (error) { reject(error) }
    }
    image.onerror = () => reject(new Error(`桌宠素材缺失：pet/${variant}/${pose}.png`))
    image.src = new URL(`./pet/${variant}/${pose}.png`, document.baseURI).href
  })
}

function loadSet(variant: PetVariant): Promise<Set> {
  const existing = cache.get(variant)
  if (existing) return existing
  const pending = (async (): Promise<Set> => {
    const idle = await loadImage(variant, 'idle')
    const [blink, speaking] = await Promise.all([
      loadImage(variant, 'blink').catch(() => null),
      loadImage(variant, 'speaking').catch(() => null),
    ])
    return { variant, idle, blink, speaking }
  })()
  cache.set(variant, pending)
  pending.catch(() => cache.delete(variant))
  return pending
}

function paint(canvas: HTMLCanvasElement, set: Set, blink: boolean, mouth: boolean): void {
  const width = Math.max(1, Math.round(canvas.clientWidth * Math.min(devicePixelRatio || 1, 2)))
  const height = Math.max(1, Math.round(canvas.clientHeight * Math.min(devicePixelRatio || 1, 2)))
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
  const context = canvas.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, width, height)
  const base = set.idle
  // Work in source coordinates so expression patches remain attached to the same face.
  const source = document.createElement('canvas')
  source.width = base.image.naturalWidth
  source.height = base.image.naturalHeight
  const layer = source.getContext('2d')
  if (!layer) return
  layer.drawImage(base.image, 0, 0)
  const regions = faceRegions(set.variant, source.width, source.height)
  if (blink && set.blink) for (const region of regions.eyes)
    paintFacePatch(layer, set.blink.image, base.bounds, set.blink.bounds, region)
  if (mouth && set.speaking)
    paintFacePatch(layer, set.speaking.image, base.bounds, set.speaking.bounds, regions.mouth)
  context.drawImage(source, base.bounds.x, base.bounds.y, base.bounds.width, base.bounds.height,
    0, 0, width, height)
}

export default function PetApp() {
  const [snapshot, setSnapshot] = useState<PetSnapshot | null>(null)
  const [set, setSet] = useState<Set | null>(null)
  const [error, setError] = useState('')
  const [blink, setBlink] = useState(false)
  const [mouth, setMouth] = useState(false)
  const [attention, setAttention] = useState(false)
  const [degraded, setDegraded] = useState(false)
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState === 'visible')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean;
    variant: PetVariant; size: number } | null>(null)
  const hitRef = useRef<boolean | null>(null)
  const loadEpoch = useRef(0)
  const slowFrames = useRef(0)

  useEffect(() => {
    let mounted = true
    let delivered = false
    window.deskPet.setOpaqueHit(false)
    void window.deskPet.getSnapshot().then(value => { if (mounted && !delivered) setSnapshot(value) })
      .catch(cause => { if (mounted) setError(String(cause)) })
    const unsubscribe = window.deskPet.onSnapshot(value => { delivered = true; if (mounted) setSnapshot(value) })
    return () => { mounted = false; unsubscribe(); window.deskPet.setOpaqueHit(false) }
  }, [])

  useEffect(() => {
    const cancelDrag = () => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      window.deskPet.drag('end', drag.pointerId)
      hitRef.current = false
      window.deskPet.setOpaqueHit(false)
    }
    window.addEventListener('blur', cancelDrag)
    return () => { window.removeEventListener('blur', cancelDrag); cancelDrag() }
  }, [])

  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const onMotion = () => setReduced(media.matches)
    const onVisibility = () => setDocumentVisible(document.visibilityState === 'visible')
    media.addEventListener('change', onMotion)
    document.addEventListener('visibilitychange', onVisibility)
    // The preference can change between the first render and this subscription.
    onMotion()
    return () => { media.removeEventListener('change', onMotion); document.removeEventListener('visibilitychange', onVisibility) }
  }, [])

  useEffect(() => {
    if (!snapshot) return
    const epoch = ++loadEpoch.current
    setSet(null)
    setError('')
    setBlink(false)
    setMouth(false)
    setDegraded(false)
    slowFrames.current = 0
    void loadSet(snapshot.variant).then(value => {
      if (epoch !== loadEpoch.current) return
      const aspect = value.idle.bounds.width / value.idle.bounds.height
      if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('桌宠图片比例无效')
      window.deskPet.reportGeometry({ variant: value.variant, aspect })
      setSet(value)
    }).catch(cause => { if (epoch === loadEpoch.current) setError(String(cause)) })
    return () => { loadEpoch.current++ }
  }, [snapshot?.variant])

  const currentSet = set?.variant === snapshot?.variant ? set : null
  const visible = !!snapshot?.visible
  const active = !!currentSet && visible && documentVisible
  const animate = !!snapshot && petMotionEnabled(snapshot.motionMode, reduced)
  const speaking = active && snapshot?.state === 'speaking' && !!snapshot.sessionId
  const quietStatus = snapshot?.state === 'waiting' ? '等待'
    : snapshot?.state === 'silent' ? '安静'
      : snapshot?.state === 'paused' ? '暂停'
        : snapshot?.state === 'error' ? '异常' : ''
  const figureWidth = currentSet && snapshot
    ? snapshot.size * currentSet.idle.bounds.width / currentSet.idle.bounds.height : 0
  useEffect(() => {
    if (!active || !animate || degraded || !currentSet?.blink) { setBlink(false); return }
    let blinkTimer: ReturnType<typeof setTimeout>
    let closeTimer: ReturnType<typeof setTimeout>
    const schedule = () => {
      blinkTimer = setTimeout(() => {
        setBlink(true)
        closeTimer = setTimeout(() => { setBlink(false); schedule() }, 130 + Math.random() * 65)
      }, 3500 + Math.random() * 4200)
    }
    schedule()
    return () => { clearTimeout(blinkTimer); clearTimeout(closeTimer); setBlink(false) }
  }, [active, animate, degraded, currentSet?.variant, currentSet?.blink])

  useEffect(() => {
    if (!speaking || degraded || !currentSet?.speaking) { setMouth(false); return }
    if (!animate) { setMouth(true); return }
    let timer: ReturnType<typeof setTimeout>
    let open = true
    setMouth(true)
    const pulse = () => {
      timer = setTimeout(() => {
        open = !open
        setMouth(open)
        pulse()
      }, open ? 150 + Math.random() * 115 : 90 + Math.random() * 100)
    }
    pulse()
    return () => { clearTimeout(timer); setMouth(false) }
  }, [speaking, animate, degraded, currentSet?.variant, currentSet?.speaking])

  useLayoutEffect(() => {
    if (!currentSet || !canvasRef.current) return
    const canvas = canvasRef.current
    const redraw = () => {
      try {
        const started = performance.now()
        paint(canvas, currentSet, !degraded && blink && animate, !degraded && mouth)
        slowFrames.current = performance.now() - started > 50 ? slowFrames.current + 1 : 0
        if (slowFrames.current >= 3) setDegraded(true)
      } catch {
        setDegraded(true)
        try { paint(canvas, currentSet, false, false) } catch { setError('桌宠绘制失败') }
      }
    }
    redraw()
    const observer = new ResizeObserver(redraw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [currentSet, visible, blink, mouth, animate, degraded])

  useEffect(() => {
    if (!attention) return
    const timer = setTimeout(() => setAttention(false), 900)
    return () => clearTimeout(timer)
  }, [attention])

  const hit = useCallback((event: ReactMouseEvent<HTMLCanvasElement>): boolean => {
    if (!currentSet || !canvasRef.current) return false
    const rect = canvasRef.current.getBoundingClientRect()
    if (!rect.width || !rect.height) return false
    const x = Math.floor((event.clientX - rect.left) / rect.width * currentSet.idle.bounds.width + currentSet.idle.bounds.x)
    const y = Math.floor((event.clientY - rect.top) / rect.height * currentSet.idle.bounds.height + currentSet.idle.bounds.y)
    const width = currentSet.idle.image.naturalWidth
    const height = currentSet.idle.image.naturalHeight
    if (x < 0 || y < 0 || x >= width || y >= height) return false
    return currentSet.idle.alpha[y * width + x] > 16
  }, [currentSet])

  const reportHit = (opaque: boolean) => {
    if (hitRef.current === opaque) return
    hitRef.current = opaque
    window.deskPet.setOpaqueHit(opaque)
  }

  useEffect(() => {
    if (!active && hitRef.current !== false) {
      hitRef.current = false
      window.deskPet.setOpaqueHit(false)
    }
  }, [active])

  useEffect(() => {
    const drag = dragRef.current
    if (!drag || (active && drag.variant === snapshot?.variant && drag.size === snapshot.size)) return
    dragRef.current = null
    window.deskPet.drag('end', drag.pointerId)
    hitRef.current = false
    window.deskPet.setOpaqueHit(false)
  }, [active, snapshot?.variant, snapshot?.size])

  return <div className={`pet-root ${active ? 'pet-ready' : ''} ${animate ? '' : 'pet-reduced'} ${attention ? 'pet-attention' : ''} pet-${snapshot?.state ?? 'off'}`}
    data-variant={snapshot?.variant ?? ''} data-state={snapshot?.state ?? 'off'} data-ready={currentSet ? 'true' : 'false'}
    data-motion-mode={snapshot?.motionMode ?? ''} data-motion={animate ? 'on' : 'off'} data-system-reduced={reduced ? 'true' : 'false'}>
    {currentSet && visible && <div className="pet-figure" style={{ width: figureWidth, height: snapshot.size }}><canvas ref={canvasRef} className="pet-body" aria-label="长门有希桌宠"
      onPointerMove={event => {
        const drag = dragRef.current
        if (drag) {
          if (drag.pointerId !== event.pointerId) return
          if ((event.buttons & 1) === 0) {
            dragRef.current = null
            window.deskPet.drag('end', drag.pointerId)
            reportHit(hit(event))
            return
          }
          if (Math.hypot(event.screenX - drag.x, event.screenY - drag.y) > 4) drag.moved = true
          window.deskPet.drag('move', drag.pointerId)
          reportHit(hit(event))
        } else reportHit(hit(event))
      }}
      onPointerLeave={() => reportHit(false)}
      onPointerDown={event => {
        if (dragRef.current || event.button !== 0 || !hit(event)) return
        try { event.currentTarget.setPointerCapture(event.pointerId) }
        catch { return }
        dragRef.current = { pointerId: event.pointerId, x: event.screenX, y: event.screenY,
          moved: false, variant: snapshot.variant, size: snapshot.size }
        reportHit(true)
        window.deskPet.drag('start', event.pointerId)
      }}
      onPointerUp={event => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        dragRef.current = null
        window.deskPet.drag('end', drag.pointerId)
        if (!drag.moved && animate) setAttention(true)
        reportHit(hit(event))
      }}
      onPointerCancel={event => {
        if (dragRef.current?.pointerId !== event.pointerId) return
        window.deskPet.drag('end', event.pointerId)
        dragRef.current = null
        reportHit(false)
      }}
      onLostPointerCapture={event => {
        if (dragRef.current?.pointerId !== event.pointerId) return
        window.deskPet.drag('end', event.pointerId)
        dragRef.current = null
        reportHit(false)
      }}
      onContextMenu={event => { if (!hit(event)) return; event.preventDefault(); window.deskPet.showContextMenu() }} /></div>}
    {speaking && !!snapshot?.subtitle.trim() && <div className="pet-subtitle" aria-live="polite">{snapshot.subtitle}</div>}
    {active && quietStatus && <div className={`pet-status pet-status-${snapshot?.state}`} aria-live="polite">
      <span className="pet-status-dot" aria-hidden="true" />{quietStatus}
    </div>}
    {error && <div className="pet-error" role="alert">{error}</div>}
  </div>
}
