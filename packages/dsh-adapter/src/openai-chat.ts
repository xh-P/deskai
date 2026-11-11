import { randomUUID } from 'node:crypto';
import { buildSystemPrompt } from '../../voice-core/src/prompts.ts';
import { readBundledPersona } from '../../voice-core/src/persona-files.ts';
import { buildChatContent, type ChatAccepted, type ChatEvent, type ChatSettlement, type ChatTurnInput } from './session.ts';

export type OpenAIChatConfig = { baseUrl: string; model: string; apiKey?: string; timeoutMs?: number };
type ActiveTurn = { controller: AbortController; completed: Promise<ChatSettlement>; finish: (settlement: ChatSettlement) => void; sessionId: string; settled: boolean };

/** Direct streaming Chat Completions provider; credentials never enter the renderer or prompt. */
export class OpenAICompatibleChat {
  private active?: ActiveTurn;
  private readonly root: string;
  private readonly config: OpenAIChatConfig;

  constructor(root: string, config: OpenAIChatConfig) { this.root = root; this.config = config; }

  async runTurn(input: ChatTurnInput, onEvent: (event: ChatEvent) => void): Promise<ChatAccepted> {
    if (this.active) throw new Error('CHAT_TURN_BUSY');
    const content = buildChatContent(input);
    const card = input.persona ?? await readBundledPersona(this.root, input.personaId);
    const system = buildSystemPrompt(card, [], input.relationshipMode).text;
    const sessionId = randomUUID();
    const attemptId = randomUUID();
    let finish!: (settlement: ChatSettlement) => void;
    const completed = new Promise<ChatSettlement>(resolve => { finish = resolve; });
    const active: ActiveTurn = { controller: new AbortController(), completed, finish, sessionId, settled: false };
    this.active = active;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; active.controller.abort(); }, this.config.timeoutMs ?? 180_000);
    const settle = (status: ChatSettlement['status'], code?: string) => {
      if (active.settled) return;
      active.settled = true;
      clearTimeout(timeout);
      if (this.active === active) this.active = undefined;
      finish({ sessionId, status, ...(code ? { code } : {}) });
    };
    const emit = (event: ChatEvent) => { try { onEvent(event); } catch { /* The UI cannot strand provider settlement. */ } };
    let response: Response;
    try {
      response = await fetch(new URL('chat/completions', this.config.baseUrl.endsWith('/') ? this.config.baseUrl : `${this.config.baseUrl}/`), {
        method: 'POST', signal: active.controller.signal,
        headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.config.model, stream: true,
          messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
      });
      if (!response.ok || !response.body) throw new Error(`CHAT_HTTP_${response.status}`);
    } catch (error) {
      const code = timedOut ? 'CHAT_TIMEOUT' : active.controller.signal.aborted ? 'CHAT_CANCELLED' : error instanceof Error ? error.message : 'CHAT_TRANSPORT_ERROR';
      settle(active.controller.signal.aborted && !timedOut ? 'cancelled' : 'failed', code);
      throw new Error(code);
    }
    emit({ type: 'attempt-start', attemptId, revision: 0 });
    void this.consume(response.body, active.controller.signal, attemptId, emit).then(() => {
      emit({ type: 'attempt-end', attemptId, outcome: 'committed' });
      settle('completed');
    }).catch(error => {
      if (active.controller.signal.aborted) {
        emit({ type: 'attempt-end', attemptId, outcome: 'abandoned' });
        if (timedOut) { emit({ type: 'error', code: 'CHAT_TIMEOUT' }); settle('failed', 'CHAT_TIMEOUT'); }
        else settle('cancelled');
        return;
      }
      const code = error instanceof Error ? error.message : 'CHAT_STREAM_ERROR';
      emit({ type: 'error', code });
      emit({ type: 'attempt-end', attemptId, outcome: 'abandoned' });
      settle('failed', code);
    });
    return { accepted: true, sessionId, completed };
  }

  private async consume(stream: ReadableStream<Uint8Array>, signal: AbortSignal, attemptId: string, emit: (event: ChatEvent) => void): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let index = 0;
    let characters = 0;
    let done = false;
    const consumeEvent = (block: string) => {
      const payload = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!payload) return;
      if (payload === '[DONE]') { done = true; return; }
      let value: { error?: unknown; choices?: { delta?: { content?: unknown } }[]; usage?: unknown };
      try { value = JSON.parse(payload); } catch { throw new Error('CHAT_STREAM_FORMAT'); }
      if (value.error) throw new Error('CHAT_PROVIDER_ERROR');
      if (value.usage) emit({ type: 'usage', usage: value.usage });
      const text = value.choices?.[0]?.delta?.content;
      if (typeof text !== 'string' || !text) return;
      characters += [...text].length;
      if (characters > 12000) throw new Error('CHAT_OUTPUT_LENGTH');
      emit({ type: 'text', attemptId, index: index++, revision: 0, text });
    };
    try {
      while (!done) {
        if (signal.aborted) throw new Error('CHAT_CANCELLED');
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        if (buffer.length > 1_000_000) throw new Error('CHAT_STREAM_LENGTH');
        let boundary = /\r?\n\r?\n/u.exec(buffer);
        while (boundary) {
          consumeEvent(buffer.slice(0, boundary.index).replace(/\r\n/g, '\n'));
          buffer = buffer.slice(boundary.index + boundary[0].length);
          if (done) break;
          boundary = /\r?\n\r?\n/u.exec(buffer);
        }
      }
      if (!done) {
        buffer += decoder.decode();
        if (buffer.trim()) consumeEvent(buffer.replace(/\r\n/g, '\n'));
      }
      if (!done) throw new Error('CHAT_STREAM_INCOMPLETE');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  async cancel(): Promise<ChatSettlement | undefined> {
    const active = this.active;
    if (!active) return undefined;
    active.controller.abort();
    return active.completed;
  }
}
