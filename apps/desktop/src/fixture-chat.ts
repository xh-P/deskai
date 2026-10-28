import type { DialoguePort } from '../../../packages/voice-core/src/dialogue.ts';
import type { ChatAccepted, ChatEvent, ChatSettlement, ChatTurnInput } from '../../../packages/dsh-adapter/src/session.ts';

/** Used only when both explicit smoke and dialogue-smoke switches are present. */
export class FixtureChatPort implements DialoguePort {
  private number = 0;
  private active?: { finish: (value: ChatSettlement) => void; timer?: ReturnType<typeof setTimeout>; sessionId: string };
  private malformedCount = 0;
  readonly requests: { text: string; personaId: string | undefined; replyLanguage: string | undefined; pendingQuestion?: string }[] = [];

  async runTurn(input: ChatTurnInput, emit: (event: ChatEvent) => void): Promise<ChatAccepted> {
    if (this.active) throw new Error('FIXTURE_BUSY');
    const sessionId = `fixture-session-${++this.number}`, attemptId = `fixture-attempt-${this.number}`;
    const delivery = input.deliveryState as { pendingQuestion?: { status?: string } } | undefined;
    this.requests.push({ text: input.text, personaId: input.personaId, replyLanguage: input.replyLanguage, pendingQuestion: delivery?.pendingQuestion?.status });
    let finish!: (value: ChatSettlement) => void;
    const completed = new Promise<ChatSettlement>(resolve => { finish = resolve; });
    const active = { finish, sessionId, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.active = active;
    const header = (action: string, reason: string, expectsReply = false) => JSON.stringify({ v: 1, action, reason, expectsReply }) + '\n';
    let text = header('SPEAK', 'direct_request', true) + '已连接。这段回复只用于本地界面验证。要继续吗？';
    if (input.text === 'M2: wait') text = header('WAIT', 'unfinished');
    if (input.text === 'M2: silent') text = header('SILENT', 'closing');
    if (input.text === 'M2: short') text = header('SPEAK', 'answer_to_question') + '继续。';
    if (input.text === 'M2: malformed') text = ++this.malformedCount === 1 ? '缺少协议头的模拟输出' : header('SPEAK', 'direct_request') + '重试成功。';
    if (input.text === 'M2: long') text = header('SPEAK', 'direct_request') + '这是一段可取消的模拟回复。'.repeat(30);
    emit({ type: 'attempt-start', attemptId, revision: 1 });
    let offset = 0, index = 0;
    const step = () => {
      if (this.active !== active) return;
      const piece = text.slice(offset, offset + 9);
      emit({ type: 'text', attemptId, index, revision: index + 2, text: piece });
      offset += piece.length; index++;
      if (offset >= text.length) {
        emit({ type: 'attempt-end', attemptId, outcome: 'committed', eventType: 'assistant/message' });
        this.active = undefined;
        finish({ sessionId, status: 'completed' });
      } else active.timer = setTimeout(step, input.text === 'M2: long' ? 70 : 8);
    };
    active.timer = setTimeout(step, 20);
    return { accepted: true, sessionId, completed };
  }

  async cancel(): Promise<ChatSettlement | undefined> {
    const active = this.active;
    if (!active) return undefined;
    clearTimeout(active.timer);
    this.active = undefined;
    const settlement = { sessionId: active.sessionId, status: 'cancelled' as const };
    active.finish(settlement);
    return settlement;
  }
}
