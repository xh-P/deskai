import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { HostSnapshot } from '../../../../host/src/protocol.ts'
import { completionLabel, workExecutionLabel } from '../../../../../packages/work-core/src/completion.ts'
import { pendingRequests } from '../../../../../packages/work-core/src/requests.ts'
import { asRecord } from '../../../../../packages/work-core/src/telemetry.ts'
import type { WorkAttempt, WorkDraft, WorkProject, WorkTask, WorkUiCommand } from '../../../../../packages/work-core/src/types.ts'
import type { WorkOperationReceipt } from '../../../../../packages/work-core/src/operations.ts'
import ApplicationsPanel from '../ApplicationsPanel'
import TraceTimeline from './TraceTimeline'
import WorkDetails, { activeTask, type SendWork } from './WorkDetails'
import { useWorkTrace } from './useWorkTrace'
import './workbench.css'

type Modal = { type: 'project' | 'task' } | { type: 'artifacts'; attemptId?: string }
type TaskFilter = 'all' | 'active' | 'settled'
const filters: { value: TaskFilter; label: string }[] = [
  { value: 'all', label: '全部' }, { value: 'active', label: '进行中' }, { value: 'settled', label: '已结束' },
]

function WorkDialog({ title, close, children, drawer }: { title: string; close: () => void; children: ReactNode; drawer?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return <dialog ref={dialog} className={drawer ? 'wb-dialog wb-drawer' : 'wb-dialog'} onClose={close} aria-label={title}>
    <header><h2>{title}</h2><button className="wb-icon" type="button" onClick={() => dialog.current?.close()} aria-label="关闭">×</button></header>
    {children}
  </dialog>
}

function ProjectForm({ busy, create }: { busy: boolean; create: (command: WorkUiCommand) => Promise<void> }) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  return <form className="wb-stack" onSubmit={e => {
    e.preventDefault()
    void create({ type: 'project-create', name, path })
  }}>
    <label className="wb-field">项目名称<input value={name} onChange={e => setName(e.target.value)} autoFocus /></label>
    <label className="wb-field">项目目录<input value={path} onChange={e => setPath(e.target.value)} placeholder="本地绝对路径" /></label>
    <button type="submit" disabled={busy || !name.trim() || !path.trim()}>添加项目</button>
  </form>
}

function TaskForm({ project, saved, busy, send, submit }: {
  project: WorkProject; saved?: WorkDraft; busy: boolean; send: SendWork; submit: (command: WorkUiCommand) => Promise<void>
}) {
  const [text, setText] = useState(saved?.text ?? '')
  const [files, setFiles] = useState('')
  const [authoring, setAuthoring] = useState(false)
  const [savedText, setSavedText] = useState(saved?.text)
  return <form className="wb-stack" onSubmit={e => {
    e.preventDefault()
    void submit({ type: 'submit', projectId: project.id, prompt: text, authoring,
      expectedArtifacts: files.split('\n').map(line => line.trim()).filter(Boolean) })
  }}>
    <p className="wb-muted">{project.name} · {project.path}</p>
    <label className="wb-field">任务要求<textarea rows={6} value={text} onChange={e => setText(e.target.value)} autoFocus /></label>
    <label className="wb-field">预期交付文件 <small>可选，每行一个相对路径</small>
      <textarea rows={2} value={files} onChange={e => setFiles(e.target.value)} />
    </label>
    <label className="wb-choice"><input type="checkbox" checked={authoring} onChange={e => setAuthoring(e.target.checked)} />
      创建可与角色协作的应用
    </label>
    <div className="wb-inline">
      <button type="submit" disabled={busy || !text.trim()}>提交任务</button>
      <button type="button" className="wb-plain" disabled={busy || text === savedText} onClick={async () => {
        if (await send({ type: 'draft-save', projectId: project.id, text })) setSavedText(text)
      }}>{text === savedText ? '草稿已保存' : '保存草稿'}</button>
    </div>
  </form>
}

function Status({ task, attempt }: { task: WorkTask; attempt?: WorkAttempt }) {
  const label = task.status === 'completed' ? completionLabel(attempt?.assessment) : workExecutionLabel(task.status)
  return <span className="wb-status" data-status={task.status}>{label}</span>
}

function TaskView({ snapshot, task, attempts, busy, error, send, onArtifacts }: {
  snapshot: HostSnapshot; task: WorkTask; attempts: WorkAttempt[]; busy: boolean; error: string; send: SendWork; onArtifacts: (attemptId: string) => void
}) {
  const trace = useWorkTrace(task.id)
  const [historicalId, setHistoricalId] = useState('')
  const [showDetails, setShowDetails] = useState(false)
  const closeDetails = useCallback(() => setShowDetails(false), [])
  const latest = attempts.at(-1)
  const attempt = attempts.find(item => item.id === historicalId) ?? latest
  const pending = pendingRequests(snapshot.work).filter(event => event.taskId === task.id)
  const connectionLabel = { connecting: '连接 Host', connected: '实时连接', reconnecting: '正在重连 Host' }[trace.connection]
  return <div className="wb-task-view">
    <header className="wb-task-header">
      <div className="wb-task-heading">
        <div className="wb-inline">
          <Status task={task} attempt={latest} />
          <span className="wb-connection" data-connection={trace.connection} role="status">{connectionLabel}</span>
          {pending.length > 0 && <span className="wb-waiting">{pending.length} 项待处理</span>}
        </div>
        <h2 title={task.title}>{task.title}</h2>
      </div>
      <div className="wb-task-options">
        <label className="wb-field">执行记录
          <select value={historicalId} onChange={e => setHistoricalId(e.target.value)}>
            <option value="">最新 · 第 {attempts.length} 次</option>
            {attempts.slice(0, -1).reverse().map((item, index) => <option key={item.id} value={item.id}>
              第 {attempts.length - 1 - index} 次 · {workExecutionLabel(item.status)}
            </option>)}
          </select>
        </label>
        {attempt && <button type="button" className="wb-plain wb-details-toggle" onClick={() => setShowDetails(true)}>详情</button>}
      </div>
    </header>
    {attempt ? <div className="wb-task-body">
      <TraceTimeline key={attempt.id} attemptId={attempt.id} trace={trace} />
      <DetailsDrawer open={showDetails} close={closeDetails} error={error}>
        <WorkDetails key={attempt.id} task={task} attempt={attempt} current={attempt.id === latest?.id}
          pending={pending} totals={trace.totals[attempt.id]} artifacts={snapshot.artifacts}
          busy={busy} send={send} onArtifacts={() => onArtifacts(attempt.id)} />
      </DetailsDrawer>
    </div> : <p className="wb-empty wb-muted">等待执行记录。</p>}
  </div>
}

function DetailsDrawer({ open, close, error, children }: { open: boolean; close: () => void; error: string; children: ReactNode }) {
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1050px)').matches)
  useEffect(() => {
    const media = matchMedia('(max-width: 1050px)')
    const update = () => { setNarrow(media.matches); if (!media.matches) close() }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [close])
  if (!narrow) return <aside className="wb-inspector" aria-label="执行详情">{children}</aside>
  return open ? <WorkDialog title="执行详情" close={close} drawer>
    {error && <p className="wb-alert" role="alert">{error}</p>}
    {children}
  </WorkDialog> : null
}

export default function Workbench({ snapshot }: { snapshot: HostSnapshot | null }) {
  const [selection, setSelection] = useState<{ projectId: string; taskId: string }>()
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [modal, setModal] = useState<Modal>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const work = snapshot?.work
  const projectId = selection?.projectId ?? snapshot?.selectedProjectId
  const project = work?.projects.find(item => item.id === projectId)
  const tasks = work?.tasks.filter(item => item.projectId === projectId).slice().reverse() ?? []
  const task = tasks.find(item => item.id === (selection?.taskId ?? snapshot?.selectedTaskId))
  const attemptsById = new Map(work?.attempts.map(attempt => [attempt.id, attempt]))
  const attempts = task ? task.attemptIds.flatMap(id => {
    const attempt = attemptsById.get(id)
    return attempt ? [attempt] : []
  }) : []
  const visible = filter === 'all' ? tasks : tasks.filter(item => activeTask(item.status) === (filter === 'active'))
  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (busy) return
    setBusy(true)
    setError('')
    try { return await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const command = (input: WorkUiCommand) => run(async () => {
    const result = await window.deskai.workCommand(input)
    if (asRecord(result)?.kind === 'work-operation') {
      const operation = (result as WorkOperationReceipt).operation
      if (operation.state === 'unknown') throw new Error(`已记录操作，正在等待原生执行结果。${operation.error ?? ''}`)
    }
    return result
  })
  const send: SendWork = async input => (await command(input)) !== undefined
  const chooseProject = (id: string) => void run(async () => {
    await window.deskai.selectHost({ projectId: id })
    setSelection({ projectId: id, taskId: '' })
    setFilter('all')
  })
  const chooseTask = (item: WorkTask) => void run(async () => {
    await window.deskai.selectHost({ taskId: item.id })
    setSelection({ projectId: item.projectId, taskId: item.id })
  })
  const openModal = (next?: Modal) => { setError(''); setModal(next) }
  return <section className="wb" aria-label="工作任务">
    <aside className="wb-sidebar">
      <div className="wb-sidebar-heading">
        <h1>工作台</h1>
        <button type="button" className="wb-icon" aria-label="添加项目" title="添加项目" onClick={() => openModal({ type: 'project' })} disabled={!snapshot}>+</button>
      </div>
      <label className="wb-field">当前项目
        <select value={project?.id ?? ''} disabled={busy || !work} onChange={e => chooseProject(e.target.value)}>
          <option value="" disabled>选择项目</option>
          {work?.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {project && <p className="wb-path" title={project.path}>{project.path}</p>}
      <button type="button" disabled={!project} className="wb-create" onClick={() => openModal({ type: 'task' })}>＋ 新建任务</button>
      <div className="wb-filter" role="group" aria-label="筛选任务">
        {filters.map(item => <button key={item.value} type="button" aria-pressed={filter === item.value}
          onClick={() => setFilter(item.value)}>{item.label}</button>)}
      </div>
      <nav className="wb-task-list" aria-label="项目任务">
        {visible.map(item => <button key={item.id} type="button" className="wb-task-button" aria-current={task?.id === item.id ? 'true' : undefined}
          onClick={() => chooseTask(item)} disabled={busy}>
          <strong title={item.title}>{item.title}</strong>
          <Status task={item} attempt={attemptsById.get(item.attemptIds.at(-1) ?? '')} />
        </button>)}
        {!visible.length && <p className="wb-muted">{snapshot ? '没有符合条件的任务' : '正在连接 Host'}</p>}
      </nav>
      <div className="wb-sidebar-actions">
        <button type="button" className="wb-plain" aria-haspopup="dialog" disabled={!snapshot} onClick={() => openModal({ type: 'artifacts' })}>
          产物与应用{snapshot?.apps.length ? ` · ${snapshot.apps.length}` : ''}
        </button>
        <button type="button" className="wb-plain" disabled={busy || !snapshot} onClick={() => void run(async () => {
          const status = await window.deskai.openWork()
          if (status.state === 'error') throw new Error(status.code ?? '原生工作台未能打开')
        })}>dsh 原生工作台 ↗</button>
      </div>
    </aside>
    <div className="wb-main">
      {!modal && error && <p className="wb-alert wb-banner" role="alert">{error}</p>}
      {snapshot && task ? <TaskView key={task.id} snapshot={snapshot} task={task} attempts={attempts} busy={busy} error={error}
        send={send} onArtifacts={attemptId => openModal({ type: 'artifacts', attemptId })} />
        : <div className="wb-empty-view">
          <h2>{snapshot ? project ? '选择一个任务' : '添加工作项目' : '连接工作服务'}</h2>
          {snapshot && <p>{project ? '在这里查看调度、执行和交付。' : '用本地目录创建项目，交给执行器处理。'}</p>}
        </div>}
    </div>
    {modal?.type === 'project' && <WorkDialog title="添加项目" close={() => openModal()}>
      {error && <p className="wb-alert" role="alert">{error}</p>}
      <ProjectForm busy={busy} create={async input => {
        const result = await command(input) as WorkProject | undefined
        if (result) {
          setSelection({ projectId: result.id, taskId: '' })
          setFilter('all')
          openModal()
        }
      }} />
    </WorkDialog>}
    {modal?.type === 'task' && project && <WorkDialog title="新建任务" close={() => openModal()}>
      {error && <p className="wb-alert" role="alert">{error}</p>}
      <TaskForm project={project} saved={work?.drafts.find(item => item.projectId === project.id)} busy={busy} send={send}
        submit={async input => {
          const result = await command(input) as WorkOperationReceipt | undefined
          if (result?.task) {
            setSelection({ projectId: result.task.projectId, taskId: result.task.id })
            setFilter('all')
            openModal()
          }
        }} />
    </WorkDialog>}
    {modal?.type === 'artifacts' && snapshot && <WorkDialog title="产物与应用" close={() => openModal()}>
      {error && <p className="wb-alert" role="alert">{error}</p>}
      <ApplicationsPanel snapshot={snapshot} attemptId={modal.attemptId} onError={setError} />
    </WorkDialog>}
  </section>
}
