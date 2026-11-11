import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAICompatibleChat } from '../../packages/dsh-adapter/src/openai-chat.ts';
import type { ChatEvent, ChatTurnInput } from '../../packages/voice-core/src/chat-contract.ts';
import { DialogueController, type DialogueHistoryEntry } from '../../packages/voice-core/src/dialogue.ts';
import { CharacterStore, ConversationArchive } from '../../apps/desktop/src/character-store.ts';
import { CharacterChat, CharacterKnowledge } from '../../apps/desktop/src/character-knowledge.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('reopened conversation supplies its original role and delivered history after a character edit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deskai-character-store-'));
  try {
    const characters = await CharacterStore.open(root, directory);
    const archive = await ConversationArchive.open(directory);
    const card = characters.get('nagato-mainline-post-disappearance');
    const record = await archive.create(card, 'kyon');
    const history: DialogueHistoryEntry[] = [{ role: 'user', turnId: 'turn-1', text: '刚才在谈什么？' },
      { role: 'assistant', turnId: 'turn-1', text: '图书馆。', interrupted: true }];
    archive.checkpoint(record.id, history);
    const draft = { id: card.id, revision: card.revision, displayName: '已编辑', traits: card.traits, speechStyle: card.speechStyle };
    const edited = await characters.save(draft);
    await assert.rejects(characters.save(draft), /CHARACTER_REVISION_CHANGED/);
    assert.equal((await CharacterStore.open(root, directory)).get(card.id).revision, edited.revision);
    await archive.flush();
    const restored = (await ConversationArchive.open(directory)).get(record.id);
    let request: ChatTurnInput | undefined;
    const port = { async runTurn(input: ChatTurnInput) {
      request = input;
      return { accepted: true as const, sessionId: 'fixture', completed: Promise.resolve({ sessionId: 'fixture', status: 'completed' as const }) };
    }, async cancel() { return undefined; } };
    const dialogue = new DialogueController(port, { personaId: restored.persona.id, persona: restored.persona,
      relationshipMode: restored.relationshipMode, voiceId: 'v', replyLanguage: 'auto' }, () => {}, undefined, restored.history);
    try {
      await dialogue.submit({ text: '继续聊刚才的话题。', source: 'text' });
      assert.equal(request?.persona?.revision, card.revision);
      assert.equal(request?.relationshipMode, 'kyon');
      assert.deepEqual(request?.visibleHistory, history);
      assert.equal(dialogue.projectHistory().history.at(-1)?.turnId, 'turn-2');
    } finally { await dialogue.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an unprepared knowledge index falls through to ordinary Chat', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deskai-knowledge-missing-'));
  const id = 'nagato-mainline-post-disappearance';
  const knowledge = new CharacterKnowledge(directory);
  try {
    const corpus = `config/character-knowledge/${id}.json`;
    await mkdir(path.join(directory, path.dirname(corpus)), { recursive: true });
    await copyFile(path.join(root, corpus), path.join(directory, corpus));
    const port = new CharacterChat({ async runTurn(input) {
      assert.deepEqual(input.characterReference, []);
      return { accepted: true, sessionId: 'fixture', completed: Promise.resolve({ sessionId: 'fixture', status: 'completed' }) };
    }, async cancel() { return undefined; } }, knowledge);
    const accepted = await port.runTurn({ text: '病房里的承诺', personaId: id, characterKnowledge: true }, () => {});
    assert.equal(accepted.knowledge.status, 'unavailable');
    assert.equal(accepted.knowledge.code, 'KNOWLEDGE_SETUP_REQUIRED');
    assert.equal((await accepted.completed).status, 'completed');
  } finally { knowledge.close(); await rm(directory, { recursive: true, force: true }); }
});

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
