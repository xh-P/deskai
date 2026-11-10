import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '../..');
if (!process.argv.includes('--real-model')) throw new Error('Pass --real-model to run a real planner and dsh task in a temporary workspace.');
if (!process.versions.electron) {
  const { buildDesktop } = await import('./build.mjs'); await buildDesktop();
  const temporary = await mkdtemp(path.join(tmpdir(), 'deskai-host-e2e-'));
  const env = { ...process.env, DESKAI_PROJECT_ROOT: root, DESKAI_NODE_EXECUTABLE: process.execPath, DESKAI_E2E_TEMP: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [import.meta.filename, '--real-model'], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { if (child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }, 480000);
  child.on('exit', async code => {
    clearTimeout(timer); process.exitCode = code ?? 1;
    // Chromium owns profile files until its process has exited.
    try { await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
    catch (error) { console.error('Probe cleanup failed:', error.message); process.exitCode = 1; }
  });
} else {
  void (async () => {
  const { app, BrowserWindow } = await import('electron');
  app.on('window-all-closed', () => {});
  const { LocalDshSpeech } = await import('../../.cache/desktop-main/packages/dsh-adapter/src/speech.js');
  const { DshWorkProvider } = await import('../../.cache/desktop-main/packages/dsh-adapter/src/work-provider.js');
  const { WorkRuntime } = await import('../../.cache/desktop-main/apps/desktop/src/work-runtime.js');
  const { DesktopHost } = await import('../../.cache/desktop-main/apps/desktop/src/desktop-host.js');
  const { WorkPlanner } = await import('../../.cache/desktop-main/apps/desktop/src/work-planner.js');
  const temporary = process.env.DESKAI_E2E_TEMP;
  if (!temporary || path.dirname(path.resolve(temporary)).toLowerCase() !== path.resolve(tmpdir()).toLowerCase() || !path.basename(temporary).startsWith('deskai-host-e2e-'))
    throw new Error('Expected a parent-owned temporary probe directory');
  const project = path.join(temporary, 'project'); await mkdir(project);
  app.setPath('userData', temporary); await app.whenReady();
  const runtime = new WorkRuntime(root, () => {}, { profile: 'web', cwd: project });
  const speech = new LocalDshSpeech(root);
  let host, browser, planner;
  const report = { timestamp: new Date().toISOString(), realPlanner: true, realDsh: true, appAuthoredByDsh: true, physicalAudioTested: false, passed: false };
  async function until(predicate, label, timeout = 360000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`Timed out: ${label}`);
  }
  try {
    console.log('Host e2e: preparing planner and task ledger');
    await speech.start(); planner = new WorkPlanner(speech, root);
    host = await DesktopHost.open(path.join(temporary, 'host'), new DshWorkProvider(runtime, root), project);
    const plan = await planner.plan('请在当前项目新建一个可与角色协作的单文件 HTML 待办应用，保存为 todo.html。界面极简，只要输入框、添加按钮和列表。通过协作协议声明添加待办动作并发布当前列表状态。可以嵌入协作客户端 helper，但不要直接复制现成的 todo.html 示例；不要增加测试脚本或其他业务文件。', host.planningContext());
    assert.equal(plan.intent, 'submit');
    assert.equal(plan.authoring, true);
    const receipt = await host.execute(plan); report.submitted = receipt.kind === 'task-submitted';
    console.log('Host e2e: task delegated to dsh');
    const task = await until(() => {
      const task = host.work.snapshot().tasks[0];
      return task && ['completed', 'failed', 'cancelled', 'unknown', 'interrupted', 'waiting'].includes(task.status) ? task : null;
    }, 'native task settlement');
    report.taskStatus = task.status; assert.equal(task.status, 'completed');
    const artifact = await until(() => host.artifacts.listArtifacts().find(item => item.relativePath === 'todo.html'), 'artifact registration', 10000);
    report.artifactVerified = (await host.artifacts.readVerified(artifact.id)).bytes.length > 0;
    browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await browser.loadURL((await host.apps.prepareLaunch(artifact.id)).url);
    const connected = await until(() => host.apps.listSessions().find(session => session.status === 'connected' && session.state), 'application registration', 10000);
    host.selectApp(connected.id); report.appConnected = true;
    console.log('Host e2e: application registered; planning a semantic action');
    const action = await planner.plan('请在这个待办应用中添加一条待办：明天复核清单。', host.planningContext());
    assert.equal(action.intent, 'app');
    const response = await host.execute(action);
    report.actionAccepted = response.receipt.accepted === true;
    report.stateUpdated = JSON.stringify(host.apps.listSessions().find(session => session.id === connected.id)?.state).includes('明天复核清单');
    assert.ok(report.actionAccepted && report.stateUpdated);
    host.apps.closeSession(connected.id);
    await until(() => host.apps.listSessions().find(session => session.id === connected.id)?.status === 'disconnected', 'app disconnect', 5000);
    await assert.rejects(host.apps.invokeAction(connected.id, action.action, action.payload));
    report.disconnectedActionRejected = true; report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.lastTaskStatus = host?.work.snapshot().tasks[0]?.status;
    report.recentEvents = host?.work.snapshot().events.slice(-5).map(event => ({ type: event.type, time: event.time }));
  }
  finally {
    browser?.destroy(); await planner?.cancel().catch(() => {}); await host?.close();
    await runtime.dispose(); await speech.dispose();
    const out = path.join(root, 'outputs/host-validation'); await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'host-e2e.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  }
  })().catch(error => { console.error(error); process.exit(1); });
}
