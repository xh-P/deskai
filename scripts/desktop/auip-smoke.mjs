import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '../..');
const upstream = 'be9b97aef2ac3affb200998f8af3aab72aa22f6c';
const source = process.env.DESKAI_AMADEUS_SOURCE ?? path.join(root, '.cache/amadeus-source');
const upstreamFile = file => execFileSync('git', ['-C', source, 'show', `${upstream}:${file}`], { windowsHide: true });

if (!process.versions.electron) {
  const { buildDesktop } = await import('./build.mjs');
  await buildDesktop();
  const output = path.join(root, 'outputs/host-validation');
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deskai-auip-smoke-'));
  const env = { ...process.env, DESKAI_AUIP_SMOKE_DIR: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [import.meta.filename],
    { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60_000);
  try { const [code] = await once(child, 'exit'); process.exitCode = code ?? 1; }
  finally { clearTimeout(timer); }
} else void runSmoke().catch(error => { console.error(error); process.exit(1); });

async function runSmoke() {
  const { app, BrowserWindow } = await import('electron');
  const { LocalHost } = await import('../../.cache/desktop-main/apps/host/src/host.js');
  const temporary = process.env.DESKAI_AUIP_SMOKE_DIR;
  if (!temporary) throw new Error('Run the probe with Node to allocate its isolated state.');
  app.setPath('userData', temporary);
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const project = path.join(temporary, 'project'); await mkdir(project);
  const sdk = ['sdk/auip-core/managed-v0.js', 'sdk/auip-core/situations-v0.js', 'sdk/auip-web/auip-v0.js'];
  const examples = ['auip-2048', 'auip-bullet-hell'];
  const report = { upstream, physicalDevicesTested: false, provider: 'fixture', checks: {}, diagnostics: [], passed: false };
  const windows = [];
  const materialize = async (name, workDir, notify) => {
    const example = `examples/${name}`;
    const game = name === 'auip-2048' ? 'game.js' : 'simulation.js';
    const files = ['index.html', 'auip.manifest.json', game].map(file => [`${example}/${file}`, `${example}/${file}`]);
    if (name === 'auip-2048') for (const file of sdk) files.push([file, file]);
    else for (const file of [...sdk, 'sdk/auip-core/controller-v0.js']) files.push([file, `${example}/${path.basename(file)}`]);
    for (const [original, destination] of files) {
      const file = path.join(workDir, destination);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, upstreamFile(original));
      notify({ type: 'artifact', path: file });
    }
  };
  const provider = {
    async start(request, notify) { await materialize(request.prompt, request.projectPath, notify); return { outcome: 'completed' }; },
    async append() {}, async cancel() {}, async reply() {}
  };
  async function until(label, read) {
    const end = Date.now() + 8000;
    while (Date.now() < end) { const result = await read(); if (result) return result; await delay(50); }
    throw new Error(`Timed out: ${label}`);
  }
  let host;
  try {
    host = await LocalHost.open(path.join(temporary, 'host'), provider, project);
    const apps = new Map();
    for (const name of examples) {
      const entry = `examples/${name}/index.html`;
      const task = await host.command({ type: 'work', command: { type: 'submit', projectId: host.selectedProjectId,
        prompt: name, authoring: true, expectedArtifacts: [entry] } });
      const attempt = await until(`${name} delivery`, () => host.snapshot().work.attempts.find(item => item.taskId === task.id && item.assessment));
      assert.equal(attempt.assessment.review, 'review_ready', JSON.stringify(attempt.assessment));
      const artifact = host.artifacts.listArtifacts().find(item => item.taskId === task.id && item.relativePath.replace(/\\/g, '/') === entry);
      assert.ok(artifact);
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      window.webContents.on('console-message', event => {
        if (event.level === 'error' && report.diagnostics.length < 12) report.diagnostics.push(String(event.message).slice(0, 300));
      });
      windows.push(window);
      await window.loadURL((await host.command({ type: 'artifact-launch', artifactId: artifact.id })).url);
      const session = await until(`${name} AUIP registration and initial state`, () => host.apps.listSessions().find(item => item.artifactId === artifact.id && item.state));
      const current = () => host.apps.listSessions().find(item => item.id === session.id);
      apps.set(name, { task, attempt, window, current, id: session.id });
    }
    const merge = apps.get('auip-2048');
    const state = merge.current();
    const legal = state.state.actions.options.find(option => option.available === true);
    assert.ok(legal);
    const receipt = await host.command({ type: 'app-action', sessionId: merge.id, action: 'game.slide', payload: legal.payload,
      expected: { revision: state.revision, generation: state.generation } });
    assert.ok(receipt.accepted && merge.current().state.moveCount === state.state.moveCount + 1);
    await until('2048 semantic event', () => merge.current().events.some(event => event.type === 'game.slide_committed'));
    report.checks.upstream2048 = true;
    await assert.rejects(host.apps.invokeAction(merge.id, 'game.slide', legal.payload, state), /stale_action_revision/);
    const acceptance = await host.command({ type: 'work', command: { type: 'accept', taskId: merge.task.id, attemptId: merge.attempt.id } });
    assert.equal(acceptance.assessment.review, 'accepted');
    report.checks.userAcceptance = true;
    merge.window.destroy();
    await until('2048 disconnected', () => merge.current().status === 'disconnected');
    await assert.rejects(host.apps.invokeAction(merge.id, 'game.slide', legal.payload, state), /session_not_active/);
    report.checks.staleAndDisconnected = true;
    const battle = apps.get('auip-bullet-hell');
    const policy = await host.apps.invokeAction(battle.id, 'battle.set_tactics', { mode: 'evade' }, battle.current());
    assert.ok(policy.accepted && policy.controller_lease);
    await until('Controller active on app and Host', async () => battle.current().controller.status === 'active' &&
      (await battle.window.webContents.executeJavaScript('window.__bulletHell.controllerStatus().status')) === 'active');
    assert.equal(battle.current().controller.lease.lease_id, policy.controller_lease.lease_id);
    await host.command({ type: 'app-mode', sessionId: battle.id, mode: 'observe' });
    await until('Controller revocation acknowledged', async () => battle.current().controller.status === 'idle' &&
      (await battle.window.webContents.executeJavaScript('window.__bulletHell.controllerStatus().status')) === 'idle');
    await assert.rejects(host.apps.invokeAction(battle.id, 'battle.set_tactics', { mode: 'follow' }, battle.current()), /participant_stance_required/);
    report.checks.upstreamControllerAndTakeover = true;
    report.passed = true;
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  finally {
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    await host?.close();
    const output = path.join(root, 'outputs/host-validation', `${path.basename(temporary)}.json`);
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, output }));
    app.exit(report.passed ? 0 : 1);
  }
}
