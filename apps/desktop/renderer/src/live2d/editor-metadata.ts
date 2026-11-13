import type { Live2DDisplayEntry, Live2DLayer, Live2DMotionTrack, Live2DProfile } from '../../../../../packages/desktop-pet/src/live2d.ts'
import type { CubismInternalModel } from 'untitled-pixi-live2d-engine/cubism'

export type EditorLayer = Live2DLayer & { group: string; groupId: string }
export type EditorParameter = Live2DMotionTrack & { min: number; max: number; rest: number }
export type EditorParameterGroup = { id: string; name: string; tracks: EditorParameter[] }
type Core = CubismInternalModel['coreModel']

function groupLabel(groups: Map<string, Live2DDisplayEntry>, id: string): string {
  const names: string[] = []
  const seen = new Set<string>()
  let current: string | undefined = id
  while (current && !seen.has(current)) {
    seen.add(current)
    const entry: Live2DDisplayEntry | undefined = groups.get(current)
    names.unshift(entry?.name ?? current)
    current = entry?.groupId
  }
  return names.join(' / ')
}

export function editorLayers(core: Core, profile: Live2DProfile, drawables: string[], parameters: string[]): EditorLayer[] {
  const parts = new Map(profile.display?.parts.map(part => [part.id, part.name ?? part.id]))
  const authored = new Map(profile.layers?.map(layer => [layer.id, layer]))
  const runtime = new Map(drawables.map((id, index) => [id, index]))
  return [...new Set([...authored.keys(), ...drawables])].flatMap(id => {
    const index = runtime.get(id)
    if (index === undefined) return []
    const layer = authored.get(id)
    const partIndex = core.getDrawableParentPartIndex(index)
    const part = core.getModel().parts.ids[partIndex]
    const group = layer?.group ?? (part ? parts.get(part) ?? part : '未分组')
    const groupId = layer?.group ? `layer:${layer.group}` : part ? `part:${part}` : 'ungrouped'
    return [{ ...layer, id, name: layer?.name ?? id, group, groupId,
      sway: layer?.sway?.filter(value => parameters.includes(value)) }]
  })
}

export function editorParameters(core: Core, profile: Live2DProfile, ids: string[]): EditorParameterGroup[] {
  const names = new Map(profile.display?.parameters.map(parameter => [parameter.id, parameter]))
  const displayGroups = new Map(profile.display?.groups.map(group => [group.id, group]))
  const parameters = new Map(ids.flatMap((id, index) => {
    const min = core.getParameterMinimumValue(index)
    const max = core.getParameterMaximumValue(index)
    const rest = core.getParameterDefaultValue(index)
    return min < max ? [[id, { id, name: names.get(id)?.name ?? id, min, max, rest }] as const] : []
  }))
  const groups = (profile.motionGroups ?? []).flatMap(group => {
    const tracks = group.tracks.flatMap(track => {
      const parameter = parameters.get(track.id)
      if (!parameter) return []
      parameters.delete(track.id)
      return [{ ...parameter, ...track }]
    })
    return tracks.length ? [{ ...group, tracks }] : []
  })
  const occupied = new Set(groups.map(group => group.id))
  const remaining = new Map<string, EditorParameterGroup>()
  for (const [id, parameter] of parameters) {
    const groupId = names.get(id)?.groupId ?? ''
    let group = remaining.get(groupId)
    if (!group) {
      let key = groupId || 'parameters'
      while (occupied.has(key)) key = `display:${key}`
      occupied.add(key)
      group = { id: key, name: groupId ? groupLabel(displayGroups, groupId) : '参数', tracks: [] }
      remaining.set(groupId, group)
    }
    group.tracks.push(parameter)
  }
  return [...groups, ...remaining.values()]
}

export function poseParameterValue({ min, max, rest }: EditorParameter, offset: number): number {
  return rest + ((offset < 0 ? min : max) - rest) * Math.abs(offset)
}
