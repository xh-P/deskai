import { useEffect, useState } from 'react'
import type { CharacterSummary } from '../../src/character-store.ts'

type Editor = { revision?: number; displayName: string; traits: string; speechStyle: string }
const empty: Editor = { displayName: '', traits: '', speechStyle: '' }
const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)

export default function CharacterEditor({ characters, selectedId, onSaved, onError }: {
  characters: CharacterSummary[]; selectedId: string; onSaved: () => Promise<void>; onError: (error: unknown) => void
}) {
  const [id, setId] = useState<string | undefined>()
  const [editor, setEditor] = useState<Editor>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const revision = characters.find(card => card.id === id)?.revision

  useEffect(() => {
    let current = true
    setEditor(id === '' ? empty : undefined)
    if (id) void window.deskai.getCharacter(id).then(card => {
      if (current) setEditor({ revision: card.revision, displayName: card.displayName, traits: card.traits.join('\n'), speechStyle: card.speechStyle.join('\n') })
    }, error => { if (current) onError(error) })
    return () => { current = false }
  }, [id, revision, onError])

  const save = async () => {
    if (!editor || busy) return
    setBusy(true)
    setMessage('')
    try {
      const card = await window.deskai.saveCharacter({ id: id || undefined, revision: editor.revision,
        displayName: editor.displayName, traits: lines(editor.traits), speechStyle: lines(editor.speechStyle) })
      await onSaved()
      setId(card.id)
      setMessage(`已保存第 ${card.revision} 版，新会话使用此版本。`)
    } catch (error) { onError(error) }
    finally { setBusy(false) }
  }

  return <details className="settings" onToggle={event => { if (event.currentTarget.open && id === undefined) setId(selectedId) }}>
    <summary>角色编辑</summary>
    <div className="character-editor">
      <label>编辑角色<select value={id ?? selectedId} disabled={busy} onChange={event => { setId(event.target.value); setMessage('') }}>
        {characters.map(card => <option value={card.id} key={card.id}>{card.displayName}</option>)}
        <option value="">创建角色</option>
      </select></label>
      {editor && <form onSubmit={event => { event.preventDefault(); void save() }}>
        <label>名称<input value={editor.displayName} maxLength={80} required onChange={event => setEditor({ ...editor, displayName: event.target.value })} /></label>
        <label>性格特点<textarea value={editor.traits} rows={4} maxLength={970} onChange={event => setEditor({ ...editor, traits: event.target.value })} /></label>
        <label>表达方式<textarea value={editor.speechStyle} rows={4} maxLength={970} onChange={event => setEditor({ ...editor, speechStyle: event.target.value })} /></label>
        <small>每行一条，每组最多八条。</small>
        <button type="submit" disabled={busy || !editor.displayName.trim()}>保存角色</button>
      </form>}
      {message && <p role="status">{message}</p>}
    </div>
  </details>
}
