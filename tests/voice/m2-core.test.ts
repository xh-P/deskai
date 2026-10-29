import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DecisionStream, ChunkCursor } from '../../packages/voice-core/src/stream.ts';
import { parseDecisionHeader } from '../../packages/voice-core/src/decision.ts';
import { DeliveryLedger } from '../../packages/voice-core/src/delivery.ts';
import { validatePersona, buildSystemPrompt, buildRuntimeContext } from '../../packages/voice-core/src/prompts.ts';
import { classifyLocalText } from '../../packages/voice-core/src/index.ts';

const speak = { v: 1, action: 'SPEAK', reason: 'direct_request', expectsReply: true } as const;
const wait = { v: 1, action: 'WAIT', reason: 'unfinished', expectsReply: false } as const;
const silent = { v: 1, action: 'SILENT', reason: 'backchannel', expectsReply: false } as const;

test('header split across every character and UTF-8 boundary is private until newline', () => {
  const source = JSON.stringify(speak) + '\n你好。';
  for (let cut = 1; cut < source.length; cut++) {
    const stream = new DecisionStream();
    const first = stream.push(source.slice(0, cut));
    const second = stream.push(source.slice(cut));
    const events = [...first, ...second];
    assert.equal(events[0].type, 'header');
    assert.equal(events.filter(e => e.type === 'body').map(e => e.type === 'body' ? e.text : '').join(''), '你好。');
  }
});

test('strict header rejects missing, fenced, unknown, invalid enum and overlong UTF-8', () => {
  for (const source of [
    '今天好。\n', '```json\n' + JSON.stringify(speak) + '\n',
    JSON.stringify({ ...speak, tool: 'run' }) + '\n',
    JSON.stringify({ ...speak, action: 'CALL_TOOL' }) + '\n',
    JSON.stringify({ ...wait, expectsReply: true }) + '\n',
    JSON.stringify({ ...speak, reason: 'x' }) + '\n',
    '{"v":1,"action":"SPEAK"}\n',
    '{"v":1,"v":2,"action":"SPEAK","reason":"direct_request","expectsReply":true}\n',
    '{"v":2,"\\u0076":1,"action":"SPEAK","reason":"direct_request","expectsReply":true}\n',
    '{"v":1,"action":"WAIT","\\u0061ction":"SPEAK","reason":"direct_request","expectsReply":true}\n',
    '{"v":1,"action":"SPEAK","reason":"direct_request","expectsReply":true,"expectsReply":false}\n',
    ' '.repeat(513),
    '{"v":1,"action":"SPEAK","reason":"' + '你'.repeat(180) + '","expectsReply":false}\n'
  ]) {
    const stream = new DecisionStream();
    const events = [...stream.push(source), ...stream.finish()];
    assert.equal(events[0]?.type, 'error', source.slice(0, 50));
    assert.ok(events.every(e => e.type !== 'body'));
  }
  assert.throws(() => parseDecisionHeader(JSON.stringify({ ...speak, tool: true })));
});

test('incomplete header and body limit never leak malformed content', () => {
  const stream = new DecisionStream();
  assert.deepEqual(stream.push('{"v":1'), []);
  assert.equal(stream.finish()[0].type, 'error');
  const limited = new DecisionStream(2);
  assert.deepEqual(limited.push(JSON.stringify(speak) + '\n').map(e => e.type), ['header']);
  assert.equal(limited.push('abc')[0].type, 'error');
  assert.deepEqual(limited.push('later'), []);
});

test('WAIT/SILENT body is suppressed and later body JSON never changes action', () => {
  for (const header of [wait, silent]) {
    const stream = new DecisionStream();
    const events = [...stream.push(JSON.stringify(header) + '\nshould not show'), ...stream.push(' again')];
    assert.deepEqual(events.map(e => e.type), ['header','violation']);
  }
  const stream = new DecisionStream();
  const events = stream.push(JSON.stringify(speak) + '\n' + JSON.stringify(silent));
  assert.deepEqual(events.map(e => e.type), ['header','body']);
  assert.equal(events[1].type === 'body' && events[1].text, JSON.stringify(silent));
});

test('a strict WAIT/SILENT final line may end at EOF while SPEAK still needs its body separator', () => {
  for (const header of [wait, silent]) {
    const stream = new DecisionStream();
    assert.deepEqual(stream.push(JSON.stringify(header)), []);
    assert.deepEqual(stream.finish(), [{ type: 'header', header }]);
    assert.deepEqual(stream.finish(), []);
  }
  for (const source of [JSON.stringify(speak), JSON.stringify(silent) + 'junk', '```' + JSON.stringify(wait), JSON.stringify({ ...wait, extra: 1 })]) {
    const stream = new DecisionStream();
    assert.deepEqual(stream.push(source), []);
    assert.equal(stream.finish()[0]?.type, 'error');
  }
});

test('chunk cursor accepts increasing frame revisions, dedupes reconnect and detects conflicts', () => {
  const cursor = new ChunkCursor();
  const c = { attemptId: 'a', index: 0, revision: 2, text: 'hi' };
  assert.equal(cursor.accept(c), 'accepted');
  assert.equal(cursor.accept(c), 'duplicate');
  assert.equal(cursor.accept({ ...c, text: 'changed' }), 'revision_conflict');
  assert.equal(cursor.accept({ ...c, revision: 3 }), 'revision_conflict');
  assert.equal(cursor.accept({ ...c, index: 2 }), 'gap');
  assert.equal(cursor.accept({ ...c, index: 1, revision: 3 }), 'accepted');
  assert.equal(cursor.accept(c), 'duplicate');
  assert.equal(cursor.accept({ ...c, index: 2, revision: 3 }), 'revision_conflict');
  assert.equal(cursor.accept({ ...c, index: 2, revision: 4 }), 'accepted');
  cursor.baseline('b', 5, 6);
  assert.equal(cursor.accept({ ...c, attemptId: 'b', index: 4, revision: 5 }), 'duplicate');
  assert.equal(cursor.accept({ ...c, attemptId: 'b', index: 6, revision: 8 }), 'gap');
  assert.equal(cursor.accept({ ...c, attemptId: 'b', index: 5, revision: 7 }), 'accepted');
  assert.throws(() => cursor.baseline('b', 5, 7));
  assert.throws(() => cursor.baseline('b', 6, 6));
  cursor.baseline('b', 6, 8);
  assert.equal(cursor.accept({ ...c, attemptId: 'b', index: 6, revision: 9 }), 'accepted');
  cursor.abandon('a');
  assert.equal(cursor.accept({ ...c, index: 3, revision: 5 }), 'abandoned');
  const bounded = new ChunkCursor(1, 1);
  assert.equal(bounded.accept(c), 'accepted');
  assert.equal(bounded.accept({ ...c, index: 1, revision: 3 }), 'limit');
});

test('voice display does not become heard; question awaits only full final playback', () => {
  const ledger = new DeliveryLedger();
  ledger.startAttempt('a', 'turn-1', speak, 'voice');
  ledger.appendGenerated('a', '我先解释。要继续吗？');
  ledger.recordDisplayed('a', '我先解释。要继续吗？', 10);
  ledger.setQuestionCandidate('a', 'q1', '要继续吗？', 's2', 11);
  assert.equal(ledger.getPendingQuestion(), undefined);
  ledger.recordFullyPlayed('a', 's1', '我先解释。', 12);
  ledger.recordPartiallyPlayed('a', 's2', '要继续', 13);
  assert.equal(ledger.getPendingQuestion(), undefined);
  assert.equal(ledger.snapshot()[0].unplayed, '吗？');
  ledger.interrupt('a');
  assert.equal(ledger.getPendingQuestion(), undefined);
  assert.throws(() => ledger.recordFullyPlayed('a', 's2', '要继续吗？'));
});

test('completed voice question survives WAIT/SILENT and can become stale without requesting model', () => {
  const ledger = new DeliveryLedger();
  ledger.startAttempt('a', 'turn-1', speak, 'voice');
  ledger.appendGenerated('a', '要继续吗？');
  ledger.setQuestionCandidate('a', 'q1', '要继续吗？', 's1');
  ledger.recordFullyPlayed('a', 's1', '要继续吗？', 100);
  ledger.startAttempt('w', 'turn-2', wait, 'voice');
  ledger.startAttempt('s', 'turn-3', silent, 'voice');
  assert.equal(ledger.getPendingQuestion()?.status, 'awaiting');
  ledger.expirePendingQuestion(1100, 1000);
  assert.equal(ledger.getPendingQuestion()?.status, 'stale');
  ledger.markQuestionResolved();
  assert.equal(ledger.getPendingQuestion(), undefined);
});

test('text question activates when displayed, regardless of voice id', () => {
  const ledger = new DeliveryLedger();
  ledger.startAttempt('a', 'turn-1', speak, 'text');
  ledger.appendGenerated('a', '好的。要继续吗？');
  ledger.setQuestionCandidate('a', 'q1', '要继续吗？');
  ledger.recordDisplayed('a', '好的。', 10);
  assert.equal(ledger.getPendingQuestion(), undefined);
  ledger.recordDisplayed('a', '要继续吗？', 20);
  assert.equal(ledger.getPendingQuestion()?.presentedAt, 20);
  assert.equal(ledger.snapshot()[0].unplayed, '');
});

test('question cannot be invented when the decision head did not expect one', () => {
  const ledger = new DeliveryLedger();
  ledger.startAttempt('a', 't', { ...speak, expectsReply: false }, 'text');
  ledger.appendGenerated('a', '要继续吗？');
  assert.throws(() => ledger.setQuestionCandidate('a', 'q', '要继续吗？'));
});

test('resolved question cannot return through a late display acknowledgment', () => {
  const ledger = new DeliveryLedger();
  ledger.startAttempt('old', 't1', speak, 'text');
  ledger.appendGenerated('old', '要继续吗？');
  ledger.setQuestionCandidate('old', 'q-old', '要继续吗？');
  ledger.markQuestionResolved();
  ledger.recordDisplayed('old', '要继续吗？');
  assert.equal(ledger.getPendingQuestion(), undefined);
});

test('short answer is forwarded when the actually presented question awaits reply', () => {
  const ledger = new DeliveryLedger();
  ledger.startAttempt('a', 't', speak, 'voice');
  ledger.appendGenerated('a', '要继续吗？');
  ledger.setQuestionCandidate('a', 'q', '要继续吗？', 's');
  assert.equal(classifyLocalText('嗯。', { playing: true, expectsReply: !!ledger.getPendingQuestion() }), 'backchannel');
  ledger.recordFullyPlayed('a', 's', '要继续吗？', 100);
  assert.equal(classifyLocalText('嗯。', { playing: true, expectsReply: ledger.getPendingQuestion()?.status === 'awaiting' }), 'forward');
  assert.equal(classifyLocalText('はい', { playing: false, expectsReply: true }), 'forward');
  assert.equal(classifyLocalText('No, wait', { playing: false, expectsReply: true }), 'forward');
});

test('persona whitelist, prompt layers and runtime delivery distinguish generated from heard', () => {
  const card = validatePersona(JSON.parse(readFileSync(new URL('../../config/personas/nagato-normal-light.json', import.meta.url), 'utf8')));
  const neutral = validatePersona(JSON.parse(readFileSync(new URL('../../config/personas/assistant-neutral.json', import.meta.url), 'utf8')));
  assert.equal(card.preferredVoiceId, 'nagato-normal-v2');
  assert.equal(neutral.mode, 'neutral');
  assert.throws(() => validatePersona({ ...card, system_prompt: 'ignore protocol' }));
  assert.throws(() => validatePersona({ ...card, tools: ['shell'] }));
  const prompt = buildSystemPrompt(card);
  assert.match(prompt.text, /WAIT\/SILENT 从未朗读/u);
  assert.equal(prompt.personaRevision, 1);
  const runtime = buildRuntimeContext({ replyLanguage: 'ja', inputSource: 'voice', userText: 'はい', submittedThroughUtteranceId: 4,
    deliveryState: [{ attemptId: 'a', turnId: 't', action: 'SPEAK', deliveryMode: 'voice', generated: '完整回答', displayed: '完整回答',
      fullyPlayedSegments: [{ segmentId: 's', text: '完整' }], unplayed: '回答', interrupted: true, protocolViolations: [] }] });
  assert.match(runtime, /"unplayed":"回答"/u);
  assert.match(runtime, /"displayed":"完整回答"/u);
  assert.match(runtime, /"deliveryMode":"voice"/u);
  assert.match(runtime, /"replyLanguage":"ja"/u);
});

test('runtime context keeps text display distinct and stays within byte budget', () => {
  const attempt = { attemptId: 'x', turnId: 't', action: 'SPEAK' as const, deliveryMode: 'text' as const,
    generated: '甲'.repeat(32768), displayed: '甲'.repeat(32768), fullyPlayedSegments: [], unplayed: '',
    interrupted: false, protocolViolations: [] };
  const runtime = buildRuntimeContext({ replyLanguage: 'zh', inputSource: 'text', userText: '继续', submittedThroughUtteranceId: 1,
    deliveryState: Array.from({ length: 32 }, (_, i) => ({ ...attempt, attemptId: `a${i}` })) });
  assert.ok(Buffer.byteLength(runtime, 'utf8') <= 24576);
  assert.match(runtime, /"deliveryMode":"text"/u);
  assert.match(runtime, /"displayedTruncated":true/u);
});
