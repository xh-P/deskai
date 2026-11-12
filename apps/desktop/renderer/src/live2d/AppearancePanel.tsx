import { useEffect, useMemo, useRef, useState } from 'react'
import { defaultLive2DStyle, type Live2DCatalog, type Live2DCue, type Live2DMotion, type Live2DStyle } from '../../../../../packages/desktop-pet/src/live2d.ts'
import type { PetPreferencePatch, PetSnapshot, PetState } from '../../../../../packages/desktop-pet/src/types.ts'
import { petMotionEnabled } from '../../../../../packages/desktop-pet/src/motion.ts'
import Live2DView, { type Live2DControl } from './Live2DView'
import type { ModelInfo } from './cubism-stage'
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

export default function AppearancePanel({ personaId, snapshot, changePet }: {
  personaId: string
  snapshot: PetSnapshot | null
  changePet: (patch: PetPreferencePatch) => void
}) {
  const [catalog, setCatalog] = useState<Live2DCatalog>()
  const [selected, setSelected] = useState<string>()
  const [draft, setDraft] = useState<Live2DStyle>(defaultLive2DStyle)
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
      const binding = value.bindings[personaId] === null ? '' : value.bindings[personaId] ?? value.defaultModelId
      choose(value.models.some(model => model.id === binding) ? binding : '', value)
    }).catch(cause => { if (active) setError(String(cause)) })
    return () => { active = false }
  }, [personaId])

  const entry = catalog?.models.find(model => model.id === selected)
  const profile = useMemo(() => entry ? { ...entry, style: draft } : undefined, [entry, draft])
  const loaded = !!profile && info?.id === profile.id && !loadError
  const reduced = !!snapshot && !petMotionEnabled(snapshot.motionMode, matchMedia('(prefers-reduced-motion: reduce)').matches)
  const update = (patch: Partial<Live2DStyle>) => { setSaved(false); setDraft(value => ({ ...value, ...patch })) }
  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await operation() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const hasCore = catalog?.coreReady === true
  const frameStatus = loadError || (loaded ? '模型就绪' : profile && hasCore ? '正在加载模型' : '')
  const previewMouth = () => {
    const seconds = performance.now() / 1000
    const phrase = Math.max(0, Math.sin(seconds * 3.1))
    return { open: (0.16 + 0.75 * Math.abs(Math.sin(seconds * 11.3))) * phrase, shape: Math.sin(seconds * 6.2) * 0.8 }
  }
  const currentMotion = profile && profile.motions[motion]

  return <section className="appearance" aria-label="角色外观">
    <div className="appearance-preview">
      <div className="appearance-stage" onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect()
        stage.current?.gaze(2 * (event.clientX - rect.left) / rect.width - 1, 1 - 2 * (event.clientY - rect.top) / rect.height)
      }} onPointerLeave={() => stage.current?.restGaze()}>
        {profile && hasCore ? <Live2DView ref={stage} profile={profile} state={pose} expression={expression || undefined}
          enabled reduced={reduced} readMouth={previewMouth} onReady={value => { setInfo(value); setLoadError('') }} onError={setLoadError} />
          : <img src={`./pet/${snapshot?.variant ?? 'uniform-chibi'}/idle.png`} alt="静态外观预览" />}
        {frameStatus && <span className="appearance-status" data-ready={loaded} role="status">{frameStatus}</span>}
      </div>
      <div className="appearance-poses" role="group" aria-label="状态预览">
        {poses.map(item => <button key={item.key} type="button" aria-pressed={pose === item.key} disabled={!loaded}
          onClick={() => { setPose(item.key); setExpression('') }}>{item.label}</button>)}
      </div>
    </div>
    <div className="appearance-settings">
      <header><h2>角色外观</h2><button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => {
        const added = await window.deskai.importLive2D()
        if (added) { setCatalog(added.catalog); choose(added.id, added.catalog) }
      })}>导入模型</button></header>
      {catalog?.issues.map(issue => <p className="hint" key={issue}>{issue}</p>)}
      {error && <p className="error" role="alert">{error}</p>}
      <label>桌宠模型
        <select value={selected ?? ''} disabled={!catalog || busy} onChange={event => catalog && choose(event.target.value, catalog)}>
          <option value="">静态造型</option>
          {catalog?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      {profile && <>
        {loaded && <p className="hint">{info.parameters.length} 个参数 · {profile.expressions.length} 个表情 · {profile.motions.length} 个动作{info.physics && ' · 物理已启用'}</p>}
        <div className="appearance-grid">
          <label>取景<select value={draft.frame} onChange={event => update({ frame: event.target.value as Live2DStyle['frame'] })}>
            <option value="portrait">主播半身</option><option value="full">全身</option>
          </select></label>
          <label>预览表情<select value={expression} disabled={!loaded} onChange={event => setExpression(event.target.value)}>
            <option value="">按状态</option>{profile.expressions.map(name => <option key={name}>{name}</option>)}
          </select></label>
          <label>预览动作<select value={motion} disabled={!loaded} onChange={event => setMotion(Number(event.target.value))}>
            <option value={-1}>选择动作</option>{profile.motions.map((item, index) => <option key={index} value={index}>{motionLabel(item)}</option>)}
          </select></label>
          <button type="button" className="secondary appearance-action" disabled={!loaded || !currentMotion}
            onClick={() => currentMotion && stage.current?.play(currentMotion)}>播放动作</button>
        </div>
        <details><summary>取景与动态</summary><div className="appearance-sliders">
          {([
            ['zoom', '缩放', 0.75, 1.6], ['x', '水平位置', -0.35, 0.35], ['y', '垂直位置', -0.35, 0.35],
            ['gaze', '视线幅度', 0, 1], ['mouthGain', '口型幅度', 0.3, 3],
          ] as const).map(([field, label, min, max]) => <label key={field}>{label} <output>{draft[field].toFixed(2)}</output>
            <input type="range" min={min} max={max} step={0.01} value={draft[field]} onChange={event => update({ [field]: Number(event.target.value) })} />
          </label>)}
        </div></details>
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
            const index = profile.motions.findIndex(item => item.group === cue?.motion?.group && item.index === cue?.motion?.index)
            return <div className="appearance-grid appearance-cue" key={key}>
              <label>{label}表情<select value={cue?.expression ?? ''} onChange={event => update({
                cues: { ...draft.cues, [key]: { ...cue, expression: event.target.value || undefined } },
              })}><option value="">默认</option>{profile.expressions.map(name => <option key={name}>{name}</option>)}</select></label>
              <label>{label}动作<select value={index} onChange={event => update({
                cues: { ...draft.cues, [key]: { ...cue, motion: profile.motions[Number(event.target.value)] } },
              })}><option value={-1}>无</option>{profile.motions.map((item, number) => <option key={number} value={number}>{motionLabel(item)}</option>)}</select></label>
            </div>
          })}
        </details>
      </>}
      <button className="appearance-apply" type="button" disabled={busy || selected === undefined || (!!profile && !loaded)}
        onClick={() => void run(async () => {
          setCatalog(await window.deskai.applyLive2D({ personaId, modelId: selected || null, style: profile?.style }))
          setSaved(true)
        })}>{saved ? '已应用到角色' : '应用到角色'}</button>
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
