import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { Live2DMotion, Live2DProfile } from '../../../../../packages/desktop-pet/src/live2d.ts'
import type { CubismStage, ModelInfo, StageState } from './cubism-stage'
import { loadCubismCore } from './core'

export type Live2DControl = {
  hit: (x: number, y: number) => boolean
  gaze: (x: number, y: number) => void
  restGaze: () => void
  tap: () => void
  play: (motion: Live2DMotion) => void
}
type Props = StageState & {
  ref?: Ref<Live2DControl>
  profile: Live2DProfile
  enabled: boolean
  onReady: (info: ModelInfo) => void
  onError: (message: string) => void
}

export default function Live2DView(props: Props) {
  const { profile, enabled, ref } = props
  const host = useRef<HTMLDivElement>(null)
  const stage = useRef<CubismStage>(null)
  const current = useRef(props)
  const [context, setContext] = useState(0)
  current.current = props

  useImperativeHandle(ref, () => ({
    hit: (x, y) => stage.current?.hit(x, y) ?? false,
    gaze: (x, y) => stage.current?.gaze(x, y),
    restGaze: () => stage.current?.restGaze(),
    tap: () => stage.current?.tap(),
    play: motion => stage.current?.play(motion),
  }), [])

  useEffect(() => {
    const node = host.current!
    let disposed = false
    let view: CubismStage | undefined
    void (async () => {
      await loadCubismCore()
      const { CubismStage } = await import('./cubism-stage')
      if (disposed) return
      view = await CubismStage.create(node, () => current.current,
        info => { if (!disposed) current.current.onReady(info) },
        message => { if (!disposed) current.current.onError(message) },
        () => setContext(epoch => epoch + 1))
      if (disposed) { view.close(); return }
      stage.current = view
      view.model(current.current.profile)
      view.show(current.current.enabled)
    })().catch(error => { if (!disposed) current.current.onError(error instanceof Error ? error.message : String(error)) })
    return () => { disposed = true; stage.current = null; view?.close() }
  }, [context])

  useEffect(() => stage.current?.model(profile), [profile])
  useEffect(() => stage.current?.frame(), [props.framing])
  useEffect(() => stage.current?.show(enabled), [enabled])
  return <div ref={host} className="live2d-view" role="img" aria-label={profile.name} data-model={profile.id} />
}
