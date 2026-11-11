import type { HostSnapshot } from '../../../host/src/protocol.ts'

export default function ApplicationsPanel({ snapshot, onError }: { snapshot: HostSnapshot; onError: (message: string) => void }) {
  const run = (promise: Promise<unknown>) => { void promise.catch(error => onError(String(error))) }
  const tasks = new Map(snapshot.work.tasks.map(task => [task.id, task]))
  const artifacts = snapshot.artifacts.flatMap(artifact => {
    const task = tasks.get(artifact.taskId)
    const attempt = artifact.attemptId && task ? task.attemptIds.indexOf(artifact.attemptId) + 1 : 0
    return attempt && task ? [{ artifact, task, attempt }] : []
  })
  return <section className="settings" aria-label="产物与应用协作">
    <h2>产物与应用协作</h2>
    <p>打开登记的应用后，可直接对角色说要在应用里做什么。连接状态以应用实际注册为准。</p>
    <ul>{artifacts.map(({ artifact, task, attempt }) => <li key={artifact.id}>
      <span>{artifact.relativePath} · {task.title} · 第 {attempt} 次执行</span>{' '}
      <button onClick={() => run(window.deskai.openArtifact(artifact.id, false))}>预览</button>{' '}
      <button onClick={() => run(window.deskai.exportArtifact(artifact.id).then(receipt => {
        if (receipt?.status === 'failed') throw new Error(receipt.error === 'EEXIST' ? '目标文件已存在，请选择新文件名。' : receipt.error)
      }))}>导出</button>{' '}
      {/\.html$/i.test(artifact.relativePath) && <button onClick={() => run(window.deskai.openArtifact(artifact.id, true))}>打开并连接应用</button>}
    </li>)}</ul>
    {snapshot.exports.length > 0 && <details><summary>导出记录（{snapshot.exports.length}）</summary>
      <ul>{snapshot.exports.slice().reverse().map(receipt => <li key={receipt.id}>
        {receipt.status === 'exported' ? '已导出' : receipt.status === 'failed' ? `导出失败 · ${receipt.error}` : '正在导出'} · {receipt.destination}
        {' · '}{new Date(receipt.finishedAt ?? receipt.approvedAt).toLocaleString()}
      </li>)}</ul>
    </details>}
    {snapshot.apps.map(app => <article key={app.id}>
      <h3>{app.manifest.title} · {app.status === 'connected' ? '已连接' : '已断开'}</h3>
      <p>可用操作：{app.manifest.actions.map(action => action.type).join('、')}</p>
      {app.status === 'connected' && <>
        <button aria-pressed={snapshot.selectedAppId === app.id} onClick={() => run(window.deskai.selectHost({ appSessionId: app.id }))}>与此应用协作</button>{' '}
        <button onClick={() => run(window.deskai.closeApp(app.id))}>断开协作</button>
      </>}
      <details><summary>应用当前状态 · 修订 {app.revision}</summary><pre>{JSON.stringify(app.state, null, 2)}</pre></details>
    </article>)}
  </section>
}
