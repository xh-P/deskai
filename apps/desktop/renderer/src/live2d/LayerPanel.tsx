import { useMemo, useState } from 'react'
import { defaultLive2DLayerShape, defaultLive2DLayerSway, live2DLayerLimits, type Live2DLayer,
  type Live2DProfile, type Live2DStyle } from '../../../../../packages/desktop-pet/src/live2d.ts'

const percent = (value: number) => `${Math.round(value * 100)}%`

export function LayerList({ layers, selected, select, focus }: {
  layers: Live2DLayer[]
  selected?: string
  select: (id: string) => void
  focus: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
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

  return <aside className="appearance-layers" aria-label="图层列表">
    <div className="appearance-layers-header">
      <header><h2>图层</h2><span>{layers.length} 层</span></header>
      <input type="search" placeholder="搜索图层" aria-label="搜索图层" value={query} onChange={event => {
        setQuery(event.target.value)
        setClosed(new Set())
      }} />
    </div>
    <div className="appearance-layer-scroll">
      {!groups.size && <p className="hint">没有匹配的图层</p>}
      {Array.from(groups, ([group, items]) => {
        const expanded = !closed.has(group)
        return <section className="appearance-layer-group" key={group}>
          <button type="button" className="appearance-layer-heading" aria-expanded={expanded} onClick={() => {
            setClosed(prev => {
              const next = new Set(prev)
              if (expanded) next.add(group)
              else next.delete(group)
              return next
            })
          }}><span aria-hidden="true">{expanded ? '▾' : '▸'}</span>{group}<span className="appearance-layer-count">{items.length}</span></button>
          {expanded && <ul>{items.map(layer => <li key={layer.id}>
            <button type="button" aria-pressed={selected === layer.id} data-layer-id={layer.id}
            onClick={() => select(layer.id)} onDoubleClick={() => focus(layer.id)}>{layer.name}</button>
          </li>)}</ul>}
        </section>
      })}
    </div>
  </aside>
}

export function LayerInspector({ layer, profile, disabled, update }: {
  layer?: Live2DLayer
  profile: Live2DProfile
  disabled: boolean
  update: (patch: Partial<Live2DStyle>) => void
}) {
  if (!layer) return <section className="appearance-inspector"><h2>图层微调</h2><p className="hint">从左侧选一个图层。</p></section>
  const { style } = profile
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

  return <section className="appearance-inspector" aria-label="图层微调">
    <div className="appearance-inspector-title">
      <span>{layer.group}</span>
      <h2>{layer.name}</h2>
    </div>
    <div className="appearance-layer-controls">
      <header><h3>形变</h3><button type="button" className="appearance-reset" disabled={disabled || !style.layerShapes?.[layer.id]}
        onClick={() => updateShape()}>重置形变</button></header>
      {([['width', '宽度'], ['height', '高度'], ['bend', '弯曲']] as const).map(([key, label]) =>
        <LayerSlider key={key} label={label} value={shape[key]} display={percent(shape[key])} bounds={live2DLayerLimits[key]}
          disabled={disabled} onChange={value => updateShape({ ...shape, [key]: value })} />)}
    </div>
    <div className="appearance-layer-controls">
      {!layer.sway?.length && <p className="hint">此层随所属部位运动，可在「整体待机」调节。</p>}
      {layer.sway?.map((id, index) => {
        const sway = style.layerSway?.[id] ?? defaultLive2DLayerSway
        const linked = profile.layers?.filter(item => item.id !== layer.id && item.sway?.includes(id)) ?? []
        return <div key={id}>
          <header><h3>{layer.sway!.length > 1 ? `摆动 ${index + 1}` : '摆动'}</h3>
            <button type="button" className="appearance-reset" disabled={disabled || !style.layerSway?.[id]}
              onClick={() => updateSway(id)}>重置摆动</button></header>
          {linked.length > 0 && <p className="hint">联动层 · {linked.map(item => item.name).join('、')}</p>}
          <LayerSlider label="摆幅" value={sway.amplitude} display={percent(sway.amplitude)} bounds={live2DLayerLimits.amplitude}
            disabled={disabled} onChange={value => updateSway(id, { ...sway, amplitude: value })} />
          <LayerSlider label="响应速度" value={sway.response} display={`${sway.response.toFixed(2)}×`} bounds={live2DLayerLimits.response}
            disabled={disabled} onChange={value => updateSway(id, { ...sway, response: value })} />
        </div>
      })}
    </div>
  </section>
}

function LayerSlider({ label, value, display, bounds: [min, max], disabled, onChange }: {
  label: string
  value: number
  display: string
  bounds: readonly [number, number]
  disabled: boolean
  onChange: (value: number) => void
}) {
  return <label className="appearance-layer-slider"><span>{label}</span><output>{display}</output>
    <input type="range" aria-label={label} aria-valuetext={display} min={min} max={max} step={0.01} value={value} disabled={disabled}
      onChange={event => onChange(Number(event.target.value))} />
  </label>
}
