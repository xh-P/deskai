import type { DesktopHostSnapshot } from '../../src/desktop-host.ts'

export default function ApplicationsPanel({ snapshot, onError }: { snapshot: DesktopHostSnapshot; onError: (message: string) => void }) {
  const run = (promise: Promise<unknown>) => { void promise.catch(error => onError(String(error))) }
  return <section className="settings" aria-label="产物与应用协作">
    <h2>产物与应用协作</h2>
    <p>打开登记的应用后，可直接对角色说要在应用里做什么。连接状态以应用实际注册为准。</p>
    <ul>{snapshot.artifacts.map(artifact => <li key={artifact.id}>
      <span>{artifact.relativePath}</span>{' '}
      <button onClick={() => run(window.deskai.openArtifact(artifact.id, false))}>预览</button>{' '}
      {/\.html$/i.test(artifact.relativePath) && <button onClick={() => run(window.deskai.openArtifact(artifact.id, true))}>打开并连接应用</button>}
    </li>)}</ul>
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
