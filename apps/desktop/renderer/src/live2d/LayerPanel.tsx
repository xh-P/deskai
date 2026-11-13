import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultLive2DLayerShape, defaultLive2DLayerSway, live2DLayerLimits, type Live2DLayer,
  type Live2DMotionGroup, type Live2DProfile, type Live2DStyle } from '../../../../../packages/desktop-pet/src/live2d.ts'
import { MotionTracks, percent, TuningSlider } from './MotionPanel'

export function LayerList({ layers, selected, select, focus }: {
  layers: Live2DLayer[]
  selected?: string
  select: (id?: string) => void
  focus: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const scroll = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLButtonElement>(null)
  const activeGroup = layers.find(layer => layer.id === selected)?.group
  const groups = useMemo(() => {
    const result = new Map<string, Live2DLayer[]>()
    const search = query.trim().toLowerCase()
    for (const layer of layers) {
      if (search && !`${layer.name} ${layer.group} ${layer.id}`.toLowerCase().includes(search)) continue
      const group = result.get(layer.group) ?? []
      group.push(layer)
      result.set(layer.group, group)
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
          }}><span aria-hidden="true">{expanded ? '▾' : '▸'}</span>{group}<span className="appearance-layer-count">{items.length}</span></button>
          {expanded && <ul>{items.map(layer => <li key={layer.id}>
            <button type="button" aria-pressed={selected === layer.id} data-layer-id={layer.id}
              ref={selected === layer.id ? row : undefined} onClick={() => select(layer.id)}
              onDoubleClick={() => focus(layer.id)}>{layer.name}</button>
          </li>)}</ul>}
        </section>
      })}
    </div>
  </aside>
}

export function LayerInspector({ layer, profile, groups, mode, disabled, update }: {
  layer?: Live2DLayer
  profile: Live2DProfile
  groups: Live2DMotionGroup[]
  mode: 'motion' | 'shape'
  disabled: boolean
  update: (patch: Partial<Live2DStyle>) => void
}) {
  const { style } = profile
  const motion = <MotionTracks key={layer?.id} groups={groups} style={style} disabled={disabled} update={update}
    linkedCount={id => profile.layers?.filter(item => item.motion?.includes(id)).length ?? 0} />
  if (!layer) return <section className="appearance-inspector"><h2>图层微调</h2><p className="hint">点画面或从左侧选择图层。</p>
    {mode === 'motion' && motion}
  </section>
  const shape = style.layerShapes?.[layer.id] ?? defaultLive2DLayerShape
  const updateShape = (next?: typeof shape) => {
    const shapes = { ...style.layerShapes }
    if (next) shapes[layer.id] = next
    else delete shapes[layer.id]
    update({ layerShapes: shapes })
  }
  const updateSway = (id: string, next?: typeof defaultLive2DLayerSway) => {
    const values = { ...style.layerSway }
    if (next) values[id] = next
    else delete values[id]
    update({ layerSway: values })
  }

  let controls
  if (mode === 'shape') {
    controls = layer.shape ? <div className="appearance-layer-controls">
      <header><h3>形变</h3><button type="button" className="appearance-reset" disabled={disabled || !style.layerShapes?.[layer.id]}
        onClick={() => updateShape()}>重置形变</button></header>
      {([['width', '宽度'], ['height', '高度'], ['bend', '弯曲']] as const).map(([key, label]) =>
        <TuningSlider key={key} label={label} value={shape[key]} display={percent(shape[key])} bounds={live2DLayerLimits[key]}
          disabled={disabled} onChange={value => updateShape({ ...shape, [key]: value })} />)}
      <p className="hint">{layer.shape === 'seamed' ? '衣袖两端固定，拖画面上的圆点调整中段。' : '固定上缘，拖画面上的圆点调整弯曲和高度。'}</p>
    </div> : <p className="hint">此层的姿态随已有绑定运动。可在「运动」调节。</p>
  } else {
    controls = <>{motion}
      {layer.sway?.map(id => {
        const sway = style.layerSway?.[id] ?? defaultLive2DLayerSway
        const linked = profile.layers?.filter(item => item.id !== layer.id && item.sway?.includes(id)) ?? []
        return <div key={id} className="appearance-layer-controls">
          <header><h3>物理摆动</h3>
            <button type="button" className="appearance-reset" disabled={disabled || !style.layerSway?.[id]}
              onClick={() => updateSway(id)}>重置摆动</button></header>
          {linked.length > 0 && <p className="hint">联动层 · {linked.map(item => item.name).join('、')}</p>}
          <TuningSlider label="摆幅" value={sway.amplitude} display={percent(sway.amplitude)} bounds={live2DLayerLimits.amplitude}
            disabled={disabled} onChange={value => updateSway(id, { ...sway, amplitude: value })} />
          <TuningSlider label="响应速度" value={sway.response} display={`${sway.response.toFixed(2)}×`} bounds={live2DLayerLimits.response}
            disabled={disabled} onChange={value => updateSway(id, { ...sway, response: value })} />
        </div>
      })}
    </>
  }

  return <section className="appearance-inspector" aria-label="图层微调">
    <div className="appearance-inspector-title">
      <span>{layer.group}</span>
      <h2>{layer.name}</h2>
    </div>
    {controls}
  </section>
}
