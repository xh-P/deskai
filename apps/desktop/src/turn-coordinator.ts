import { randomUUID } from 'node:crypto';
import type { DialogueController, DialogueInput } from '../../../packages/voice-core/src/dialogue.ts';
import type { ReferenceSelection } from '../../../packages/voice-core/src/coordination.ts';
import type { HostClient } from '../../host/src/client.ts';
import { dialogueContext } from '../../host/src/context.ts';
import type { ControlContext, ControlReceipt } from '../../host/src/conversation-control.ts';
import type { WorkPlanner } from './work-planner.ts';
import type { PlannerRequest } from '../../../packages/work-core/src/telemetry.ts';

type Session = {
  sessionId: string;
  conversationId: string;
  dialogue: Pick<DialogueController, 'submit' | 'discardSpeculative'>;
  planner?: Pick<WorkPlanner, 'plan' | 'cancel'>;
};
type CoordinationEvent =
  | { type: 'coordination-state'; state: 'planning' | 'idle' }
  | { type: 'reference-card'; sessionId: string; card: Extract<ControlReceipt, { kind: 'reference-clarification' }> }
  | { type: 'reference-closed'; sessionId: string; clarificationId: string }
  | { type: 'error'; code: 'COORDINATION_FAILED'; message: string };
type Options = {
  current: () => Session | undefined;
  ready: () => Promise<unknown>;
  host: () => Promise<Pick<HostClient, 'command' | 'snapshot'>>;
  requireChat?: boolean;
  emit: (event: CoordinationEvent) => void;
  announce: (receipt: ControlReceipt) => void;
  onIdle: () => void;
};

/** Coordinate one input with its dialogue owner and the Host's effect boundary. */
export class DesktopTurnCoordinator {
  private pending?: { session: Session; canceled: boolean };
  private readonly options: Options;

  constructor(options: Options) { this.options = options; }
  get busy() { return !!this.pending; }

  async cancel(): Promise<void> {
    if (!this.pending) return;
    this.pending.canceled = true;
    await this.pending.session.planner?.cancel();
  }

  private isCurrent(session: Session): boolean {
    const live = this.options.current();
    return live?.sessionId === session.sessionId && live.conversationId === session.conversationId &&
      live.dialogue === session.dialogue;
  }

  async submit(input: DialogueInput, inputId?: string): Promise<{ accepted: boolean }> {
    const session = this.options.current();
    await this.options.ready();
    if (!session || !this.isCurrent(session) || input.isEligible?.() === false) return { accepted: false };
    if (this.pending) throw new Error('COORDINATOR_BUSY');
    const pending = this.pending = { session, canceled: false };
    const { dialogue, planner, sessionId, conversationId } = session;
    const current = () => !pending.canceled && this.isCurrent(session);
    const eligible = () => current() && input.isEligible?.() !== false;
    let committed = false;
    try {
      if (!input.speculation) dialogue.discardSpeculative();
      if (planner) this.options.emit({ type: 'coordination-state', state: 'planning' });
      const host = await this.options.host();
      if (!eligible()) return { accepted: false };
      if (!planner) {
        const snapshot = await host.snapshot();
        return eligible() ? await dialogue.submit({ ...input, hostContext: dialogueContext(snapshot, { kind: 'chat' }) }) : { accepted: false };
      }
      const turn = {
        id: inputId ?? (input.speculation ? `${sessionId}_${input.speculation.inputRevision}` : randomUUID()),
        conversationId, text: input.text,
      };
      const context = await host.command<ControlContext>({ type: 'plan-context', turn });
      if (!eligible()) return { accepted: false };
      const requests: PlannerRequest[] = [];
      const decision = await planner.plan(input.text, context.planning, request => requests.push(request));
      if (!eligible()) return { accepted: false };
      if (this.options.requireChat && decision.intent !== 'chat') throw new Error('VOICE_SMOKE_EXPECTED_CHAT');
      if (decision.intent !== 'chat') dialogue.discardSpeculative(input.speculation);
      const facts = decision.intent === 'chat' ? { kind: 'chat' as const }
        : await host.command<ControlReceipt>({ type: 'plan', turn, plan: decision, requests });
      committed = decision.intent !== 'chat';
      if (committed) input.onAccepted?.();
      if (!current()) return { accepted: committed };
      if (facts.kind === 'reference-clarification') this.options.emit({ type: 'reference-card', sessionId, card: facts });
      else if (decision.intent === 'choose') this.closeReference(sessionId, decision.clarificationId);
      const result = await dialogue.submit({
        ...input,
        ...(committed ? { onAccepted: undefined, isEligible: undefined, requiresReply: true, characterKnowledge: false } : {}),
        hostContext: committed ? { ...context.chat, receipt: facts } : context.chat,
      });
      if (committed && !result.accepted && current()) this.options.announce(facts);
      return { accepted: committed || result.accepted };
    } catch (error) {
      if (current()) this.options.emit({ type: 'error', code: 'COORDINATION_FAILED',
        message: '任务协调失败：' + (error instanceof Error ? error.message : String(error)) });
      return { accepted: committed };
    } finally {
      if (input.speculation) dialogue.discardSpeculative(input.speculation);
      this.pending = undefined;
      if (planner) this.options.emit({ type: 'coordination-state', state: 'idle' });
      this.options.onIdle();
    }
  }

  async selectReference(selection: ReferenceSelection): Promise<ControlReceipt> {
    const session = this.options.current();
    if (!session) throw new Error('COORDINATION_SESSION_UNAVAILABLE');
    const host = await this.options.host();
    if (!this.isCurrent(session)) throw new Error('COORDINATION_SESSION_UNAVAILABLE');
    const receipt = await host.command<ControlReceipt>({ type: 'reference-select', conversationId: session.conversationId, selection });
    if (this.isCurrent(session)) {
      this.closeReference(session.sessionId, selection.clarificationId);
      this.options.announce(receipt);
    }
    return receipt;
  }

  async dismissReference(clarificationId: string): Promise<void> {
    const session = this.options.current();
    if (!session) return;
    const host = await this.options.host();
    if (!this.isCurrent(session)) return;
    await host.command({ type: 'reference-dismiss', conversationId: session.conversationId, clarificationId });
    if (this.isCurrent(session)) this.closeReference(session.sessionId, clarificationId);
  }

  private closeReference(sessionId: string, clarificationId: string): void {
    this.options.emit({ type: 'reference-closed', sessionId, clarificationId });
  }
}
