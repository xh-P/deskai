import type { HostSnapshot } from '../../../host/src/protocol.ts'

const appStatus = { connected: '已连接', disconnected: '已断开', closed: '已关闭', completed: '应用已结束' }
const controllerStatus = { active: '控制器运行中', stopping: '正在撤销控制器租约', idle: '控制器空闲', blocked: '控制器受阻' }

export default function ApplicationsPanel({ snapshot, attemptId, onError }: {
  snapshot: HostSnapshot; attemptId?: string; onError: (message: string) => void
}) {
  const run = (promise: Promise<unknown>) => { void promise.catch(error => onError(String(error))) }
  const tasks = new Map(snapshot.work.tasks.map(task => [task.id, task]))
  const artifacts = snapshot.artifacts.flatMap(artifact => {
    if (attemptId && artifact.attemptId !== attemptId) return []
    const task = tasks.get(artifact.taskId)
    const attempt = artifact.attemptId && task ? task.attemptIds.indexOf(artifact.attemptId) + 1 : 0
    return attempt && task ? [{ artifact, task, attempt }] : []
  })
  const artifactKeys = new Set(artifacts.map(({ artifact }) => `${artifact.attemptId}:${artifact.relativePath.replace(/\\/g, '/')}`))
  const exports = snapshot.exports.filter(receipt => !attemptId || receipt.attemptId === attemptId)
  const appArtifacts = new Set(artifacts.map(({ artifact }) => artifact.id))
  const apps = snapshot.apps.filter(app => !attemptId || appArtifacts.has(app.artifactId))
  return <section className="settings" aria-label="产物与应用协作">
    {!artifacts.length && !apps.length && <p>暂无已登记的产物或应用。</p>}
    <ul>{artifacts.map(({ artifact, task, attempt }) => {
      const sidecar = artifact.relativePath.replace(/\\/g, '/').replace(/[^/]+$/, 'auip.manifest.json')
      return <li key={artifact.id}>
      <span>{artifact.relativePath} · {task.title} · 第 {attempt} 次执行</span>{' '}
      <button onClick={() => run(window.deskai.openArtifact(artifact.id, false))}>预览</button>{' '}
      <button onClick={() => run(window.deskai.exportArtifact(artifact.id).then(receipt => {
        if (receipt?.status === 'failed') throw new Error(receipt.error === 'EEXIST' ? '目标文件已存在，请选择新文件名。' : receipt.error)
      }))}>导出</button>{' '}
      {/\.html$/i.test(artifact.relativePath) && artifactKeys.has(`${artifact.attemptId}:${sidecar}`) &&
        <button onClick={() => run(window.deskai.openArtifact(artifact.id, true))}>打开并连接应用</button>}
    </li>})}</ul>
    {exports.length > 0 && <details><summary>导出记录（{exports.length}）</summary>
      <ul>{exports.slice().reverse().map(receipt => <li key={receipt.id}>
        {receipt.status === 'exported' ? '已导出' : receipt.status === 'failed' ? `导出失败 · ${receipt.error}` : '正在导出'} · {receipt.destination}
        {' · '}{new Date(receipt.finishedAt ?? receipt.approvedAt).toLocaleString()}
      </li>)}</ul>
    </details>}
    {apps.map(app => <article key={app.id}>
      <h3>{app.manifest.app.title} · {appStatus[app.status]}</h3>
      {app.status === 'connected' && <>
        <p>{app.mode === 'collaborate' ? '协作中' : '观察中'}{app.controller && ` · ${controllerStatus[app.controller.status]}`}</p>
        <button aria-pressed={snapshot.selectedAppId === app.id} onClick={() => run(window.deskai.selectHost({ appSessionId: app.id }))}>选中此应用</button>{' '}
        {app.mode === 'collaborate' && app.manifest.stances.includes('spectator') &&
          <button onClick={() => run(window.deskai.setAppMode(app.id, 'observe'))}>接管</button>}{' '}
        {app.mode === 'observe' && app.manifest.stances.includes('participant') &&
          <button onClick={() => run(window.deskai.setAppMode(app.id, 'collaborate'))}>恢复协作</button>}{' '}
        <button onClick={() => run(window.deskai.closeApp(app.id))}>断开协作</button>
      </>}
      {app.receipt && <p>最近动作 · {app.receipt.type} · {app.receipt.accepted ? '应用已执行' : '应用已拒绝'}</p>}
      <details><summary>应用当前状态 · 修订 {app.revision}</summary><pre>{JSON.stringify(app.state, null, 2)}</pre></details>
    </article>)}
  </section>
}
