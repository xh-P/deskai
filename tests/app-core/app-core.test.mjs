import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { ArtifactRegistry, AppHost } from '../../packages/app-core/src/index.ts';
const once = (ws, type) => new Promise((resolve, reject) => { const timer=setTimeout(()=>reject(new Error('timeout '+type)),3000); ws.on('message', raw=>{const m=JSON.parse(raw);if(m.type===type){clearTimeout(timer);resolve(m)}}) });
test('artifact ownership, digest and live action receipt/disconnect', async () => {
 const dir=await mkdtemp(path.join(tmpdir(),'deskai-app-')); let host;
 try {
  await copyFile('packages/app-core/examples/todo.html',path.join(dir,'todo.html'));
  const authorize=(id, root, rel)=>id==='task' && root===dir && rel==='todo.html';
  let registry=new ArtifactRegistry({authorize,storageFile:path.join(dir,'registry.json')});
  await assert.rejects(registry.registerArtifact({taskId:'other',workDir:dir,relativePath:'todo.html'}));
  const artifact=await registry.registerArtifact({taskId:'task',workDir:dir,relativePath:'todo.html'});
  registry=new ArtifactRegistry({authorize,storageFile:path.join(dir,'registry.json')}); await registry.load(); assert.equal(registry.listArtifacts()[0].id,artifact.id);
  host=new AppHost(registry); await host.start(); const launch=await host.prepareLaunch(artifact.id),url=new URL(launch.url);
  assert.equal((await fetch(url.origin+url.pathname)).status,200);
  const config=JSON.parse(Buffer.from(url.hash.slice(1),'base64url')); const ws=new WebSocket(config.websocket,{origin:url.origin}); await new Promise(r=>ws.on('open',r));
  const registered=once(ws,'registered'); ws.send(JSON.stringify({type:'register',ticket:config.ticket,manifest:{id:'test',title:'test',version:'1',events:['changed'],actions:[{type:'add',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}})); const session=await registered;
  ws.send(JSON.stringify({type:'state',revision:1,state:{items:[]}})); await new Promise(r=>setTimeout(r,20));
  await assert.rejects(host.invokeAction(session.sessionId,'add',{text:3}));
  const requested=once(ws,'action'); const action=host.invokeAction(session.sessionId,'add',{text:'hello'}); const request=await requested;
  ws.send(JSON.stringify({type:'receipt',actionId:request.actionId,accepted:true,revision:2,state:{items:['hello']}})); assert.equal((await action).accepted,true); assert.equal(host.listSessions()[0].revision,2);
  const waiting=host.invokeAction(session.sessionId,'add',{text:'later'}); ws.close(); await assert.rejects(waiting,/disconnected/); assert.equal(host.listSessions()[0].status,'disconnected');
  await writeFile(path.join(dir,'todo.html'),'changed'); await assert.rejects(host.prepareLaunch(artifact.id),/changed/);
 } finally { await host?.close(); await rm(dir,{recursive:true,force:true}); }
});
