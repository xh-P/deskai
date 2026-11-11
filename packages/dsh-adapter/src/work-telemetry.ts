import { assistantStreamFirstTokenTime, joinAssistantStreamText, lastAssistantStreamChunk,
  type AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream';
import { asRecord, parseModelTelemetry, parseUsage, type ModelTelemetry, type NativeTrace } from '../../work-core/src/telemetry.ts';
import type { DshActiveStream, DshEvent } from './session-feed.ts';

type Step = {
  turn: number; step: number; retry: number; at: number; first?: number; text: string;
  usage?: ModelTelemetry['usage'];
  streamId?: string; index: number;
};
type TraceSink = (entry: NativeTrace, sourceSeq?: number) => void;
const boundedText = (value: string) => value.slice(0, 4000);

function messageText(value: unknown): string {
  const message = asRecord(value);
  return Array.isArray(message?.content) ? boundedText(message.content.map(block => {
    const data = asRecord(block);
    return data?.type === 'text' && typeof data.text === 'string' ? data.text : '';
  }).filter(Boolean).join('\n')) : '';
}

function isToken(value: unknown): boolean {
  const chunk = asRecord(value);
  return chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta' || chunk?.type === 'tool-call-delta';
}

/** The dsh log owns completed requests. Live chunks update the same row until its durable event arrives. */
export class DshWorkTelemetry {
  private readonly emit: TraceSink;
  private route: ModelTelemetry = {};
  private current?: Step;
  private timer?: ReturnType<typeof setTimeout>;
  private tools = new Map<string, { at: number; title: string }>();

  constructor(emit: TraceSink) { this.emit = emit; }

  seed(events: readonly DshEvent[]): void {
    for (const event of events) if (event.type === 'request/header') this.header(event.data);
  }

  restore(opening: DshActiveStream): void {
    const step = this.current;
    if (!step || opening.turn !== step.turn || opening.step !== step.step) return;
    this.stopTimer();
    step.streamId = opening.attemptId;
    step.index = opening.nextIndex - 1;
    const stream = opening.stream as AssistantStreamRecord[];
    step.text = boundedText(joinAssistantStreamText(stream));
    step.first = assistantStreamFirstTokenTime(stream);
    step.usage = parseUsage(lastAssistantStreamChunk(stream, 'usage')?.usage);
    this.emit(this.modelRow(step));
  }

  private header(data: unknown): void {
    const config = asRecord(asRecord(asRecord(data)?.header)?.config);
    if (config) this.route = parseModelTelemetry(config);
  }

  event(event: DshEvent, owned: boolean): void {
    const { data = {}, seq } = event;
    const at = event.time ?? Date.now();
    if (event.type === 'request/header') this.header(data);
    if (event.type === 'step/start' && typeof data.turn === 'number' && typeof data.step === 'number') {
      this.stopTimer();
      this.current = { turn: data.turn, step: data.step, retry: 0, at, text: '', index: -1 };
    }
    if (!owned) return;
    if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && typeof data.turn === 'number' && typeof data.step === 'number') {
      this.stopTimer();
      const current = this.current;
      const step = current?.turn === data.turn && current.step === data.step ? current :
        { turn: data.turn, step: data.step, retry: 0, at, text: '', index: -1 };
      const stream = Array.isArray(data.stream) ? data.stream as AssistantStreamRecord[] : [];
      const completed = event.type === 'assistant/message';
      const usage = parseUsage(data.usage ?? lastAssistantStreamChunk(stream, 'usage')?.usage);
      const first = step.first ?? assistantStreamFirstTokenTime(stream);
      const text = completed ? messageText(data.message) : boundedText(joinAssistantStreamText(stream));
      const state = completed ? 'completed' : lastAssistantStreamChunk(stream, 'finish')?.reason.kind === 'error' ? 'failed' : 'interrupted';
      this.emit(this.modelRow({ ...step, text, usage, first }, at, state), seq);
      this.current = completed ? undefined : { ...step, streamId: undefined };
    } else if (event.type === 'step/end' && this.current?.streamId &&
        this.current.turn === data.turn && this.current.step === data.step) {
      this.stopTimer();
      this.emit(this.modelRow(this.current, at, 'interrupted'), seq);
      this.current = undefined;
    } else if (event.type === 'llm/retry') {
      this.emit({ key: `retry-${seq}`, at, kind: 'connection', title: '模型请求等待重试', state: 'waiting' }, seq);
    } else if (event.type === 'llm/retry-started' && typeof data.turn === 'number' && typeof data.step === 'number' && typeof data.retry === 'number') {
      this.current = { turn: data.turn, step: data.step, retry: data.retry, at, text: '', index: -1 };
    } else if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
      const title = data.name.slice(0, 160);
      this.tools.set(data.callId, { at, title });
      this.emit({ key: `tool-${data.callId}`, at, kind: 'tool', title, state: 'running', callId: data.callId }, seq);
    } else if (event.type === 'tool/result') {
      const message = asRecord(data.message);
      const callId = message?.toolCallId;
      if (typeof callId !== 'string') return;
      const start = this.tools.get(callId);
      this.tools.delete(callId);
      const error = asRecord(data.error);
      const code = typeof error?.code === 'string' ? error.code : undefined;
      const text = [code, messageText(message)].filter(Boolean).join('\n');
      this.emit({ key: `tool-${callId}`, at: start?.at ?? at, kind: 'tool', title: start?.title ?? '工具结果',
        text, state: error || message?.isError === true ? 'failed' : 'completed',
        elapsedMs: start ? Math.max(0, at - start.at) : undefined, callId }, seq);
    }
  }

  assistant(frame: Record<string, unknown>): void {
    const step = this.current;
    if (!step || typeof frame.attemptId !== 'string') return;
    if (frame.type === 'start' && frame.turn === step.turn && frame.step === step.step) {
      step.streamId = frame.attemptId; step.index = -1; step.text = ''; step.usage = undefined; step.first = undefined;
      this.emit(this.modelRow(step));
      return;
    }
    if (step.streamId !== frame.attemptId || frame.type !== 'chunk' || typeof frame.index !== 'number' || frame.index <= step.index) return;
    step.index = frame.index;
    if (!this.collect(step, asRecord(frame.chunk), frame.time)) return;
    this.timer ??= setTimeout(() => { this.timer = undefined; if (this.current === step) this.emit(this.modelRow(step)); }, 120);
  }

  private collect(step: Step, chunk: Record<string, unknown> | undefined, time: unknown): boolean {
    if (isToken(chunk) && typeof time === 'number') step.first ??= time;
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') step.text = boundedText(step.text + chunk.text);
    else if (chunk?.type === 'usage') step.usage = parseUsage(chunk.usage);
    else return false;
    return true;
  }

  private modelRow(step: Step, finishedAt?: number, state: NativeTrace['state'] = 'running'): NativeTrace {
    return { key: `model-${step.turn}-${step.step}${step.retry ? `-retry-${step.retry}` : ''}`, at: step.at, kind: 'model',
      title: step.retry ? '模型重试' : '模型请求', state,
      text: step.text, turn: step.turn, step: step.step,
      metrics: { ...this.route, usage: step.usage,
        elapsedMs: finishedAt === undefined ? undefined : Math.max(0, finishedAt - step.at),
        firstTokenMs: step.first === undefined ? undefined : Math.max(0, step.first - step.at) } };
  }

  private stopTimer(): void { clearTimeout(this.timer); this.timer = undefined; }
  close(): void { this.stopTimer(); }
}
