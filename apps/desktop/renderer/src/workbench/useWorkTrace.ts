import { useEffect, useState } from 'react'
import { traceOrder, type AttemptTelemetry, type WorkTraceEntry } from '../../../../../packages/work-core/src/telemetry.ts'

type Trace = {
  connection: 'connecting' | 'connected' | 'reconnecting'
  head: WorkTraceEntry[]
  history: WorkTraceEntry[]
  older: boolean
  totals: Record<string, AttemptTelemetry>
}

const initial: Trace = { connection: 'connecting', head: [], history: [], older: false, totals: {} }

export function useWorkTrace(taskId: string) {
  const [trace, setTrace] = useState(initial)
  const [paging, setPaging] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => window.deskai.watchWorkTrace(taskId, update => {
    if (update.type === 'disconnected') {
      setTrace(value => ({ ...value, connection: 'reconnecting' }))
      return
    }
    setTrace(value => {
      const head = update.type === 'snapshot' ? new Map<string, WorkTraceEntry>() : new Map(value.head.map(row => [row.id, row]))
      if (update.type === 'delta') for (const id of update.removed) head.delete(id)
      for (const row of update.rows) head.set(row.id, row)
      const sorted = [...head.values()].sort(traceOrder)
      const oldest = sorted[0]
      const evicted = update.type === 'delta' && oldest ? value.head.filter(row =>
        !head.has(row.id) && traceOrder(row, oldest) < 0 &&
        (row.sourceSeq !== undefined || row.actor !== 'executor')) : []
      return {
        connection: 'connected', head: sorted,
        history: update.type === 'snapshot' ? [] : [...value.history, ...evicted], totals: update.totals,
        older: value.history.length && update.type === 'delta' ? value.older : update.older,
      }
    })
  }), [taskId])

  const rows = [...new Map([...trace.history, ...trace.head].map(row => [row.id, row])).values()].sort(traceOrder)
  const earlier = async () => {
    if (paging || !rows[0]) return
    setPaging(true)
    setError('')
    try {
      const page = await window.deskai.workTracePage(taskId, rows[0].id)
      setTrace(value => ({ ...value, history: [...page.rows, ...value.history], older: page.older }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPaging(false)
    }
  }
  return { ...trace, rows, earlier, paging, error }
}
