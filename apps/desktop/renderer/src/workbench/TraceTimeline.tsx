import { useLayoutEffect, useRef, useState } from 'react'
import { cacheUsage, type ModelTelemetry, type WorkTraceEntry } from '../../../../../packages/work-core/src/telemetry.ts'
import { type useWorkTrace } from './useWorkTrace'

const names = { user: '你', dispatcher: '调度器', host: 'Host', executor: '执行器' }
const kinds = { model: '模型请求', tool: '工具', connection: '原生会话', message: '消息', receipt: '操作回执',
  status: '执行状态', request: '待处理', delivery: '交付' }
const states = { running: '进行中', completed: '完成', failed: '失败', interrupted: '中断', waiting: '等待' }
const eventTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const tokens = new Intl.NumberFormat('zh-CN')
export const tokenCount = (count: number) => tokens.format(count)
export const duration = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms)} 毫秒`
export const percent = (part: number, total: number) => total ? `${(100 * part / total).toFixed(1)}%` : '—'

function RequestMetrics({ metrics, running }: { metrics: ModelTelemetry; running: boolean }) {
  const { usage, model, provider, thinking, reasoningEffort, elapsedMs, firstTokenMs } = metrics
  const cache = usage && cacheUsage(usage)
  return <dl className="wb-facts wb-request-metrics">
    {(provider || model) && <><dt>模型</dt><dd>{[provider, model].filter(Boolean).join(' / ')}</dd></>}
    {thinking && <><dt>思考模式</dt><dd>{thinking}</dd></>}
    <dt>请求推理档位</dt><dd>{reasoningEffort ?? '未记录'}</dd>
    <dt>缓存读取</dt><dd>{cache ? `${percent(cache.read, cache.input)} · ${tokenCount(cache.read)} / ${tokenCount(cache.input)} token`
      : usage ? '未上报可用的缓存计数' : running ? '等待用量' : '未上报'}</dd>
    {usage && <><dt>输出</dt><dd>{tokenCount(usage.outputTokens)} token</dd></>}
    {usage?.reasoningTokens !== undefined && <><dt>推理</dt><dd>{tokenCount(usage.reasoningTokens)} token</dd></>}
    {firstTokenMs !== undefined && <><dt>首 token</dt><dd>{duration(firstTokenMs)}</dd></>}
    {elapsedMs !== undefined && <><dt>模型耗时</dt><dd>{duration(elapsedMs)}</dd></>}
  </dl>
}

function TraceRow({ row }: { row: WorkTraceEntry }) {
  const body = row.text && <p className="wb-trace-text">{row.text}</p>
  const compact = row.kind === 'tool' || row.kind === 'receipt' || row.kind === 'connection'
  return <li className="wb-trace-row" data-actor={row.actor} data-kind={row.kind}>
    <div className="wb-trace-meta">
      <span className="wb-actor">{names[row.actor]}{row.recipient && ` → ${names[row.recipient]}`}</span>
      <span>{kinds[row.kind]}</span>
      <time dateTime={new Date(row.at).toISOString()} title={new Date(row.at).toLocaleString()}>{eventTime.format(row.at)}</time>
    </div>
    <article className="wb-event">
      <div className="wb-event-heading">
        <strong>{row.title}</strong>
        <span className="wb-event-state" data-state={row.state}>
          {row.state && states[row.state]}{row.elapsedMs !== undefined && ` · ${duration(row.elapsedMs)}`}
        </span>
      </div>
      {row.kind === 'model' && <RequestMetrics metrics={row.metrics ?? {}} running={row.state === 'running'} />}
      {compact && (body || row.operationId || row.sessionId) ? <details>
        <summary>{row.kind === 'tool' ? '工具结果' : '来源记录'}</summary>
        {body}
        {row.operationId && <p>操作 <code>{row.operationId}</code></p>}
        {row.conversationId && <p>对话 <code>{row.conversationId}</code></p>}
        {row.sessionId && <p>会话 <code>{row.sessionId}</code></p>}
      </details> : body}
    </article>
  </li>
}

export default function TraceTimeline({ attemptId, trace }: { attemptId: string; trace: ReturnType<typeof useWorkTrace> }) {
  const scroll = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const anchor = useRef<{ height: number; top: number; first?: string } | null>(null)
  const rows = trace.rows.filter(row => row.attemptId === attemptId)
  const first = rows[0]?.id
  useLayoutEffect(() => {
    const view = scroll.current
    if (!view) return
    const before = anchor.current
    if (before && !trace.paging) {
      if (first !== before.first) view.scrollTop = before.top + view.scrollHeight - before.height
      anchor.current = null
    } else if (following) view.scrollTop = view.scrollHeight
  }, [rows, following, first, trace.paging])
  const older = async () => {
    const view = scroll.current
    if (view) anchor.current = { top: view.scrollTop, height: view.scrollHeight, first }
    setFollowing(false)
    await trace.earlier()
  }
  return <section className="wb-timeline" aria-label="执行时间线">
    <div className="wb-timeline-toolbar">
      <h3>执行时间线</h3>
      <div className="wb-inline">
        {trace.older && <button type="button" className="wb-plain" disabled={trace.paging} onClick={() => void older()}>
          {trace.paging ? '加载中' : '加载更早'}
        </button>}
        <button type="button" className="wb-plain" aria-pressed={following} onClick={() => setFollowing(value => !value)}>跟随最新</button>
      </div>
    </div>
    {trace.error && <p className="wb-alert" role="alert">{trace.error}</p>}
    <div className="wb-timeline-scroll" ref={scroll} tabIndex={0}
      onScroll={event => {
        const view = event.currentTarget
        if (following && view.scrollHeight - view.clientHeight - view.scrollTop > 48) setFollowing(false)
      }}>
      {rows.length ? <ol className="wb-trace-list">{rows.map(row => <TraceRow key={row.id} row={row} />)}</ol>
        : <p className="wb-muted wb-empty">{trace.connection === 'connected' ? '此执行尚无已加载的事件。' : '正在连接任务事件。'}</p>}
    </div>
  </section>
}
