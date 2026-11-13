import { useState } from 'react'
import { defaultLive2DTrackTuning, live2DLayerLimits, live2DSetting, type Live2DMotionGroup, type Live2DStyle }
  from '../../../../../packages/desktop-pet/src/live2d.ts'
import { poseParameterValue, type EditorParameterGroup } from './editor-metadata'

export const percent = (value: number) => `${Math.round(value * 100)}%`

export function TuningSlider({ label, value, display, bounds: [min, max], step = 0.01, title, disabled, onChange }: {
  label: string
  value: number
  display: string
  bounds: readonly [number, number]
  step?: number
  title?: string
  disabled: boolean
  onChange: (value: number) => void
}) {
  return <label className="appearance-layer-slider" title={title}><span>{label}</span><output>{display}</output>
    <input type="range" aria-label={label} aria-valuetext={display} min={min} max={max} step={step} value={value} disabled={disabled}
      onChange={event => onChange(Number(event.target.value))} />
  </label>
}

export function MotionTracks({ groups, style, disabled, linkedCount, update }: {
  groups: Live2DMotionGroup[]
  style: Live2DStyle
  disabled: boolean
  linkedCount: (id: string) => number
  update: (patch: Partial<Live2DStyle>) => void
}) {
  const tracks = groups.flatMap(group => group.tracks)
  const [id, select] = useState(tracks[0]?.id)
  const track = tracks.find(item => item.id === id) ?? tracks[0]
  if (!track) return null
  const override = live2DSetting(style.motionTracks, track.id)
  const tuning = override ?? defaultLive2DTrackTuning
  const affected = linkedCount(track.id)
  const save = (next?: typeof tuning) => {
    const motionTracks = { ...style.motionTracks }
    delete motionTracks[track.id]
    update({ motionTracks: next ? { ...motionTracks, [track.id]: next } : motionTracks })
  }

  return <div className="appearance-layer-controls">
    <header><h3>待机动作</h3><button type="button" className="appearance-reset" disabled={disabled || !override}
      onClick={() => save()}>重置轨道</button></header>
    <label>动作轨道<select aria-label="动作轨道" value={track.id} disabled={disabled} onChange={event => select(event.target.value)}>
      {groups.map(group => <optgroup key={group.id} label={group.name}>
        {group.tracks.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </optgroup>)}
    </select></label>
    {affected > 1 && <p className="hint">这条轨道同时驱动 {affected} 层。</p>}
    <TuningSlider label="运动幅度" value={tuning.amplitude} display={percent(tuning.amplitude)} bounds={live2DLayerLimits.amplitude}
      disabled={disabled} onChange={amplitude => save({ ...tuning, amplitude })} />
    <TuningSlider label="提前 / 延迟" value={tuning.delay} display={tuning.delay === 0 ? '0 ms' : `${tuning.delay < 0 ? '提前' : '延迟'} ${Math.abs(Math.round(tuning.delay * 1000))} ms`}
      bounds={live2DLayerLimits.delay} step={0.02} disabled={disabled} onChange={delay => save({ ...tuning, delay })} />
  </div>
}

const poseNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 })

export function PoseControls({ groups, preferred, values, disabled, change, reset }: {
  groups: EditorParameterGroup[]
  preferred?: readonly string[]
  values: Readonly<Record<string, number>>
  disabled: boolean
  change: (id: string, value: number) => void
  reset: () => void
}) {
  const [selected, select] = useState<string>()
  const group = groups.find(item => item.id === selected) ??
    (preferred?.length ? groups.find(item => item.tracks.some(track => track.id === preferred[0])) : undefined) ?? groups[0]
  if (!group) return null
  return <section className="appearance-inspector" aria-label="姿态测试">
    <div className="appearance-layer-controls">
      <header><h2>姿态测试</h2><button type="button" className="appearance-reset" disabled={disabled || !Object.keys(values).length}
        onClick={reset}>恢复中立姿态</button></header>
      <label>参数分组<select value={group.id} disabled={disabled} onChange={event => select(event.target.value)}>
        {groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {group.tracks.map(track => {
        const value = live2DSetting(values, track.id) ?? 0
        return <TuningSlider key={track.id} label={track.name} value={value}
          title={`${track.id} · ${poseNumber.format(track.min)} 到 ${poseNumber.format(track.max)}`}
          display={track.degrees ? `${(value * track.degrees).toFixed(1)}°` : poseNumber.format(poseParameterValue(track, value))}
          bounds={[track.min === track.rest ? 0 : -1, track.max === track.rest ? 0 : 1]} disabled={disabled}
          onChange={next => change(track.id, next)} />
      })}
      <p className="hint">参数值仅用于预览。切回「图层调节」退出姿态测试。</p>
    </div>
  </section>
}
