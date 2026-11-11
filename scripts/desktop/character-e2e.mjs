import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalDshSpeech } from '../../packages/dsh-adapter/src/speech.ts';
import { chatPatchPath } from '../../packages/dsh-adapter/src/chat-patch.ts';
import { DialogueController } from '../../packages/voice-core/src/dialogue.ts';
import { CharacterKnowledge } from '../../apps/desktop/src/character-knowledge.ts';
import { CharacterStore, ConversationArchive } from '../../apps/desktop/src/character-store.ts';
import { createChatRuntime, readChatRuntimeConfig } from '../../apps/desktop/src/chat-runtime.ts';

if (!process.argv.includes('--real-model')) throw new Error('Pass --real-model to run the paired text dialogue probe.');
const root = path.resolve(import.meta.dirname, '../..');
const directory = await mkdtemp(path.join(tmpdir(), 'deskai-character-e2e-'));
const knowledge = new CharacterKnowledge(root);
const service = new LocalDshSpeech(root);
const roleId = 'nagato-mainline-post-disappearance';
const report = { timestamp: new Date().toISOString(), physicalAudioTested: false, pairs: [], passed: false };
let archive;
const cases = [
  ['daily', '今天有点累。'],
  ['hospital', '《消失》结尾，病房里阿虚答应了什么？如果能定位，请顺带说一下出处。'],
  ['shared-experience', '还记得我们上周一起看烟火吗？'],
];

async function ask(port, record, text, enabled) {
  const drafts = new Map();
  let lookup, finish, fail;
  const answer = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  void answer.catch(() => {});
  const dialogue = new DialogueController(port, { personaId: record.persona.id, persona: record.persona,
    relationshipMode: record.relationshipMode, replyLanguage: 'zh', voiceId: 'nagato-normal-v2', characterKnowledge: enabled }, event => {
    if (event.type === 'knowledge') lookup = event.result;
    if (event.type === 'assistant-delta') {
      const text = (drafts.get(event.attemptId) ?? '') + event.text;
      drafts.set(event.attemptId, text);
      dialogue.displayed(event.attemptId, text.length);
    }
    if (event.type === 'assistant-state' && event.state === 'complete') finish(drafts.get(event.attemptId));
    if (event.type === 'error') fail(new Error(event.code));
  }, undefined, record.history);
  const timer = setTimeout(() => fail(new Error('CHARACTER_MODEL_TIMEOUT')), 150_000);
  try {
    assert.equal((await dialogue.submit({ text, source: 'text', hostContext: { receipt: { kind: 'chat' } } })).accepted, true);
    const reply = await answer;
    assert.ok(reply?.trim()); assert.ok(lookup);
    return { lookup, reply, history: dialogue.projectHistory().history };
  } finally { clearTimeout(timer); await dialogue.close(); }
}

try {
  const config = await readChatRuntimeConfig(root);
  report.provider = config.provider;
  if (config.provider === 'dsh-session') {
    await service.start();
    const patch = JSON.parse(await readFile(chatPatchPath(root), 'utf8'));
    const route = patch.find(entry => entry.id === 'agent-default-model')?.config;
    if (route) report.model = { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort };
  } else report.model = { model: config.model };
  const { port } = await createChatRuntime(service, root, knowledge);
  const characters = await CharacterStore.open(root, directory);
  archive = await ConversationArchive.open(directory);
  const card = characters.get(roleId);
  report.character = { id: card.id, revision: card.revision, relationshipMode: 'friend' };
  let original;
  for (const [name, text] of cases) {
    const pair = { name, text, replies: {} };
    report.pairs.push(pair);
    for (const enabled of [false, true]) {
      const record = await archive.create(card, 'friend');
      const { history, ...result } = await ask(port, record, text, enabled);
      archive.checkpoint(record.id, history);
      pair.replies[enabled ? 'on' : 'off'] = result;
      original ??= record.id;
      console.log(`${name} ${enabled ? 'on' : 'off'}: ${result.lookup.status}`);
    }
  }
  assert.equal(report.pairs[1].replies.on.lookup.hits[0]?.id, 'disappearance-hospital-kyon-promise');
  assert.match(report.pairs[1].replies.on.reply, /找回|找回来|带回来|带回去|带回|把我找/u);
  for (const pair of report.pairs) assert.equal(pair.replies.off.lookup.status, 'disabled');
  assert.equal(report.pairs[0].replies.on.lookup.status, 'miss');
  assert.equal(report.pairs[2].replies.on.lookup.status, 'miss');

  const edited = await characters.save({ id: card.id, revision: card.revision, displayName: card.displayName, traits: card.traits,
    speechStyle: [...card.speechStyle.slice(0, 7), '用户询问约定短句时，原样回答：微光已经亮了。'] });
  await archive.flush();
  archive = await ConversationArchive.open(directory);
  const restored = archive.get(original);
  assert.equal(restored.persona.revision, card.revision);
  assert.equal(restored.relationshipMode, 'friend');
  assert.equal(restored.history.length, 2);
  const record = await archive.create(edited, 'kyon');
  const check = await ask(port, record, '请说出我们约定的短句。', false);
  report.edit = { restoredRevision: restored.persona.revision, restoredMessages: restored.history.length,
    newRevision: record.persona.revision, newRelationship: record.relationshipMode, reply: check.reply };
  assert.match(check.reply, /微光已经亮了/u);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  knowledge.close();
  await service.dispose();
  await archive?.flush();
  if (path.dirname(path.resolve(directory)) === path.resolve(tmpdir())) await rm(directory, { recursive: true, force: true });
  const output = path.join(root, 'outputs/desktop-validation/characters');
  await mkdir(output, { recursive: true });
  const file = path.join(output, `character-e2e-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(file);
  if (report.error) console.error(report.error);
}
