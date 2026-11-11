import { randomUUID } from 'node:crypto';
import type { AppHost } from '../../../packages/app-core/src/index.ts';
import type { WorkHost } from '../../../packages/work-core/src/host.ts';
import { assertOperationId, operationSignature, type WorkOperationReceipt } from '../../../packages/work-core/src/operations.ts';
import type { WorkEffectCommand } from '../../../packages/work-core/src/types.ts';
import { parseCoordinationPlan, type CoordinationPlan, type ReferenceClarification, type ReferencePlan,
  type ReferenceSelection } from '../../../packages/voice-core/src/coordination.ts';
import { dialogueContext, planningContext, taskStatus } from './context.ts';
import { referenceCatalog, resolveReference, type ReferenceCandidate, type ReferenceCatalog } from './reference-catalog.ts';
import { parsePlannerRequests, type PlannerRequest } from '../../../packages/work-core/src/telemetry.ts';
import type { HostSelection, HostSnapshot } from './protocol.ts';

export type ControlTurn = { id: string; conversationId: string; text: string };
export type ControlReceipt = WorkOperationReceipt | ReferenceClarification | ReturnType<typeof taskStatus> | { kind: 'chat' } |
  { kind: 'reference-missing'; message: string } | { kind: 'application-receipt'; sessionId: string; action: string;
    receipt: Awaited<ReturnType<AppHost['invokeAction']>> };
export type ControlContext = { planning: ReturnType<typeof planningContext>; chat: ReturnType<typeof dialogueContext> };
type Choice = { card: ReferenceClarification; candidates: Map<string, ReferenceCandidate>; plan: ReferencePlan; signature: string;
  selected?: { optionId: string; receipt: Promise<ControlReceipt> } };
type FrozenTurn = { turn: ControlTurn; beganAt: number; expiresAt: number; catalog: ReferenceCatalog; context: ControlContext;
  requests?: PlannerRequest[]; decision?: { signature: string; receipt: Promise<ControlReceipt> }; choice?: Choice };

const referenceLifetimeMs = 5 * 60_000;

/** The Host resolves one whole-turn proposal against the catalog shown to the planner. */
export class ConversationControl {
  private readonly work: WorkHost;
  private readonly apps: AppHost;
  private readonly read: () => { snapshot: HostSnapshot; focus: HostSelection };
  private readonly selected: (receipt: WorkOperationReceipt) => void;
  private readonly turns = new Map<string, FrozenTurn>();
  private readonly pending = new Map<string, string>();

  constructor(work: WorkHost, apps: AppHost, read: () => { snapshot: HostSnapshot; focus: HostSelection }, selected: (receipt: WorkOperationReceipt) => void) {
    this.work = work; this.apps = apps; this.read = read; this.selected = selected;
  }

  private prune() {
    const now = Date.now();
    for (const [id, entry] of this.turns) if (entry.expiresAt <= now) {
      this.turns.delete(id);
      this.dismiss(entry.turn.conversationId, id);
    }
  }

  begin(turn: ControlTurn): ControlContext {
    this.prune();
    assertOperationId(turn?.id); assertOperationId(turn.conversationId);
    if (typeof turn.text !== 'string' || !turn.text.trim() || turn.text.length > 4000) throw new Error('COORDINATION_INPUT_INVALID');
    const existing = this.turns.get(turn.id);
    if (existing) { this.assertSameTurn(existing, turn); return existing.context; }
    const { snapshot, focus } = this.read();
    const catalog = referenceCatalog(snapshot, focus, turn.conversationId, turn.text);
    const pendingId = this.pending.get(turn.conversationId);
    const context = { planning: planningContext(snapshot, catalog, pendingId ? this.turns.get(pendingId)?.choice?.card : undefined),
      chat: dialogueContext(snapshot, { kind: 'chat' }) };
    const beganAt = Date.now();
    this.turns.set(turn.id, { turn: { ...turn }, beganAt, expiresAt: beganAt + referenceLifetimeMs, catalog, context });
    return context;
  }

  private assertSameTurn(entry: FrozenTurn, turn: ControlTurn) {
    if (entry.turn.conversationId !== turn.conversationId || entry.turn.text !== turn.text) throw new Error('COORDINATION_TURN_CONFLICT');
  }

  async execute(turn: ControlTurn, proposal: CoordinationPlan, requests?: PlannerRequest[]): Promise<ControlReceipt> {
    assertOperationId(turn?.id); assertOperationId(turn.conversationId);
    const plan = parseCoordinationPlan(JSON.stringify(proposal));
    const signature = operationSignature({ source: 'conversation', turn, plan });
    const durable = this.work.receipt(turn.id, signature);
    if (durable) return durable;
    this.prune();
    const entry = this.turns.get(turn.id);
    if (!entry) throw new Error('COORDINATION_TURN_EXPIRED');
    this.assertSameTurn(entry, turn);
    if (entry.decision) {
      if (entry.decision.signature !== signature) throw new Error('COORDINATION_TURN_CONFLICT');
      if (entry.choice?.selected) return entry.choice.selected.receipt;
      if (entry.choice && this.pending.get(turn.conversationId) !== turn.id)
        return { kind: 'reference-missing', message: '这次选择已结束，请重新说出要操作的对象。' };
      return entry.decision.receipt;
    }
    entry.requests = parsePlannerRequests(requests);
    const receipt = this.applyProposal(entry, plan, signature);
    entry.decision = { signature, receipt };
    return receipt;
  }

  private async applyProposal(entry: FrozenTurn, plan: CoordinationPlan, signature: string): Promise<ControlReceipt> {
    if (plan.intent === 'chat') return { kind: 'chat' };
    if (plan.intent === 'choose') return this.choose(entry.turn.conversationId, plan, entry.requests);
    const result = resolveReference(entry.catalog, plan, entry.turn.text);
    if (result.kind === 'missing') return { kind: 'reference-missing', message: '没有定位到对象。请说出项目、任务或应用的名称。' };
    if (result.kind === 'choose') {
      const candidates = new Map<string, ReferenceCandidate>();
      const options = result.targets.map(target => {
        const id = randomUUID(); candidates.set(id, target);
        return { id, kind: target.kind, label: target.label, parentLabel: target.parentLabel,
          detail: target.detail ?? (target.goal !== target.label ? target.goal : undefined), execution: target.execution };
      });
      const card: ReferenceClarification = { kind: 'reference-clarification', id: entry.turn.id, options,
        message: '请选一下你指的对象。' };
      entry.choice = { card, candidates, plan, signature };
      this.pending.set(entry.turn.conversationId, entry.turn.id);
      return card;
    }
    return this.apply(entry, plan, signature, result.kind === 'selected' ? result.target : undefined);
  }

  async choose(conversationId: string, selection: ReferenceSelection, requests: PlannerRequest[] = []): Promise<ControlReceipt> {
    assertOperationId(conversationId); assertOperationId(selection?.clarificationId); assertOperationId(selection.optionId);
    const original = this.work.operation(selection.clarificationId);
    if (original) {
      if (original.conversationId !== conversationId || original.optionId !== selection.optionId) throw new Error('COORDINATION_SELECTION_CONFLICT');
      return this.work.receipt(original.id)!;
    }
    this.prune();
    const entry = this.turns.get(selection.clarificationId);
    if (!entry?.choice || entry.turn.conversationId !== conversationId) throw new Error('COORDINATION_SELECTION_EXPIRED');
    const choice = entry.choice;
    if (choice.selected) {
      if (choice.selected.optionId !== selection.optionId) throw new Error('COORDINATION_SELECTION_CONFLICT');
      return choice.selected.receipt;
    }
    if (this.pending.get(conversationId) !== entry.turn.id) throw new Error('COORDINATION_SELECTION_EXPIRED');
    const target = choice.candidates.get(selection.optionId);
    if (!target) throw new Error('COORDINATION_OPTION_INVALID');
    this.pending.delete(conversationId);
    entry.requests = [...entry.requests ?? [], ...requests];
    const receipt = this.apply(entry, choice.plan, choice.signature, target, selection.optionId);
    choice.selected = { optionId: selection.optionId, receipt };
    return receipt;
  }

  dismiss(conversationId: string, clarificationId: string) {
    if (this.pending.get(conversationId) === clarificationId) this.pending.delete(conversationId);
  }

  private async apply(entry: FrozenTurn, plan: ReferencePlan, signature: string, target?: ReferenceCandidate, optionId?: string): Promise<ControlReceipt> {
    if (plan.intent === 'status') return taskStatus(this.read().snapshot, target?.kind === 'project' ? { projectId: target.id } : { taskId: target?.id });
    if (!target) throw new Error('COORDINATION_REFERENCE_REQUIRED');
    if (plan.intent === 'app') {
      const receipt = await this.apps.invokeAction(target.id, plan.action!, plan.payload ?? {}, target.appVersion!);
      return { kind: 'application-receipt', sessionId: target.id, action: plan.action!, receipt };
    }
    const { turn } = entry;
    const taskId = target.taskId ?? target.id;
    let command: WorkEffectCommand;
    switch (plan.intent) {
      case 'submit': command = { type: 'submit', projectId: target.id, prompt: turn.text, title: plan.title,
        authoring: plan.authoring, expectedArtifacts: plan.expectedArtifacts }; break;
      case 'resume': command = { type: 'continue', taskId, prompt: turn.text }; break;
      case 'append': {
        const task = this.work.snapshot().tasks.find(item => item.id === taskId);
        const live = task && ['queued', 'running', 'waiting'].includes(task.status);
        command = { type: live ? 'append' : 'continue', taskId, prompt: turn.text }; break;
      }
      case 'retry': case 'cancel': command = { type: plan.intent, taskId }; break;
      case 'reply': command = { type: 'reply', taskId, requestId: target.requestId!, response: plan.response }; break;
    }
    const receipt = await this.work.dispatch(command, { id: turn.id, expectedAttemptId: target.attemptId,
      origin: { signature, conversationId: turn.conversationId, optionId,
        delegation: { at: entry.beganAt, text: turn.text, target: target.label, requests: entry.requests ?? [] } } });
    this.selected(receipt);
    return receipt;
  }
}
