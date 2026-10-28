import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { LocalDshChat, type ChatEvent } from '../../packages/dsh-adapter/src/session.ts';
import { LocalDshSpeech } from '../../packages/dsh-adapter/src/speech.ts';
import WebSocket, { WebSocketServer } from 'ws';

function fixture() {
  const calls: { endpoint: string; request: Record<string, unknown> }[] = [];
  let frame: (frame: unknown) => void = () => {};
  const host = {
    async sessionCall<T>(endpoint: string, request: Record<string, unknown>): Promise<T> {
      calls.push({ endpoint, request });
      if (endpoint === 'session/create') return { sessionId: 'session-1', agentPreset: request.agentPreset } as T;
      return { accepted: true } as T;
    },
    async sessionFollow(_request: object, listener: (frame: unknown) => void) {
      frame = listener;
      queueMicrotask(() => listener({ type: 'item', value: { type: 'snapshot', cursor: 4,
        records: [{ type: 'event', event: { seq: 3, type: 'assistant/message', data: { text: 'old' } } }],
        assistantStream: { revision: 3, activeAttempt: { stream: [{ text: 'old' }] } } } }));
      return () => {};
    }
  } as unknown as LocalDshSpeech;
  const send = (value: unknown) => frame({ type: 'item', value });
  const sendRaw = (value: unknown) => frame(value);
  return { host, calls, send, sendRaw };
}

test('acceptance is separate from settlement; only ordered live text is emitted', async () => {
  const { host, calls, send } = fixture();
  const chat = new LocalDshChat(host, 'E:/workspace/deskai2');
  const events: ChatEvent[] = [];
  const accepted = await chat.runTurn({ text: '你好', mode: 'voice', visibleHistory: [
    { role: 'assistant', turnId: 'old', text: '已播', rawText: '秘密' }], deliveryState: { attempts: [
    { attemptId: 'old', turnId: 'old', action: 'SPEAK', deliveryMode: 'voice', generated: '已播秘密', unplayed: '秘密',
      generatedCharacters: 4, unplayedCharacters: 2, fullyPlayedSegments: [{ segmentId: 's1', text: '已播' }] }] } }, e => events.push(e));
  assert.equal(accepted.accepted, true);
  assert.deepEqual(calls.map(c => c.endpoint), ['session/create', 'session/prompt']);
  const prompt = calls[1].request.content as { text: string }[];
  assert.doesNotMatch(prompt[0].text, /秘密/);
  assert.match(prompt[0].text, /"unplayedCharacters":2/);
  assert.match(prompt[0].text, /已播/);
  assert.equal(events.length, 0); // reconnect baseline never replays old text
  send({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  send({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  send({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 2, index: 0,
    chunk: { type: 'reasoning-delta', text: '不要播放' } } });
  send({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 3, index: 1,
    chunk: { type: 'text-delta', text: '你好。' } } });
  send({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 3, index: 1,
    chunk: { type: 'text-delta', text: '你好。' } } });
  send({ type: 'event', event: { seq: 5, type: 'assistant/message', data: { text: '你好。' } } });
  send({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'a', revision: 4, outcome: { kind: 'committed', eventType: 'assistant/message' } } });
  assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.text), ['你好。']);
  assert.equal(events.filter(e => e.type === 'attempt-start').length, 1);
  send({ type: 'event', event: { seq: 6, type: 'turn/end' } });
  assert.deepEqual(await accepted.completed, { sessionId: 'session-1', status: 'completed' });
});

test('stream gap and reconnect snapshot gap cancel without replay', async () => {
  const { host, calls, send } = fixture();
  const chat = new LocalDshChat(host, 'E:/workspace/deskai2');
  const events: ChatEvent[] = [];
  const accepted = await chat.runTurn({ text: '测试' }, e => events.push(e));
  send({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  send({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 2, index: 0, chunk: { type: 'text-delta', text: '已收' } } });
  await chat.reconnectFollow();
  send({ type: 'snapshot', cursor: 5, assistantStream: { activeAttempt: { attemptId: 'a', nextIndex: 3 } } });
  send({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 4, index: 3, chunk: { type: 'text-delta', text: '未收' } } });
  assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.text), ['已收']);
  assert(events.some(e => e.type === 'error' && e.code === 'CHAT_RECONNECT_GAP'));
  assert.equal(calls.filter(c => c.endpoint === 'session/cancel').length, 1);
  await assert.rejects(chat.runTurn({ text: '不能并发' }, () => {}), /CHAT_TURN_BUSY/);
  send({ type: 'event', event: { seq: 6, type: 'turn/end' } });
  assert.equal((await accepted.completed).status, 'failed');
});

test('follow loss after admission requests cancel and retains reservation until confirmed', async () => {
  const { host, calls, send, sendRaw } = fixture();
  const chat = new LocalDshChat(host, 'E:/workspace/deskai2');
  const accepted = await chat.runTurn({ text: '测试' }, () => {});
  sendRaw({ type: 'error', error: { code: 'DSH_FOLLOW_DISCONNECTED' } });
  assert.equal(calls.filter(c => c.endpoint === 'session/cancel').length, 1);
  await assert.rejects(chat.runTurn({ text: '旧任务未确认' }, () => {}), /CHAT_TURN_BUSY/);
  send({ type: 'event', event: { seq: 5, type: 'turn/end' } });
  assert.equal((await accepted.completed).status, 'failed');
});

test('cancel calls native RPC and waits for durable turn/end', async () => {
  const { host, calls, send } = fixture();
  const chat = new LocalDshChat(host, 'E:/workspace/deskai2');
  const accepted = await chat.runTurn({ text: '停止前的输入', personaId: 'assistant-neutral' }, () => {});
  let resolved = false;
  const cancelled = chat.cancel().then(value => { resolved = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.at(-1)?.endpoint, 'session/cancel');
  assert.equal(resolved, false);
  send({ type: 'event', event: { seq: 5, type: 'turn/end' } });
  assert.deepEqual(await cancelled, { sessionId: 'session-1', status: 'cancelled' });
  assert.deepEqual(await accepted.completed, { sessionId: 'session-1', status: 'cancelled' });
});

test('reservation blocks parallel create and cancel during create prevents prompt', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const host = { async sessionCall<T>(endpoint: string) {
    calls.push(endpoint);
    if (endpoint === 'session/create') { await gate; return { sessionId: 'late', agentPreset: 'deskai2-voice-m2-nagato' } as T; }
    throw new Error('unexpected RPC');
  } } as unknown as LocalDshSpeech;
  const chat = new LocalDshChat(host, 'E:/workspace/deskai2');
  const first = chat.runTurn({ text: '先发' }, () => {});
  await assert.rejects(chat.runTurn({ text: '并发' }, () => {}), /CHAT_TURN_BUSY/);
  const cancellation = chat.cancel();
  release();
  await assert.rejects(first, /CHAT_TURN_CANCELLED_BEFORE_PROMPT/);
  assert.deepEqual(await cancellation, { sessionId: 'late', status: 'cancelled' });
  assert.deepEqual(calls, ['session/create']);
});

test('authenticated HTTP call and Mux follow use local Gateway-compatible fixture', async () => {
  const http = createServer(async (req, res) => {
    assert.equal(req.headers.cookie, 'session=fixture');
    assert.equal(req.url, '/api/session/cancel');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { rpcId: string; method: string };
    assert.equal(body.method, 'session/cancel');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } }));
  });
  const wsServer = new WebSocketServer({ server: http, path: '/api/remote.mux' });
  wsServer.on('connection', peer => peer.on('message', raw => {
    const open = JSON.parse(raw.toString()) as { streamId: string; endpoint: string; type: string };
    if (open.type !== 'open') return;
    assert.equal(open.endpoint, 'session/follow');
    peer.send(JSON.stringify({ type: 'item', streamId: open.streamId, value: { type: 'snapshot', cursor: 3, records: [] } }));
  }));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/api/remote.mux', { headers: { Cookie: 'session=fixture' } });
  await new Promise<void>(resolve => socket.once('open', resolve));
  const service = new LocalDshSpeech('E:/workspace/deskai2') as unknown as Record<string, unknown>;
  service.host = url; service.cookie = 'session=fixture'; service.socket = socket;
  service.start = async () => ({ providers: [] });
  try {
    const value = await (service as unknown as LocalDshSpeech).sessionCall<{ accepted: true }>('session/cancel', { sessionId: 'fixture' });
    assert.equal(value.accepted, true);
    const seen: unknown[] = [];
    const received = new Promise<void>(resolve => {
      void (service as unknown as LocalDshSpeech).sessionFollow({ address: { kind: 'session', sessionId: 'fixture' }, assistantStream: true }, frame => {
        seen.push(frame); if ((frame as { value?: { type?: string } }).value?.type === 'snapshot') resolve();
      });
    });
    await received;
    assert.equal(seen.length, 1);
  } finally {
    socket.close();
    wsServer.close();
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});
