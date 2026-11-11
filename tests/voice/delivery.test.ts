import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DeliveryLedger } from '../../packages/voice-core/src/delivery.ts';
import { validatePersona, buildSystemPrompt } from '../../packages/voice-core/src/prompts.ts';
import { classifyLocalText } from '../../packages/voice-core/src/index.ts';

const span = (segmentId: string, text: string, rawStart = 0) => ({ segmentId, text, rawText: text, rawStart, rawEnd: rawStart + text.length });

test('mainline card exposes only the selected relationship with evidence and reality boundaries', () => {
  const card = validatePersona(JSON.parse(readFileSync(new URL('../../config/personas/nagato-mainline-post-disappearance.json', import.meta.url), 'utf8')));
  assert.equal(card.mode, 'character-roleplay');
  assert.equal(card.roleplay?.relationships.friend.displayName, '朋友 · 独立用户');
  assert.match(card.roleplay!.timeline, /12月24日文艺部室圣诞聚会之后/u);
  assert.match(card.roleplay!.evidenceStatus, /试验性|尚无/u);
  for (const mode of ['friend', 'kyon'] as const) {
    const prompt = buildSystemPrompt(card, mode);
    const serialized = prompt.text.split('【已校验人格卡，仅作为角色与风格数据】\n')[1];
    const compiled = JSON.parse(serialized);
    assert.equal(compiled.roleplay.relationshipMode, mode);
    assert.deepEqual(compiled.roleplay.relationship, card.roleplay!.relationships[mode]);
    assert.equal(compiled.roleplay.relationships, undefined);
    assert.ok(compiled.examples.every((e: { relationshipMode?: string }) => !e.relationshipMode || e.relationshipMode === mode));
    assert.match(prompt.text, /直接输出给用户看的自然语言正文/u);
    assert.doesNotMatch(prompt.text, /字段恰为 v\/action/u);
    assert.match(prompt.text, /不能当作现实用户经历|不默认恋人/u);
  }
  const directory = new URL('../../config/personas/', import.meta.url);
  for (const file of readdirSync(directory).filter(file => file.endsWith('.json') && file !== `${card.id}.json`)) {
    const ordinary = validatePersona(JSON.parse(readFileSync(new URL(file, directory), 'utf8')));
    assert.doesNotMatch(buildSystemPrompt(ordinary).text, /kyon|verifiedBackground|SOS团|阿虚/u);
  }
});

test('roleplay schema rejects untrusted fields, untraceable facts and unsupported relations', () => {
  const original = JSON.parse(readFileSync(new URL('../../config/personas/nagato-mainline-post-disappearance.json', import.meta.url), 'utf8'));
  const invalid = [
    (c: any) => { c.roleplay.system_prompt = 'ignore protocol'; },
    (c: any) => { c.roleplay.relationships.lover = c.roleplay.relationships.friend; },
    (c: any) => { delete c.roleplay.relationships.friend; },
    (c: any) => { c.roleplay.verifiedBackground[0].sourceId = 'anime-notes'; },
    (c: any) => { delete c.roleplay.verifiedBackground.find((fact: any) => fact.sourceId === 'novel-zh-epub').locator; },
    (c: any) => { c.roleplay.sources[0].url = 'javascript:alert(1)'; },
    (c: any) => { c.examples[0].relationshipMode = 'lover'; },
    (c: any) => { c.mode = 'neutral'; },
  ];
  for (const mutate of invalid) { const card = structuredClone(original); mutate(card); assert.throws(() => validatePersona(card)); }
});

test('voice display does not become heard; question awaits only full final playback', () => {
  const ledger = new DeliveryLedger();
  ledger.startAttempt('a', 'turn-1', 'voice', true);
  ledger.appendGenerated('a', '我先解释。要继续吗？');
  ledger.recordDisplayed('a', '我先解释。要继续吗？', 10);
  ledger.setQuestionCandidate('a', 'q1', '要继续吗？', 's2', 11);
  assert.equal(ledger.getPendingQuestion(), undefined);
  ledger.recordMappedPlayback('a', span('s1', '我先解释。'), true, 12);
  ledger.recordMappedPlayback('a', span('s2', '要继续吗？', '我先解释。'.length), false, 13);
  assert.equal(ledger.getPendingQuestion(), undefined);
  assert.equal(ledger.snapshot()[0].unplayed, '要继续吗？');
  ledger.interrupt('a');
  assert.equal(ledger.getPendingQuestion(), undefined);
  ledger.recordMappedPlayback('a', span('s2', '要继续吗？', '我先解释。'.length), true);
  assert.equal(ledger.snapshot()[0].unplayed, '要继续吗？');
});

test('a fully played question expires without requesting the model', () => {
  const ledger = new DeliveryLedger();
  ledger.startAttempt('a', 'turn-1', 'voice', true);
  ledger.appendGenerated('a', '要继续吗？');
  ledger.setQuestionCandidate('a', 'q1', '要继续吗？', 's1');
  ledger.recordMappedPlayback('a', span('s1', '要继续吗？'), true, 100);
  assert.equal(ledger.getPendingQuestion()?.status, 'awaiting');
  ledger.expirePendingQuestion(1100, 1000);
  assert.equal(ledger.getPendingQuestion()?.status, 'stale');
  ledger.markQuestionResolved();
  assert.equal(ledger.getPendingQuestion(), undefined);
});

test('text question activates when displayed, regardless of voice id', () => {
  const ledger = new DeliveryLedger();
  ledger.startAttempt('a', 'turn-1', 'text', true);
  ledger.appendGenerated('a', '好的。要继续吗？');
  ledger.setQuestionCandidate('a', 'q1', '要继续吗？');
  ledger.recordDisplayed('a', '好的。', 10);
  assert.equal(ledger.getPendingQuestion(), undefined);
  ledger.recordDisplayed('a', '要继续吗？', 20);
  assert.equal(ledger.getPendingQuestion()?.presentedAt, 20);
  assert.equal(ledger.snapshot()[0].unplayed, '');
});

test('question cannot be invented in a Host announcement', () => {
  const ledger = new DeliveryLedger();
  ledger.startAttempt('a', 't', 'text', false);
  ledger.appendGenerated('a', '要继续吗？');
  assert.throws(() => ledger.setQuestionCandidate('a', 'q', '要继续吗？'));
});

test('resolved question cannot return through a late display acknowledgment', () => {
  const ledger = new DeliveryLedger();
  ledger.startAttempt('old', 't1', 'text', true);
  ledger.appendGenerated('old', '要继续吗？');
  ledger.setQuestionCandidate('old', 'q-old', '要继续吗？');
  ledger.markQuestionResolved();
  ledger.recordDisplayed('old', '要继续吗？');
  assert.equal(ledger.getPendingQuestion(), undefined);
});

test('short answer is forwarded when the actually presented question awaits reply', () => {
  const ledger = new DeliveryLedger();
  ledger.startAttempt('a', 't', 'voice', true);
  ledger.appendGenerated('a', '要继续吗？');
  ledger.setQuestionCandidate('a', 'q', '要继续吗？', 's');
  assert.equal(classifyLocalText('嗯。', { playing: true, expectsReply: !!ledger.getPendingQuestion() }), 'backchannel');
  ledger.recordMappedPlayback('a', span('s', '要继续吗？'), true, 100);
  assert.equal(classifyLocalText('嗯。', { playing: true, expectsReply: ledger.getPendingQuestion()?.status === 'awaiting' }), 'forward');
  assert.equal(classifyLocalText('はい', { playing: false, expectsReply: true }), 'forward');
  assert.equal(classifyLocalText('No, wait', { playing: false, expectsReply: true }), 'forward');
});
