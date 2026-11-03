import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAICompatibleChat } from '../../packages/dsh-adapter/src/openai-chat.ts';
import type { ChatEvent } from '../../packages/dsh-adapter/src/session.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('OpenAI-compatible stream accepts CRLF event boundaries split across transport chunks', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你"}}]}\r',
    '\n\r',
    '\ndata: {"choices":[{"delta":{"content":"好。"}}]}\r\n\r',
    '\ndata: [DONE]\r\n\r\n',
  ];
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
  }), { status: 200 });
  try {
    const events: ChatEvent[] = [];
    const provider = new OpenAICompatibleChat(root, { baseUrl: 'http://127.0.0.1:1/v1/', model: 'test' });
    const accepted = await provider.runTurn({ text: '你好', personaId: 'assistant-neutral' }, event => events.push(event));
    assert.equal((await accepted.completed).status, 'completed');
    assert.equal(events.filter(event => event.type === 'text').map(event => event.type === 'text' ? event.text : '').join(''), '你好。');
  } finally { globalThis.fetch = originalFetch; }
});

test('OpenAI-compatible cancellation aborts an active streaming request', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const provider = new OpenAICompatibleChat(root, { baseUrl: `http://127.0.0.1:${address.port}/v1/`, model: 'test' });
    const accepted = await provider.runTurn({ text: '开始', personaId: 'assistant-neutral' }, () => {});
    const cancelled = await provider.cancel();
    assert.equal(cancelled?.status, 'cancelled');
    assert.equal((await accepted.completed).status, 'cancelled');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
