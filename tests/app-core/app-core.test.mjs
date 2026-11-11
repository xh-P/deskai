import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { ArtifactRegistry, AppHost } from '../../packages/app-core/src/index.ts';

function message(ws, accept) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', receive); reject(new Error('AUIP message timed out')); }, 3000);
    function receive(raw) {
      const data = JSON.parse(raw);
      if (accept(data)) { clearTimeout(timer); ws.off('message', receive); resolve(data); }
    }
    ws.on('message', receive);
  });
}

test('verified AUIP bundle, single-use ticket, action receipt and disconnect', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'deskai-app-'));
  let host;
  try {
    const files = ['todo.html', 'auip.manifest.json', 'deskai-app-client.js'];
    for (const file of files) await copyFile(path.join('packages/app-core/examples', file), path.join(dir, file));
    const authorize = (id, root, rel) => id === 'task' && root === dir && files.includes(rel);
    const storageFile = path.join(dir, 'registry.json');
    let registry = new ArtifactRegistry({ authorize, storageFile });
    await assert.rejects(registry.registerArtifact({ taskId: 'other', workDir: dir, relativePath: 'todo.html' }));
    const [entry] = await Promise.all(files.map(relativePath => registry.registerArtifact({ taskId: 'task', workDir: dir, relativePath })));
    registry = new ArtifactRegistry({ authorize, storageFile });
    await registry.load();
    host = new AppHost(registry);
    await host.start();
    const url = new URL((await host.prepareLaunch(entry.id)).url);
    assert.equal((await fetch(url.origin + url.pathname)).status, 200);
    assert.equal((await fetch(new URL('registry.json', url))).status, 404);
    const launch = JSON.parse(Buffer.from(url.hash.slice('#amadeus-auip='.length), 'base64url'));
    assert.equal(launch.schema, 'amadeus.auip/launch-v0');
    const ws = new WebSocket(launch.webSocketUrl, { origin: url.origin });
    const replay = new WebSocket(launch.webSocketUrl, { origin: url.origin });
    await Promise.all([once(ws, 'open'), once(replay, 'open')]);
    let sequence = 0;
    const call = async (peer, method, params) => {
      const id = String(++sequence);
      const result = message(peer, frame => frame.type === 'res' && frame.id === id);
      peer.send(JSON.stringify({ type: 'req', id, method, params }));
      return (await result).params;
    };
    const manifest = JSON.parse(await readFile(path.join(dir, 'auip.manifest.json'), 'utf8'));
    const register = { manifest, attach_ticket: launch.attachTicket };
    const invalid = { ...manifest, app: { ...manifest.app, id: 'other' } };
    assert.equal((await call(ws, 'auip.register', { ...register, manifest: invalid })).error, 'manifest_artifact_mismatch');
    const { app_session_id, bridge_token } = await call(ws, 'auip.register', register);
    assert.equal((await call(replay, 'auip.register', register)).error, 'invalid_attach_ticket');
    replay.close();
    const auth = { app_session_id, bridge_token };
    assert.equal((await call(ws, 'auip.state.publish', { ...auth, revision: 1, state: { items: [] } })).ok, true);
    const first = { revision: 1, generation: 0 };
    await assert.rejects(host.invokeAction(app_session_id, 'todo.add', { text: 3 }, first), /invalid_action_payload/);
    const requested = message(ws, frame => frame.method === 'auip.action.requested');
    const pending = host.invokeAction(app_session_id, 'todo.add', { text: 'hello' }, first);
    const { action_id } = (await requested).params.action;
    await call(ws, 'auip.action.result', { ...auth, action_id, accepted: true, resulting_revision: 2, state: { items: ['hello'] } });
    assert.equal((await pending).accepted, true);
    await assert.rejects(host.invokeAction(app_session_id, 'todo.add', { text: 'stale' }, first), /stale_action_revision/);
    const waiting = host.invokeAction(app_session_id, 'todo.add', { text: 'later' }, { revision: 2, generation: 0 });
    ws.close();
    await assert.rejects(waiting, /connection_lost/);
    assert.equal(host.listSessions()[0].status, 'disconnected');
    await writeFile(path.join(dir, 'todo.html'), 'changed');
    await assert.rejects(host.prepareLaunch(entry.id), /changed/);
  } finally {
    await host?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
