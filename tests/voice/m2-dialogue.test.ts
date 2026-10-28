import test from 'node:test';
import assert from 'node:assert/strict';
import { DialogueController, type DialogueEvent, type DialoguePort } from '../../packages/voice-core/src/dialogue.ts';
import { localDecision } from '../../packages/voice-core/src/policy.ts';
import type { ChatEvent, ChatSettlement, ChatTurnInput } from '../../packages/dsh-adapter/src/session.ts';

const preferences = { personaId: 'nagato-normal-light', replyLanguage: 'auto', voiceId: 'nagato-normal-v2' } as const;
const header = (action: string, expectsReply = false) => JSON.stringify({ v: 1, action, reason: action === 'WAIT' ? 'unfinished' : action === 'SILENT' ? 'closing' : 'direct_request', expectsReply }) + '\n';
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
class FakePort implements DialoguePort {
  requests: ChatTurnInput[] = [];
  cancelCalls = 0;
  listener?: (event: ChatEvent) => void;
  finish?: (value: ChatSettlement) => void;
  attempt = '';
  text = '';
  auto = true;
  async runTurn(input: ChatTurnInput, listener: (event: ChatEvent) => void) {
    this.requests.push(input); this.listener = listener;
    const sessionId = 'session-' + this.requests.length;
    const completed = new Promise<ChatSettlement>(resolve => { this.finish = resolve; });
    this.attempt = 'attempt-' + this.requests.length;
    listener({ type: 'attempt-start', attemptId: this.attempt, revision: 1 });
    if (this.auto) queueMicrotask(() => this.respond(this.text, sessionId));
    return { accepted: true as const, sessionId, completed };
  }
  respond(text: string, sessionId = 'session-' + this.requests.length) {
    this.listener?.({ type: 'text', attemptId: this.attempt, index: 0, revision: 2, text });
    this.listener?.({ type: 'attempt-end', attemptId: this.attempt, outcome: 'committed', eventType: 'assistant/message' });
    this.finish?.({ sessionId, status: 'completed' });
  }
  async cancel() { this.cancelCalls++; const value = { sessionId: 'session-' + this.requests.length, status: 'cancelled' as const }; this.finish?.(value); return value; }
}

test('one request chooses action and emits only SPEAK body, no automatic WAIT/SILENT calls', async () => {
  for (const action of ['SPEAK', 'WAIT', 'SILENT']) {
    const port = new FakePort(), events: DialogueEvent[] = [];
    port.text = header(action) + (action === 'SPEAK' ? '你好。' : 'bad extra body');
    const controller = new DialogueController(port, preferences, event => events.push(event));
    assert.equal((await controller.submit({ text: '你好', source: 'text' })).accepted, true);
    await settle();
    assert.equal(port.requests.length, 1);
    assert.equal(events.filter(event => event.type === 'assistant-delta').map(event => event.type === 'assistant-delta' ? event.text : '').join(''), action === 'SPEAK' ? '你好。' : '');
    if (action !== 'SPEAK') assert.equal(controller.ledger.snapshot()[0].protocolViolations.length, 1);
    controller.expectsReply(Date.now() + 600000);
    controller.tick(Date.now() + 600000);
    await settle(); assert.equal(port.requests.length, 1);
    await controller.close();
  }
});

test('hard local filters invoke no model and do not treat short answers as noise', async () => {
  const port = new FakePort();
  const controller = new DialogueController(port, preferences, () => {});
  for (const text of ['停一下。', 'stop', 'no, wait', '那个……我想一下。', '谢谢，先这样。', '我在跟别人说话，不用回答。']) {
    const result = await controller.submit({ text, source: 'text' }); assert.ok(result.local, text);
  }
  assert.equal(port.requests.length, 0);
  const ctx = { outputPlaying: true, expectsReply: false };
  assert.equal(localDecision('嗯。', ctx), 'RESUME');
  assert.equal(localDecision('嗯。', { ...ctx, expectsReply: true }), 'MODEL');
  assert.equal(localDecision('不要停，接着说。', ctx), 'RESUME');
  assert.equal(localDecision('不要停，接着说。', { ...ctx, outputPlaying: false }), 'MODEL');
  for (const text of ['はい', 'yes', 'no', '今天有点累。', '他说了 stop']) assert.equal(localDecision(text, ctx), 'MODEL', text);
  await controller.close();
});

test('voice projection contains only heard content, text projection includes acknowledged display', async () => {
  const port = new FakePort(); port.text = header('SPEAK', true) + '未播密码92817。继续吗？';
  const events: DialogueEvent[] = [];
  const controller = new DialogueController(port, preferences, event => events.push(event));
  await controller.submit({ text: '告诉我一个信息', source: 'voice' }); await settle();
  const attemptId = controller.ledger.snapshot()[0].attemptId;
  controller.displayed(attemptId, controller.ledger.snapshot()[0].generated.length);
  assert.equal(controller.expectsReply(), false);
  const projected = JSON.stringify(controller.projectHistory());
  assert.doesNotMatch(projected, /92817|继续吗/u);
  await controller.submit({ text: '接着呢', source: 'text' }); await settle();
  const last = controller.ledger.snapshot().at(-1)!;
  controller.displayed(last.attemptId, last.generated.length);
  assert.equal(controller.expectsReply(), true);
  assert.match(JSON.stringify(controller.projectHistory()), /92817/u);
  await controller.close();
});

test('WAIT and SILENT preserve a previously displayed pending question', async () => {
  const port = new FakePort(); port.text = header('SPEAK', true) + '继续吗？';
  const controller = new DialogueController(port, preferences, () => {});
  await controller.submit({ text: '问一个问题', source: 'text' }); await settle();
  controller.displayed(controller.ledger.snapshot()[0].attemptId, 4);
  assert.equal(controller.expectsReply(), true);
  for (const action of ['WAIT', 'SILENT']) {
    port.text = header(action);
    await controller.submit({ text: '普通含混句', source: 'text' }); await settle();
    assert.equal(controller.expectsReply(), true);
  }
  await controller.close();
});

test('model failure blocks repeated automatic account failures until an explicit retry', async () => {
  const port = new FakePort(); port.auto = false;
  const controller = new DialogueController(port, preferences, () => {});
  await controller.submit({ text: '你好', source: 'voice' });
  port.listener?.({ type: 'error', code: 'MISSING_CREDENTIAL' });
  port.finish?.({ sessionId: 'session-1', status: 'failed', code: 'MISSING_CREDENTIAL' }); await settle();
  assert.equal((await controller.submit({ text: '你在吗', source: 'voice' })).accepted, false);
  assert.equal(port.requests.length, 1);
  port.auto = true; port.text = header('SPEAK') + '我在。';
  await controller.retry(); await settle(); assert.equal(port.requests.length, 2);
  assert.equal((await controller.retry()).accepted, false);
  assert.equal(port.requests.length, 2);
  await controller.close();
});

test('failed partial text is marked interrupted in the next projected context', async () => {
  const port = new FakePort(); port.auto = false;
  const controller = new DialogueController(port, preferences, () => {});
  await controller.submit({ text: '解释一下', source: 'text' });
  port.listener?.({ type: 'text', attemptId: port.attempt, index: 0, revision: 2, text: header('SPEAK') + '部分答案' });
  controller.displayed(port.attempt, 4);
  port.listener?.({ type: 'error', code: 'PROVIDER_ERROR' });
  assert.match(JSON.stringify(controller.projectHistory()), /"interrupted":true/);
  await controller.close();
});

test('an accepted model turn remains in history if late ASR bookkeeping cannot reconcile', async () => {
  const port = new FakePort(); port.text = header('SPEAK') + '已收到。';
  const controller = new DialogueController(port, preferences, () => {});
  const receipt = await controller.submit({ text: '真实已接受的前半句', source: 'voice', onAccepted: () => { throw new Error('ASR gap cleared prefix'); } });
  await settle();
  assert.equal(receipt.accepted, true);
  assert.match(JSON.stringify(controller.projectHistory()), /真实已接受的前半句/u);
  assert.equal((await controller.retry()).accepted, false);
  await controller.close();
});

test('a final question with trailing newlines becomes pending only on display', async () => {
  const port = new FakePort(); port.text = header('SPEAK', true) + '要继续吗？\n\n';
  const controller = new DialogueController(port, preferences, () => {});
  await controller.submit({ text: '问我', source: 'text' }); await settle();
  const item = controller.ledger.snapshot()[0];
  controller.displayed(item.attemptId, item.generated.length);
  assert.equal(controller.expectsReply(), true);
  await controller.close();
});

test('interruption cancels native session and rejects late old text; next turn is serial', async () => {
  const port = new FakePort(); port.auto = false;
  const events: DialogueEvent[] = [];
  const controller = new DialogueController(port, preferences, event => events.push(event));
  await controller.submit({ text: '先解释', source: 'text' });
  const oldListener = port.listener!, oldAttempt = port.attempt;
  await controller.cancel();
  oldListener({ type: 'text', attemptId: oldAttempt, index: 0, revision: 2, text: header('SPEAK') + '旧内容' });
  assert.equal(events.some(event => event.type === 'assistant-delta'), false);
  port.auto = true; port.text = header('SPEAK') + '新回答';
  await controller.submit({ text: '新问题', source: 'text' }); await settle();
  assert.equal(port.requests.length, 2);
  assert.equal(port.cancelCalls, 1);
  await controller.close();
});
