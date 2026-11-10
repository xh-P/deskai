import { LocalDshChat } from '../../../packages/dsh-adapter/src/session.ts';
import type { LocalDshSpeech } from '../../../packages/dsh-adapter/src/speech.ts';
import { COORDINATOR_PRESET, parseCoordinationPlan, type CoordinationPlan } from '../../../packages/voice-core/src/coordination.ts';

/** A model decision is a proposal. The Host validates identities before effects. */
export class WorkPlanner {
  private readonly model: LocalDshChat;
  private recent: { user: string; intent: string }[] = [];
  constructor(host: LocalDshSpeech, root: string) {
    this.model = new LocalDshChat(host, root, { preset: COORDINATOR_PRESET, renderInput: input => input.text });
  }
  async plan(text: string, context: unknown): Promise<CoordinationPlan> {
    let output = '';
    const turn = await this.model.runTurn({ text: JSON.stringify({ currentUserText: text, recent: this.recent, host: context }) }, event => {
      if (event.type === 'attempt-start') output = '';
      if (event.type === 'text') output += event.text;
    });
    const result = await turn.completed;
    if (result.status !== 'completed') throw new Error(result.code ?? 'COORDINATOR_CANCELLED');
    const plan = parseCoordinationPlan(output);
    this.recent = [...this.recent, { user: text, intent: plan.intent }].slice(-6);
    return plan;
  }
  cancel() { return this.model.cancel(); }
}
