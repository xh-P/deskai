import { LocalDshChat } from '../../../packages/dsh-adapter/src/session.ts';
import type { LocalDshSpeech } from '../../../packages/dsh-adapter/src/speech.ts';
import { COORDINATOR_PRESET, parseCoordinationPlan, type CoordinationPlan } from '../../../packages/voice-core/src/coordination.ts';
import type { ControlContext } from '../../host/src/conversation-control.ts';
import { DshWorkTelemetry } from '../../../packages/dsh-adapter/src/work-telemetry.ts';
import type { PlannerRequest } from '../../../packages/work-core/src/telemetry.ts';

/** A model decision is a proposal. The Host validates identities before effects. */
export class WorkPlanner {
  private readonly model: LocalDshChat;
  private recent: { user: string; intent: string }[] = [];
  constructor(host: LocalDshSpeech, root: string) {
    this.model = new LocalDshChat(host, root, { preset: COORDINATOR_PRESET, renderInput: input => input.text });
  }
  async plan(text: string, context: ControlContext['planning'], onRequest?: (request: PlannerRequest) => void): Promise<CoordinationPlan> {
    let output = '';
    let sessionId = '';
    const requests = new Map<string, PlannerRequest>();
    const telemetry = onRequest && new DshWorkTelemetry(entry => {
      if (entry.kind === 'model' && entry.metrics && entry.state !== 'running' && entry.state !== 'waiting')
        requests.set(entry.key, { at: entry.at, sessionId, metrics: entry.metrics, state: entry.state });
    });
    const turn = await this.model.runTurn({ text: JSON.stringify({ currentUserText: text, recent: this.recent, host: context }) }, event => {
      if (event.type === 'attempt-start') output = '';
      if (event.type === 'text') output += event.text;
    }, telemetry && ((id, event) => { sessionId = id; telemetry.event(event, true); }));
    const result = await turn.completed;
    if (result.status !== 'completed') throw new Error(result.code ?? 'COORDINATOR_CANCELLED');
    const plan = parseCoordinationPlan(output);
    if (onRequest) for (const request of requests.values()) onRequest(request);
    this.recent = [...this.recent, { user: text, intent: plan.intent }].slice(-6);
    return plan;
  }
  cancel() { return this.model.cancel(); }
}
