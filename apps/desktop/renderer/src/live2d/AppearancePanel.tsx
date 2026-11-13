import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { defaultLive2DIdleTuning, defaultLive2DStyle, live2DIdleLimits, type Live2DCatalog, type Live2DCue,
  type Live2DIdleTuning, type Live2DLayerShape, type Live2DMotion, type Live2DStyle } from '../../../../../packages/desktop-pet/src/live2d.ts'
import type { PetPreferencePatch, PetSnapshot, PetState } from '../../../../../packages/desktop-pet/src/types.ts'
import { petMotionEnabled } from '../../../../../packages/desktop-pet/src/motion.ts'
import Live2DView, { type Live2DControl } from './Live2DView'
import type { ModelInfo } from './cubism-stage'
import { LayerInspector, LayerList } from './LayerPanel'
import { PoseControls } from './MotionPanel'
import type { LayerPreview } from './layer-outline'
import './appearance.css'

const poses: { key: PetState; label: string }[] = [
  { key: 'off', label: '待机' }, { key: 'listening', label: '倾听' },
  { key: 'thinking', label: '思考' }, { key: 'speaking', label: '播报' },
]
const cueLabels: { key: Live2DCue; label: string }[] = [
  ...poses.slice(1), { key: 'tap', label: '点击' },
]
const mouthLabels = { open: '开合', form: '嘴角', wide: '展唇', round: '圆唇' } as const
const motionLabel = ({ group, index }: Live2DMotion) => `${group} · ${index + 1}`
const idleSliders = [
  ['speed', '待机速度'], ['head', '头部转动'], ['body', '身体与呼吸'], ['arms', '手臂转动'],
  ['hair', '头发摆动'], ['clothes', '衣摆与飘带'], ['eyes', '视线变化'],
] as const satisfies readonly (readonly [keyof Live2DIdleTuning, string])[]
const previewTabs = [['motion', '运动'], ['shape', '形变'], ['pose', '姿态测试']] as const
const meshModes = [['outline', '描边'], ['mesh', '网格'], ['compare', '形变对照'], ['off', '隐藏']] as const
const noPose: Readonly<Record<string, number>> = {}

export default function AppearancePanel({ personaId, snapshot, changePet, active }: {
  personaId: string
  snapshot: PetSnapshot | null
  changePet: (patch: PetPreferencePatch) => void
  active: boolean
}) {
  const [catalog, setCatalog] = useState<Live2DCatalog>()
  const [selected, setSelected] = useState<string>()
  const [draft, setDraft] = useState<Live2DStyle>(defaultLive2DStyle)
  const [scrub, setScrub] = useState<number>()
  const [mode, setMode] = useState<(typeof previewTabs)[number][0]>('motion')
  const [poseValues, setPoseValues] = useState(noPose)
  const [physicsPreview, setPhysicsPreview] = useState(true)
  const [framing, setFraming] = useState<Live2DStyle['frame']>()
  const [layerId, setLayerId] = useState<string>()
  const [isolate, setIsolate] = useState(false)
  const [focus, setFocus] = useState(false)
  const [display, setDisplay] = useState<LayerPreview['display']>('outline')
  const shapeDrag = useRef<{ pointer: number; id: string; at: (x: number, y: number) => Live2DLayerShape }>(null)
  const suppressPick = useRef(false)
  const timeline = useRef<HTMLInputElement>(null)
  const timelineValue = useRef<HTMLOutputElement>(null)
  const [pose, setPose] = useState<PetState>('off')
  const [expression, setExpression] = useState('')
  const [motion, setMotion] = useState(-1)
  const [info, setInfo] = useState<ModelInfo>()
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const stage = useRef<Live2DControl>(null)

  const choose = (id: string, source: Live2DCatalog) => {
    setSelected(id)
    setDraft(source.models.find(model => model.id === id)?.style ?? defaultLive2DStyle)
    setScrub(undefined)
    setMode('motion')
    setPoseValues(noPose)
    setPhysicsPreview(true)
    setFraming(undefined)
    setLayerId(undefined)
    setIsolate(false)
    setFocus(false)
    setDisplay('outline')
    shapeDrag.current = null
    suppressPick.current = false
    setPose('off')
    setInfo(undefined)
    setExpression('')
    setMotion(-1)
    setLoadError('')
    setSaved(false)
  }
  useEffect(() => {
    let active = true
    void window.deskai.getLive2DCatalog().then(value => {
      if (!active) return
      setCatalog(value)
      const binding = value.bindings[personaId]
      const firstModel = value.models.find(model => model.idle)?.id ?? ''
      const id = binding === undefined ? firstModel : binding ?? ''
      choose(value.models.some(model => model.id === id) ? id : '', value)
    }).catch(cause => { if (active) setError(String(cause)) })
    return () => { active = false }
  }, [personaId])

  const entry = catalog?.models.find(model => model.id === selected)
  const profile = useMemo(() => entry ? { ...entry, style: draft } : undefined, [entry, draft])
  const loaded = !!profile && info?.id === profile.id && !loadError
  const layers = useMemo(() => {
    if (!entry?.layers || info?.id !== entry.id) return undefined
    const present = new Set(info.drawables)
    return entry.layers.filter(layer => present.has(layer.id))
  }, [entry, info])
  const selectedLayer = layers?.find(layer => layer.id === layerId)
  const layerPreview = useMemo(() => loaded && selectedLayer ? { id: selectedLayer.id, isolate, focus, display } : undefined,
    [loaded, selectedLayer, isolate, focus, display])
  const groups = useMemo(() => {
    const live = new Set(info?.parameters ?? [])
    return (entry?.motionGroups ?? []).map(group => ({ ...group, tracks: group.tracks.filter(track => live.has(track.id)) }))
      .filter(group => group.tracks.length)
  }, [entry, info])
  const layerGroups = useMemo(() => {
    if (!selectedLayer) return groups
    const ids = selectedLayer.motion ?? []
    return groups.map(group => ({ ...group, tracks: group.tracks.filter(track => ids.includes(track.id)) }))
      .filter(group => group.tracks.length)
      .sort((a, b) => ids.indexOf(a.tracks[0].id) - ids.indexOf(b.tracks[0].id))
  }, [groups, selectedLayer])
  const reduced = !!snapshot && !petMotionEnabled(snapshot.motionMode, matchMedia('(prefers-reduced-motion: reduce)').matches)
  const idle = profile?.idle ? draft.idle ?? defaultLive2DIdleTuning : undefined
  const poseTest = mode === 'pose' && groups.length > 0
  const idlePlaying = !poseTest && scrub === undefined
  const scrubTo = (time: number) => {
    if (timeline.current) timeline.current.value = String(time)
    setScrub(time)
  }
  useEffect(() => {
    if (!active || !idlePlaying || !loaded || !info?.duration) return
    const duration = info.duration
    let raf = 0
    const refresh = () => {
      const time = stage.current?.playhead() ?? 0
      if (timeline.current) timeline.current.value = String(time)
      if (timelineValue.current) timelineValue.current.textContent = `${time.toFixed(2)} / ${duration.toFixed(2)} s`
      raf = requestAnimationFrame(refresh)
    }
    raf = requestAnimationFrame(refresh)
    return () => cancelAnimationFrame(raf)
  }, [active, idlePlaying, info?.duration, loaded])
  const motions = profile?.motions.filter(item =>
    item.group !== profile.idle?.motion.group || item.index !== profile.idle?.motion.index) ?? []
  const blink = motions.find(item => item.group.toLowerCase() === 'blink')
  const update = (patch: Partial<Live2DStyle>) => {
    if (busy) return
    setSaved(false)
    setDraft(value => ({ ...value, ...patch }))
  }
  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await operation() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const hasCore = catalog?.coreReady === true
  const frameStatus = loadError || (profile && hasCore && !loaded ? '正在加载模型…' : '')
  const previewMouth = () => {
    const seconds = performance.now() / 1000
    const phrase = Math.max(0, Math.sin(seconds * 3.1))
    return { open: (0.16 + 0.75 * Math.abs(Math.sin(seconds * 11.3))) * phrase, shape: Math.sin(seconds * 6.2) * 0.8 }
  }
  const currentMotion = motions[motion]
  const currentFrame = framing ?? draft.frame
  const applied = catalog?.bindings[personaId] === (selected || null)
  const dirty = !!entry && entry.style !== draft
  const motionPreview = idle ? { time: poseTest ? undefined : scrub, values: poseTest ? poseValues : noPose,
    neutral: poseTest, physics: physicsPreview && !poseTest && mode !== 'shape' } : undefined
  const editShape = mode === 'shape' && selectedLayer?.shape ? selectedLayer.id : undefined
  const selectLayer = (id?: string) => {
    setLayerId(id)
    if (!id) {
      setIsolate(false)
      setFocus(false)
    }
  }
  const pickLayer = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressPick.current || !layers || !(event.target instanceof HTMLCanvasElement)) return
    const ids = stage.current?.pick(event.clientX, event.clientY) ?? []
    if (!ids.length) {
      if (!focus && !isolate) selectLayer(undefined)
      return
    }
    const index = event.altKey && layerId ? ids.indexOf(layerId) + 1 : 0
    selectLayer(ids[index % ids.length])
  }
  const toggleIdle = () => {
    if (idlePlaying) scrubTo(stage.current?.playhead() ?? 0)
    else {
      setMode('motion')
      setScrub(undefined)
    }
    stage.current?.restGaze()
  }
  const changeMode = (next: typeof mode) => {
    setMode(next)
    if (next === 'shape') {
      scrubTo(stage.current?.playhead() ?? 0)
      setDisplay('mesh')
    } else if (next === 'motion') setScrub(undefined)
    else if (next === 'pose') {
      setPose('off')
      setExpression('')
    }
  }
  const startShapeDrag = (event: PointerEvent<HTMLDivElement>) => {
    suppressPick.current = false
    if (!editShape || busy || event.button !== 0 || !(event.target instanceof HTMLCanvasElement)) return
    const at = stage.current?.dragShape(event.clientX, event.clientY)
    if (!at) return
    event.preventDefault()
    suppressPick.current = true
    shapeDrag.current = { pointer: event.pointerId, id: editShape, at }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveStage = (event: PointerEvent<HTMLDivElement>) => {
    const drag = shapeDrag.current
    if (drag && drag.pointer === event.pointerId) {
      update({ layerShapes: { ...draft.layerShapes, [drag.id]: drag.at(event.clientX, event.clientY) } })
      return
    }
    if (idle) return
    const rect = event.currentTarget.getBoundingClientRect()
    stage.current?.gaze(2 * (event.clientX - rect.left) / rect.width - 1, 1 - 2 * (event.clientY - rect.top) / rect.height)
  }
  const endShapeDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (shapeDrag.current?.pointer === event.pointerId) shapeDrag.current = null
  }

  return <section className={`appearance${layers ? ' appearance-with-layers' : ''}`} aria-label="模型与动作" hidden={!active}>
    {layers && <LayerList key={selected} layers={layers} selected={selectedLayer?.id} select={selectLayer}
      focus={id => { selectLayer(id); setFocus(true) }} />}
    <div className="appearance-preview">
      <div className="appearance-toolbar">
        <div className="appearance-switch" role="group" aria-label="预览取景">
          <button type="button" disabled={!loaded} aria-pressed={!focus && currentFrame === 'full'} onClick={() => { setFocus(false); setFraming('full') }}>全身</button>
          <button type="button" disabled={!loaded} aria-pressed={!focus && currentFrame === 'portrait'} onClick={() => { setFocus(false); setFraming('portrait') }}>半身</button>
          {layers && <button type="button" disabled={!selectedLayer} aria-pressed={focus} onClick={() => setFocus(value => !value)}>聚焦图层</button>}
        </div>
        {idle && <button type="button" className="secondary appearance-play" data-playing={idlePlaying} disabled={!loaded}
          onClick={toggleIdle}>{idlePlaying ? '暂停待机' : '播放待机'}</button>}
      </div>
      <div className={`appearance-stage${layers ? ' appearance-stage-pick' : ''}`} onClick={pickLayer} onDoubleClick={event => {
        if (!suppressPick.current && layers && selectedLayer && event.target instanceof HTMLCanvasElement) setFocus(true)
      }} onPointerDown={startShapeDrag} onPointerMove={moveStage} onPointerUp={endShapeDrag}
        onPointerCancel={endShapeDrag} onLostPointerCapture={endShapeDrag} onPointerLeave={() => stage.current?.restGaze()}>
        {profile && hasCore && <Live2DView ref={stage} profile={profile} state={pose} expression={expression || undefined}
          enabled={active} reduced={idle ? false : reduced} idlePlaying={idlePlaying} framing={framing} layerPreview={layerPreview}
          motionPreview={motionPreview} editShape={editShape}
          readMouth={previewMouth} onReady={value => { setInfo(value); setLoadError('') }} onError={setLoadError} />}
        {(!profile || !hasCore || loadError) && <img src={`./pet/${snapshot?.variant ?? 'uniform-chibi'}/idle.png`} alt="静态外观预览" />}
        {frameStatus && <span className="appearance-status" role="status">{frameStatus}</span>}
        {selectedLayer && <span className="appearance-layer-caption">{selectedLayer.name}{isolate ? ' · 单层预览' : ''}</span>}
        {selectedLayer && display === 'compare' && <span className="appearance-mesh-legend"><i /> 原网格 <i /> 当前网格</span>}
        {selectedLayer && <div className="appearance-layer-tools" role="group" aria-label="图层预览">
          <select aria-label="网格显示" value={display} onChange={event => setDisplay(event.target.value as typeof display)}>
            {meshModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button type="button" className="secondary" aria-pressed={isolate} onClick={() => setIsolate(value => !value)}>只看此层</button>
        </div>}
      </div>
      {idle && !!info?.duration && <div className="appearance-timeline">
        <label><span>待机时间</span><input key={info.id} ref={timeline} type="range" aria-label="待机时间" min={0} max={info.duration} step={0.01}
          disabled={poseTest || !loaded} defaultValue={0} onChange={event => setScrub(Number(event.target.value))} />
          <output ref={timelineValue}>{`${(scrub ?? 0).toFixed(2)} / ${info.duration.toFixed(2)} s`}</output></label>
        {info.physics && <button type="button" className="secondary" aria-pressed={motionPreview?.physics ?? false}
          disabled={!loaded || mode !== 'motion'}
          onClick={() => setPhysicsPreview(value => !value)}>物理</button>}
      </div>}
      <div className="appearance-preview-footer">
        <div className="appearance-switch" role="group" aria-label="状态预览">
          {poses.map(item => <button key={item.key} type="button" aria-pressed={pose === item.key}
            disabled={!loaded || poseTest}
            onClick={() => { setPose(item.key); setExpression('') }}>{item.label}</button>)}
        </div>
        <div className="appearance-quick">
          {blink && <button type="button" className="secondary" disabled={!loaded || poseTest} onClick={() => stage.current?.play(blink)}>眨眼</button>}
          {profile?.glassesParameter && <button type="button" className="secondary" aria-pressed={!!draft.glasses}
            disabled={!loaded || busy} onClick={() => update({ glasses: !draft.glasses })}>眼镜</button>}
        </div>
      </div>
    </div>
    <div className="appearance-settings">
      <div className="appearance-model">
        <label className="appearance-model-label">桌宠模型
          <select value={selected ?? ''} disabled={!catalog || busy} onChange={event => catalog && choose(event.target.value, catalog)}>
            <option value="">静态造型</option>
            {catalog?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select>
        </label>
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => {
          const added = await window.deskai.importLive2D()
          if (added) { setCatalog(added.catalog); choose(added.id, added.catalog) }
        })}>导入模型</button>
      </div>
      {catalog?.issues.map(issue => <p className="hint" key={issue}>{issue}</p>)}
      {error && <p className="error" role="alert">{error}</p>}
      {layers && profile && <>
        <div className="appearance-switch appearance-edit-tabs" role="group" aria-label="调节模式">
          {previewTabs.map(([id, name]) => <button key={id} type="button" aria-pressed={mode === id}
            onClick={() => changeMode(id)}>{name}</button>)}
        </div>
        {poseTest ? <PoseControls groups={layerGroups.length ? layerGroups : groups} values={poseValues} disabled={!loaded || busy}
          change={(id, value) => setPoseValues(prev => ({ ...prev, [id]: value }))} reset={() => setPoseValues(noPose)} />
          : mode !== 'pose' && <LayerInspector layer={selectedLayer} profile={profile} groups={layerGroups} mode={mode}
            disabled={!loaded || busy} update={update} />}
      </>}
      {idle && <details className="appearance-idle">
        <summary>整体待机</summary>
        <header><button type="button" className="appearance-reset" disabled={!loaded || busy}
          onClick={() => { update({ idle: { ...defaultLive2DIdleTuning } }); setScrub(undefined) }}>恢复默认</button></header>
        <div className="appearance-tuning">
          {idleSliders.map(([key, label]) => {
            const speed = key === 'speed'
            const [min, max] = live2DIdleLimits[speed ? 'speed' : 'amplitude']
            const value = idle[key]
            return <label key={key} className={speed ? 'appearance-speed' : undefined}>
              <span>{label}</span><output>{speed ? `${value.toFixed(2)}×` : `${Math.round(value * 100)}%`}</output>
              <input type="range" aria-label={label} min={min} max={max} step={0.05} value={value} disabled={!loaded || busy}
                onChange={event => {
                  update({ idle: { ...idle, [key]: Number(event.target.value) } })
                  setScrub(undefined)
                }} />
            </label>
          })}
        </div>
      </details>}
      <div className="appearance-save">
        <button className="appearance-apply" type="button" disabled={busy || selected === undefined || (!!profile && !loaded)}
          onClick={() => void run(async () => {
            const result = await window.deskai.applyLive2D({ personaId, modelId: selected || null, style: profile?.style })
            setCatalog(result)
            setDraft(result.models.find(model => model.id === selected)?.style ?? defaultLive2DStyle)
            setSaved(true)
          })}>{saved ? '已应用到角色' : busy ? '正在应用…' : '应用到角色'}</button>
        <span className="hint" role="status">{saved ? '桌宠设置已保存' : dirty ? '修改未应用' : applied ? '当前使用' : '仅预览'}</span>
      </div>
      {layers && <p className="appearance-pick-help hint">点击画面选层，按住 Alt 点击切换重叠层。</p>}
      {profile && <details className="appearance-advanced"><summary>高级预览与设置</summary>
        <div className="appearance-grid">
          <label>桌宠取景<select value={draft.frame} onChange={event => {
            update({ frame: event.target.value as Live2DStyle['frame'] })
            setFraming(undefined)
          }}>
            <option value="portrait">主播半身</option><option value="full">全身</option>
          </select></label>
          <label>预览表情<select value={expression} disabled={!loaded || poseTest} onChange={event => setExpression(event.target.value)}>
            <option value="">按状态</option>{profile.expressions.map(name => <option key={name}>{name}</option>)}
          </select></label>
          <label>预览动作<select value={motion} disabled={!loaded || poseTest} onChange={event => setMotion(Number(event.target.value))}>
            <option value={-1}>选择动作</option>{motions.map((item, index) => <option key={index} value={index}>{motionLabel(item)}</option>)}
          </select></label>
          <button type="button" className="secondary appearance-action" disabled={!loaded || poseTest || !currentMotion}
            onClick={() => currentMotion && stage.current?.play(currentMotion)}>播放动作</button>
        </div>
        <div className="appearance-sliders">
          {([
            ['zoom', '缩放', 0.75, 1.6], ['x', '水平位置', -0.35, 0.35], ['y', '垂直位置', -0.35, 0.35],
            ['gaze', '视线幅度', 0, 1], ['mouthGain', '口型幅度', 0.3, 3],
          ] as const).map(([field, label, min, max]) => <label key={field}>{label} <output>{draft[field].toFixed(2)}</output>
            <input type="range" min={min} max={max} step={0.01} value={draft[field]} onChange={event => update({ [field]: Number(event.target.value) })} />
          </label>)}
        </div>
        <details><summary>口型与状态映射</summary>
          <div className="appearance-grid">
            {(Object.keys(mouthLabels) as (keyof Live2DStyle['mouth'])[]).map(key => <label key={key}>{mouthLabels[key]}
              <select disabled={!loaded} value={draft.mouth[key] ?? ''}
                onChange={event => update({ mouth: { ...draft.mouth, [key]: event.target.value || undefined } })}>
                <option value="">{key === 'open' || key === 'form' ? '自动' : '无'}</option>
                {draft.mouth[key] && !info?.parameters.includes(draft.mouth[key]) && <option value={draft.mouth[key]}>{draft.mouth[key]} · 待核对</option>}
                {info?.parameters.map(id => <option key={id}>{id}</option>)}
              </select>
            </label>)}
          </div>
          {cueLabels.map(({ key, label }) => {
            const cue = draft.cues[key]
            const index = motions.findIndex(item => item.group === cue?.motion?.group && item.index === cue?.motion?.index)
            return <div className="appearance-grid appearance-cue" key={key}>
              <label>{label}表情<select value={cue?.expression ?? ''} onChange={event => update({
                cues: { ...draft.cues, [key]: { ...cue, expression: event.target.value || undefined } },
              })}><option value="">默认</option>{profile.expressions.map(name => <option key={name}>{name}</option>)}</select></label>
              <label>{label}动作<select value={index} onChange={event => update({
                cues: { ...draft.cues, [key]: { ...cue, motion: motions[Number(event.target.value)] } },
              })}><option value={-1}>无</option>{motions.map((item, number) => <option key={number} value={number}>{motionLabel(item)}</option>)}</select></label>
            </div>
          })}
        </details>
      </details>}
      <details><summary>桌宠窗口</summary>
        <div className="appearance-grid">
          {!profile && <label>静态造型<select value={snapshot?.variant ?? 'uniform-chibi'}
            onChange={event => changePet({ variant: event.target.value as PetSnapshot['variant'] })}>
            <option value="uniform-chibi">校服 · Q 版</option><option value="uniform-normal">校服 · 原作比例</option>
            <option value="witch-chibi">魔法服 · Q 版</option><option value="witch-normal">魔法服 · 原作比例</option>
          </select></label>}
          <label>高度 {snapshot?.size ?? 220} px<input type="range" aria-label="桌宠高度" min={120} max={360} step={10}
            value={snapshot?.size ?? 220} onChange={event => changePet({ size: Number(event.target.value) })} /></label>
          <label>动态效果<select value={snapshot?.motionMode ?? 'gentle'}
            onChange={event => changePet({ motionMode: event.target.value as PetSnapshot['motionMode'] })}>
            <option value="gentle">自然动态</option><option value="reduced">减少动态</option><option value="system">跟随系统</option>
          </select></label>
          <label className="appearance-check"><input type="checkbox" checked={snapshot?.visible ?? true}
            onChange={event => changePet({ visible: event.target.checked })} />显示桌宠</label>
          <label className="appearance-check"><input type="checkbox" checked={snapshot?.alwaysOnTop ?? true}
            onChange={event => changePet({ alwaysOnTop: event.target.checked })} />保持置顶</label>
        </div>
      </details>
    </div>
  </section>
}
