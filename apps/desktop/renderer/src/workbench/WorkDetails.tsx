import { useState } from 'react'
import type { HostSnapshot } from '../../../../host/src/protocol.ts'
import { completionLabel } from '../../../../../packages/work-core/src/completion.ts'
import { asRecord, type AttemptTelemetry, type ModelTotals } from '../../../../../packages/work-core/src/telemetry.ts'
import type { WorkAttempt, WorkEvent, WorkTask, WorkUiCommand } from '../../../../../packages/work-core/src/types.ts'
import { percent, tokenCount } from './TraceTimeline'

export type SendWork = (command: WorkUiCommand) => Promise<boolean>
export const activeTask = (status: WorkTask['status']) => status === 'queued' || status === 'running' || status === 'waiting'

function ModelSummary({ label, total }: { label: string; total?: ModelTotals }) {
  const cache = total?.cache
  return <div className="wb-metric">
    <div className="wb-inline wb-between"><strong>{label}</strong><span>{total?.requests ?? 0} 次请求</span></div>
    {cache ? <>
      <div className="wb-inline wb-between"><span>缓存命中</span><b>{percent(cache.read, cache.input)}</b></div>
      {cache.input > 0 && <meter aria-label={`${label}缓存命中率`} min={0} max={1} value={cache.read / cache.input} />}
      <div className="wb-metric-note">{tokenCount(cache.read)} / {tokenCount(cache.input)} 输入 token · {cache.requests} 次有缓存计数</div>
    </> : <p className="wb-metric-note">缓存 · {(total?.requests ?? 0) > (total?.reported ?? 0) ? '等待或未上报' : '暂无计数'}</p>}
    {!!total?.reported && <p className="wb-metric-note">
      输出 {tokenCount(total.output)} token{total.reasoning !== undefined && ` · 推理 ${tokenCount(total.reasoning)} token`}
      {' · '}{total.reported} 次有用量
    </p>}
  </div>
}

function RequestReply({ event, taskId, send, busy }: { event: WorkEvent; taskId: string; send: SendWork; busy: boolean }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const request = asRecord(event.data)
  const raw = asRecord(request?.data)?.questions
  const questions = Array.isArray(raw) ? raw.map(asRecord).filter((q): q is Record<string, unknown> & { id: string } =>
    typeof q?.id === 'string') : []
  if (!request || typeof request.requestId !== 'string') return null
  const { requestId } = request
  const inNative = event.type === 'permission' || request.answerable === false || questions.length === 0
  const answers = questions.map(q => ({ id: q.id, selected: selected[q.id] ?? [], custom: custom[q.id]?.trim() || undefined }))
  return <form className="wb-request" onSubmit={e => {
    e.preventDefault()
    void send({ type: 'reply', taskId, requestId, response: { answers } })
  }}>
    <strong>{event.type === 'permission' ? '等待授权' : '等待答复'}</strong>
    {typeof request.text === 'string' && <p>{request.text}</p>}
    {questions.map(q => {
      const options = Array.isArray(q.options) ? q.options.map(asRecord).filter((option): option is Record<string, unknown> & { label: string } =>
        typeof option?.label === 'string') : []
      const chosen = selected[q.id] ?? []
      return <fieldset key={q.id} disabled={inNative || busy}>
        <legend>{String(q.header ?? q.question ?? '问题')}</legend>
        {q.header != null && <p>{String(q.question ?? '')}</p>}
        {q.detail != null && <p>{String(q.detail)}</p>}
        {options.map(({ label, description }) => <label className="wb-choice" key={label}>
          <input type={q.multi_select === true ? 'checkbox' : 'radio'} name={`${requestId}-${q.id}`}
            checked={chosen.includes(label)} onChange={e => {
              const next = q.multi_select !== true ? [label] : e.target.checked ? [...chosen, label] : chosen.filter(item => item !== label)
              setSelected(value => ({ ...value, [q.id]: next }))
              if (q.multi_select !== true) setCustom(value => ({ ...value, [q.id]: '' }))
            }} />
          <span>{label}{typeof description === 'string' && <small>{description}</small>}</span>
        </label>)}
        {!inNative && <label className="wb-field">补充回答
          <input value={custom[q.id] ?? ''} onChange={e => {
            setCustom(value => ({ ...value, [q.id]: e.target.value }))
            if (q.multi_select !== true && e.target.value.trim()) setSelected(value => ({ ...value, [q.id]: [] }))
          }} />
        </label>}
      </fieldset>
    })}
    {inNative ? <button type="button" className="wb-plain" disabled={busy}
      onClick={() => void send({ type: 'native-open', taskId, attemptId: event.attemptId })}>
      在原生会话处理 ↗
    </button> : <button type="submit" disabled={busy || answers.some(answer => !answer.selected.length && !answer.custom)}>提交答复</button>}
  </form>
}

function AttemptDiff({ attemptId, fileCount }: { attemptId: string; fileCount: number }) {
  const [patch, setPatch] = useState<string>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = async () => {
    if (patch !== undefined) { setPatch(undefined); return }
    setLoading(true)
    setError('')
    try { setPatch(await window.deskai.workDiff(attemptId)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading(false) }
  }
  return <>
    <button type="button" className="wb-plain" disabled={loading} onClick={() => void load()}>
      {patch === undefined ? `查看 Diff（${fileCount} 个文件）` : '收起 Diff'}
    </button>
    {error && <p className="wb-alert" role="alert">{error}</p>}
    {patch !== undefined && <pre className="wb-diff">{patch}</pre>}
  </>
}

type Props = {
  task: WorkTask
  attempt: WorkAttempt
  current: boolean
  pending: WorkEvent[]
  totals?: AttemptTelemetry
  artifacts: HostSnapshot['artifacts']
  busy: boolean
  send: SendWork
  onArtifacts: () => void
}

export default function WorkDetails({ task, attempt, current, pending, totals, artifacts, busy, send, onArtifacts }: Props) {
  const [followup, setFollowup] = useState('')
  const { assessment, acceptance } = attempt
  const live = activeTask(task.status)
  const unsettled = attempt.result?.unsettled === true
  return <div className="wb-detail-content">
    {current && pending.length > 0 && <section className="wb-inspector-section" aria-label="待处理请求">
      <h3>待处理请求</h3>
      {pending.map(event => <RequestReply key={String(asRecord(event.data)?.requestId ?? event.id)}
        event={event} taskId={task.id} busy={busy} send={send} />)}
    </section>}
    <section className="wb-inspector-section" aria-label="模型指标">
      <h3>模型指标</h3>
      <ModelSummary label="调度器" total={totals?.dispatcher} />
      <ModelSummary label="执行器" total={totals?.executor} />
    </section>
    {current && <section className="wb-inspector-section" aria-label="执行操作">
      <h3>执行操作</h3>
      <div className="wb-inline">
        {live && <button className="wb-plain wb-danger" type="button" disabled={busy} onClick={() => void send({ type: 'cancel', taskId: task.id })}>取消任务</button>}
        {!live && !unsettled && <button className="wb-plain" type="button" disabled={busy} onClick={() => void send({ type: 'retry', taskId: task.id })}>重试</button>}
        {!live && unsettled && attempt.binding && <button type="button" disabled={busy} onClick={() => void send({ type: 'recover', taskId: task.id })}>恢复原执行</button>}
        {attempt.providerSessionId && <button className="wb-plain" type="button" disabled={busy}
          onClick={() => void send({ type: 'native-open', taskId: task.id, attemptId: attempt.id })}>原生会话 ↗</button>}
      </div>
      {(live || attempt.providerSessionId && !unsettled && task.workspace) && <form className="wb-stack" onSubmit={async e => {
        e.preventDefault()
        if (await send({ type: live ? 'append' : 'continue', taskId: task.id, prompt: followup })) setFollowup('')
      }}>
        <label className="wb-field">{live ? '追加要求' : '继续任务'}
          <textarea rows={3} value={followup} onChange={e => setFollowup(e.target.value)}
            placeholder={live ? '补充正在执行的要求' : '在原会话输入下一步要求'} />
        </label>
        <button type="submit" disabled={busy || !followup.trim()}>{live ? '追加' : '继续任务'}</button>
      </form>}
    </section>}
    <section className="wb-inspector-section" aria-label="交付与变更">
      <h3>交付与变更</h3>
      {assessment ? <>
        <strong>{completionLabel(assessment)}</strong>
        {assessment.missingFiles.length > 0 && <p>待交付 {assessment.missingFiles.join('、')}</p>}
        {assessment.missingApp && <p>待交付可校验的 AUIP 应用</p>}
        {assessment.delivery.failures.length > 0 && <ul>{assessment.delivery.failures.map((failure, index) =>
          <li key={index}>{[failure.relativePath, failure.reason].filter(Boolean).join(' · ')}</li>)}</ul>}
        {assessment.delivery.files.length > 0 && <ul>{assessment.delivery.files.map(file => <li key={file.relativePath}>{file.relativePath}</li>)}</ul>}
        {assessment.delivery.appEntries.length > 0 && <p>AUIP 校验通过 · {assessment.delivery.appEntries.join('、')}</p>}
        <div className="wb-inline">
          {current && assessment.review === 'review_ready' && <button type="button" disabled={busy}
            onClick={() => void send({ type: 'accept', taskId: task.id, attemptId: attempt.id })}>确认验收</button>}
          {current && assessment.review === 'open' && assessment.execution === 'completed' && <button type="button" disabled={busy} className="wb-plain"
            onClick={() => void send({ type: 'recheck', taskId: task.id, attemptId: attempt.id })}>重新校验</button>}
          {artifacts.some(artifact => artifact.attemptId === attempt.id) &&
            <button type="button" className="wb-plain" onClick={onArtifacts}>查看产物</button>}
        </div>
        {acceptance && <p>验收于 {new Date(acceptance.acceptedAt).toLocaleString()}</p>}
      </> : <p className="wb-muted">等待交付记录</p>}
      {!!attempt.changes?.fileCount && <AttemptDiff key={attempt.id} attemptId={attempt.id} fileCount={attempt.changes.fileCount} />}
      {attempt.deliveryError && <p className="wb-alert" role="alert">{attempt.deliveryError}</p>}
    </section>
    <section className="wb-inspector-section" aria-label="执行来源">
      <h3>执行来源</h3>
      <dl className="wb-facts">
        {attempt.providerSessionId && <><dt>会话</dt><dd>{attempt.providerSessionId}</dd></>}
        <dt>受理操作</dt><dd>{attempt.operationId}</dd>
        {task.workspace && <><dt>执行目录</dt><dd>{task.workspace.path}</dd></>}
        {task.workspace?.kind === 'git' && <><dt>分支</dt><dd>{task.workspace.branch}</dd></>}
        {acceptance && <><dt>验收回执</dt><dd>{acceptance.id}</dd></>}
      </dl>
      {!current && attempt.providerSessionId && <button className="wb-plain" type="button" disabled={busy}
        onClick={() => void send({ type: 'native-open', taskId: task.id, attemptId: attempt.id })}>原生会话 ↗</button>}
      {attempt.error && <p className="wb-alert" role="alert">{attempt.error}</p>}
    </section>
  </div>
}
