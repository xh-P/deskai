import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultLive2DLayerShape, defaultLive2DLayerSway, live2DLayerLimits, live2DSetting,
  type Live2DMotionGroup, type Live2DProfile, type Live2DStyle } from '../../../../../packages/desktop-pet/src/live2d.ts'
import type { EditorLayer } from './editor-metadata'
import { MotionTracks, percent, TuningSlider } from './MotionPanel'

export function LayerList({ layers, selected, select, focus }: {
  layers: EditorLayer[]
  selected?: string
  select: (id?: string) => void
  focus: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const scroll = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLButtonElement>(null)
  const activeGroup = layers.find(layer => layer.id === selected)?.groupId
  const groups = useMemo(() => {
    const result = new Map<string, EditorLayer[]>()
    const search = query.trim().toLowerCase()
    for (const layer of layers) {
      if (search && !`${layer.name} ${layer.group} ${layer.id}`.toLowerCase().includes(search)) continue
      const group = result.get(layer.groupId) ?? []
      group.push(layer)
      result.set(layer.groupId, group)
    }
    return result
  }, [layers, query])
  useLayoutEffect(() => {
    const node = row.current
    const container = scroll.current
    if (!node || !container) return
    const item = node.getBoundingClientRect()
    const viewport = container.getBoundingClientRect()
    if (item.top < viewport.top) container.scrollTop += item.top - viewport.top
    if (item.bottom > viewport.bottom) container.scrollTop += item.bottom - viewport.bottom
  }, [selected])

  return <aside className="appearance-layers" aria-label="图层列表">
    <div className="appearance-layers-header">
      <header><h2>图层</h2><span>{layers.length} 层</span></header>
      <input type="search" placeholder="搜索图层" aria-label="搜索图层" value={query} onChange={event => {
        setQuery(event.target.value)
        setClosed(new Set())
      }} />
    </div>
    <div className="appearance-layer-scroll" ref={scroll}>
      {!groups.size && <p className="hint">没有匹配的图层</p>}
      {Array.from(groups, ([group, items]) => {
        const expanded = !closed.has(group) || activeGroup === group
        return <section className="appearance-layer-group" key={group}>
          <button type="button" className="appearance-layer-heading" aria-expanded={expanded} onClick={() => {
            if (activeGroup === group) select(undefined)
            setClosed(prev => {
              const next = new Set(prev)
              if (expanded) next.add(group)
              else next.delete(group)
              return next
            })
          }}><span aria-hidden="true">{expanded ? '▾' : '▸'}</span>{items[0].group}<span className="appearance-layer-count">{items.length}</span></button>
          {expanded && <ul>{items.map(layer => <li key={layer.id}>
            <button type="button" aria-pressed={selected === layer.id} data-layer-id={layer.id} title={layer.id}
              ref={selected === layer.id ? row : undefined} onClick={() => select(layer.id)}
              onDoubleClick={() => focus(layer.id)}>{layer.name}</button>
          </li>)}</ul>}
        </section>
      })}
    </div>
  </aside>
}

export function LayerInspector({ layer, profile, groups, layers, disabled, shapeEnabled, setShapeEnabled, update }: {
  layer?: EditorLayer
  profile: Live2DProfile
  groups: Live2DMotionGroup[]
  layers: EditorLayer[]
  disabled: boolean
  shapeEnabled: boolean
  setShapeEnabled: (enabled: boolean) => void
  update: (patch: Partial<Live2DStyle>) => void
}) {
  const { style } = profile
  const motion = <MotionTracks key={layer?.id} groups={groups} style={style} disabled={disabled} update={update}
    linkedCount={id => layers.filter(item => item.motion?.includes(id)).length} />
  if (!layer) return <section className="appearance-inspector" aria-label="图层微调">
    {layers.length > 0 && <p className="hint">点击画面选层，按住 Alt 点击切换重叠层。</p>}
    {motion}
  </section>
  const shapeOverride = live2DSetting(style.layerShapes, layer.id)
  const shape = shapeOverride ?? defaultLive2DLayerShape
  const updateShape = (next?: typeof shape) => {
    const layerShapes = { ...style.layerShapes }
    delete layerShapes[layer.id]
    update({ layerShapes: next ? { ...layerShapes, [layer.id]: next } : layerShapes })
  }
  const updateSway = (id: string, next?: typeof defaultLive2DLayerSway) => {
    const layerSway = { ...style.layerSway }
    delete layerSway[id]
    update({ layerSway: next ? { ...layerSway, [id]: next } : layerSway })
  }
  const swayIds = layer.sway ?? []
  const names = new Map(profile.display?.parameters.map(parameter => [parameter.id, parameter.name ?? parameter.id]))

  return <section className="appearance-inspector" aria-label="图层微调">
    <div className="appearance-inspector-title">
      <span>{layer.group}</span>
      <h2>{layer.name}</h2>
      {layer.id !== layer.name && <span>{layer.id}</span>}
    </div>
    {motion}
    {swayIds.map(id => {
      const swayOverride = live2DSetting(style.layerSway, id)
      const sway = swayOverride ?? defaultLive2DLayerSway
      const linked = layers.filter(item => item.id !== layer.id && item.sway?.includes(id))
      return <div key={id} className="appearance-layer-controls">
        <header><h3>物理摆动</h3>
          <button type="button" className="appearance-reset" disabled={disabled || !swayOverride}
            onClick={() => updateSway(id)}>重置摆动</button></header>
        {swayIds.length > 1 && <p className="hint">{names.get(id) ?? id}</p>}
        {linked.length > 0 && <p className="hint">联动层 · {linked.map(item => item.name).join('、')}</p>}
        <TuningSlider label="摆幅" value={sway.amplitude} display={percent(sway.amplitude)} bounds={live2DLayerLimits.amplitude}
          disabled={disabled} onChange={value => updateSway(id, { ...sway, amplitude: value })} />
        {profile.swayResponse?.includes(id) && <TuningSlider label="响应速度" value={sway.response}
          display={`${sway.response.toFixed(2)}×`} bounds={live2DLayerLimits.response} disabled={disabled}
          onChange={value => updateSway(id, { ...sway, response: value })} />}
      </div>
    })}
    {layer.shape && <div className="appearance-layer-controls">
      <header><h3>形变</h3><button type="button" className="appearance-reset" disabled={disabled || !shapeOverride}
        onClick={() => updateShape()}>重置形变</button></header>
      {([['width', '宽度'], ['height', '高度'], ['bend', '弯曲']] as const).map(([key, label]) =>
        <TuningSlider key={key} label={label} value={shape[key]} display={percent(shape[key])} bounds={live2DLayerLimits[key]}
          disabled={disabled} onChange={value => updateShape({ ...shape, [key]: value })} />)}
      <button type="button" className="secondary appearance-shape-tool" aria-pressed={shapeEnabled} disabled={disabled}
        onClick={() => setShapeEnabled(!shapeEnabled)}>拖动形变</button>
      {shapeEnabled && <p className="hint">拖动预览上的圆点调整高度与弯曲。</p>}
    </div>}
  </section>
}
