import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { WorkEvent, WorkSnapshot } from '../../../../packages/work-core/src/types.ts'
import { pendingRequests } from '../../../../packages/work-core/src/requests.ts'

import type { WorkUiCommand } from '../../../../packages/work-core/src/types.ts'

interface Props {
  snapshot: WorkSnapshot
  selectedProjectId: string
  selectedTaskId: string
  onCommand: (command: WorkUiCommand) => Promise<unknown>
  onSelectProject: (id: string) => void
  onSelectTask: (id: string) => void
}

const box: CSSProperties = { border: '1px solid #cfd5e1', borderRadius: 8, padding: 12, marginTop: 10 }
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }
const field: CSSProperties = { maxWidth: '100%', boxSizing: 'border-box', padding: 7 }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const display = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''
const statusText: Record<string, string> = { queued: '排队', running: '运行中', waiting: '等待答复', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', unknown: '状态未知' }

function RequestReply({ event, taskId, send }: { event: WorkEvent; taskId: string; send: (command: WorkUiCommand) => Promise<boolean> }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const data = object(event.data)
  const requestId = typeof data.requestId === 'string' ? data.requestId : ''
  const raw = data.data
  const questions = Array.isArray(object(raw).questions) ? (object(raw).questions as unknown[]).map(object) : []
  if (!requestId) return null
  return <div style={{ ...box, background: '#302b20' }}>
    <strong>{event.type === 'permission' ? '权限请求' : '需要答复'}</strong>
    <div style={{ whiteSpace: 'pre-wrap', marginTop: 5 }}>{String(data.text ?? '')}</div>
    {event.type === 'permission' ? <><p>请在原生会话中处理此权限请求。</p><button type="button" onClick={() => void send({ type: 'native-open', taskId })}>打开原生会话</button></> : questions.length > 0 ? <>
      {questions.map((question, index) => {
        const questionId = typeof question.id === 'string' ? question.id : ''
        const options = Array.isArray(question.options) ? question.options.map(object).filter(option => typeof option.label === 'string') : []
        const chosen = selected[questionId] ?? []
        return <fieldset key={`${questionId}-${index}`} style={{ marginTop: 8 }}>
          <legend>{String(question.header ?? question.question ?? `问题 ${index + 1}`)}</legend>
          {question.header != null && <div>{String(question.question ?? '')}</div>}
          {question.detail != null && <p>{String(question.detail)}</p>}
          {options.map(option => { const label = option.label as string; return <label key={label} style={{ display: 'block' }}>
            <input type={question.multi_select === true ? 'checkbox' : 'radio'} name={`question-${requestId}-${questionId}`} checked={chosen.includes(label)} onChange={e => setSelected(current => ({ ...current, [questionId]: question.multi_select === true ? (e.target.checked ? [...chosen, label] : chosen.filter(item => item !== label)) : [label] }))} />
            {label}{option.description != null && <span> — {String(option.description)}</span>}
          </label> })}
          <label>补充回答 <input style={field} value={custom[questionId] ?? ''} onChange={e => setCustom(current => ({ ...current, [questionId]: e.target.value }))} /></label>
        </fieldset>
      })}
      <button type="button" disabled={questions.some(q => typeof q.id !== 'string' || (!(selected[q.id] ?? []).length && !custom[q.id]?.trim()))} onClick={() => {
        const answers = questions.map(q => { const id = q.id as string; const extra = custom[id]?.trim(); return { id, selected: selected[id] ?? [], ...(extra ? { custom: extra } : {}) } })
        void send({ type: 'reply', taskId, requestId, response: { answers } })
      }}>提交答复</button>
    </> : <>
    <p>请在原生会话查看并回答此问题。</p>
    <button type="button" onClick={() => void send({ type: 'native-open', taskId })}>打开原生会话</button></>}
  </div>
}

function AttemptDiff({ attemptId, fileCount }: { attemptId: string; fileCount: number }) {
  const [patch, setPatch] = useState<string>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  return <div>
    <button type="button" disabled={loading || fileCount === 0} onClick={() => {
      if (patch !== undefined) { setPatch(undefined); return }
      setLoading(true); setError('')
      void window.deskai.workDiff(attemptId).then(setPatch, cause => setError(String(cause))).finally(() => setLoading(false))
    }}>{patch === undefined ? `查看统一 Diff（${fileCount} 个文件）` : '收起 Diff'}</button>
    {error && <p role="alert">{error}</p>}
    {patch !== undefined && <pre style={{ maxHeight: 460, overflow: 'auto' }}>{patch}</pre>}
  </div>
}

export default function WorkPanel({ snapshot, selectedProjectId, selectedTaskId, onCommand, onSelectProject, onSelectTask }: Props) {
  const [projectName, setProjectName] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [authoring, setAuthoring] = useState(false)
  const [draft, setDraft] = useState('')
  const [followup, setFollowup] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const project = snapshot.projects.find(item => item.id === selectedProjectId)
  const tasks = useMemo(() => snapshot.tasks.filter(item => item.projectId === selectedProjectId).slice().reverse(), [snapshot.tasks, selectedProjectId])
  const task = tasks.find(item => item.id === selectedTaskId)
  const attempts = task ? snapshot.attempts.filter(item => item.taskId === task.id) : []
  const events = task ? snapshot.events.filter(item => item.taskId === task.id) : []
  const lastAttempt = attempts.at(-1)
  const live = !!task && ['queued', 'running', 'waiting'].includes(task.status)
  const unsettled = lastAttempt?.result?.unsettled === true
  const pending = pendingRequests(snapshot).filter(event => event.taskId === task?.id)

  useEffect(() => {
    setDraft(snapshot.drafts.find(item => item.projectId === selectedProjectId)?.text ?? '')
    setFollowup('')
    // Preserve edits while snapshots update; switching projects reloads the stored draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId])

  const send = async (command: WorkUiCommand): Promise<boolean> => {
    if (busy) return false
    setBusy(true); setError('')
    try { await onCommand(command); return true } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false } finally { setBusy(false) }
  }
  return <section aria-label="工作任务" style={{ marginTop: 16 }}>
    <h2>工作任务</h2>
    {error && <div role="alert" style={{ color: '#a22', whiteSpace: 'pre-wrap' }}>{error}</div>}
    <div style={box}>
      <strong>项目</strong>
      <div style={row}>
        <label>当前项目 <select value={selectedProjectId} onChange={e => onSelectProject(e.target.value)}><option value="">选择项目</option>{snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {project && <span style={{ overflowWrap: 'anywhere' }}>{project.path}</span>}
      </div>
      <div style={row}>
        <input style={field} value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="项目名称" aria-label="项目名称" />
        <input style={{ ...field, flex: '1 1 240px' }} value={projectPath} onChange={e => setProjectPath(e.target.value)} placeholder="项目目录路径" aria-label="项目目录路径" />
        <button type="button" disabled={busy || !projectName.trim() || !projectPath.trim()} onClick={() => void send({ type: 'project-create', name: projectName, path: projectPath }).then(ok => { if (ok) { setProjectName(''); setProjectPath('') } })}>新增项目</button>
      </div>
    </div>
    {project && <>
      <div style={box}>
        <label htmlFor="work-draft"><strong>任务草稿</strong></label>
        <textarea id="work-draft" style={{ ...field, display: 'block', width: '100%', minHeight: 90, marginTop: 8 }} value={draft} onChange={e => setDraft(e.target.value)} placeholder="描述要交给工作代理的任务" />
        <div style={row}>
          <label><input type="checkbox" checked={authoring} onChange={e => setAuthoring(e.target.checked)} />创建可与角色协作的应用</label>
          <button type="button" disabled={busy} onClick={() => void send({ type: 'draft-save', projectId: project.id, text: draft })}>保存草稿</button>
          <button type="button" disabled={busy || !draft.trim()} onClick={() => void send({ type: 'submit', projectId: project.id, prompt: draft, authoring })}>提交任务</button>
        </div>
      </div>
      <div style={box}>
        <strong>任务列表</strong>
        {tasks.length === 0 ? <p>这个项目还没有任务。</p> : <ul>{tasks.map(item => <li key={item.id}>
          <button type="button" aria-pressed={selectedTaskId === item.id} onClick={() => { setFollowup(''); onSelectTask(item.id) }}>{item.title}</button> <span>{statusText[item.status] ?? item.status}</span>
        </li>)}</ul>}
      </div>
    </>}
    {task && <div style={box}>
      <h3>{task.title}</h3><p>状态：{statusText[task.status] ?? task.status}</p>
      {task.workspace && <p style={{ overflowWrap: 'anywhere' }}>执行目录 · {task.workspace.path}{task.workspace.kind === 'git' && ` · ${task.workspace.branch}`}</p>}
      <div style={row}>
        {live && <button type="button" disabled={busy} onClick={() => void send({ type: 'cancel', taskId: task.id })}>取消任务</button>}
        {!live && !unsettled && <button type="button" disabled={busy} onClick={() => void send({ type: 'retry', taskId: task.id })}>重试</button>}
        {!live && unsettled && lastAttempt?.binding && <button type="button" disabled={busy} onClick={() => void send({ type: 'recover', taskId: task.id })}>重新连接原执行</button>}
        <button type="button" disabled={busy || !lastAttempt?.providerSessionId} onClick={() => void send({ type: 'native-open', taskId: task.id })}>打开原生会话</button>
      </div>
      <label htmlFor="work-followup">追加或继续</label>
      <textarea id="work-followup" style={{ ...field, display: 'block', width: '100%', minHeight: 65 }} value={followup} onChange={e => setFollowup(e.target.value)} placeholder={live ? '向运行中的任务追加要求' : '在原会话中继续任务'} />
      <button type="button" disabled={busy || !followup.trim() || (!live && (!lastAttempt?.providerSessionId || unsettled || !task.workspace))} onClick={() => void send({ type: live ? 'append' : 'continue', taskId: task.id, prompt: followup }).then(ok => { if (ok) setFollowup('') })}>{live ? '追加要求' : '继续任务'}</button>
      {live && pending.map(event => <RequestReply key={event.id} event={event} taskId={task.id} send={send} />)}
      <details open><summary>执行记录（{attempts.length}）</summary>{attempts.map((attempt, index) => <div key={attempt.id} style={box}>
        <strong>第 {index + 1} 次 · {statusText[attempt.status] ?? attempt.status}</strong>
        {attempt.providerSessionId && <div>原生会话：{attempt.providerSessionId}</div>}
        {attempt.summary && <p style={{ whiteSpace: 'pre-wrap' }}>{attempt.summary}</p>}{attempt.error && <p style={{ color: '#a22', whiteSpace: 'pre-wrap' }}>{attempt.error}</p>}
        {attempt.changes && <AttemptDiff attemptId={attempt.id} fileCount={attempt.changes.fileCount} />}
        {attempt.deliveryError && <p role="alert">差异收集失败 · {attempt.deliveryError}</p>}
        <ul>{events.filter(event => event.attemptId === attempt.id).map(event => <li key={event.id} style={{ overflowWrap: 'anywhere' }}><time>{new Date(event.time).toLocaleString()}</time> · {event.type}<pre style={{ whiteSpace: 'pre-wrap', margin: '3px 0 8px' }}>{display(event.data)}</pre></li>)}</ul>
      </div>)}</details>
    </div>}
  </section>
}
