import type { ChatAccepted, ChatEvent, ChatTurnInput, DialoguePort } from './chat-contract.ts';
import type { Ready } from './index.ts';

export type SpeculationIdentity = Pick<Ready, 'sessionId' | 'inputRevision'>;
export type SpeculationDiagnostic = SpeculationIdentity & {
  type: 'speculative-started' | 'speculative-confirmed' | 'speculative-discarded';
  durationMs: number;
};
type Slot = {
  identity: SpeculationIdentity;
  signature: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  accepted?: ChatAccepted;
  ready: Promise<void>;
  invalidated: Promise<void>;
  invalidate: () => void;
  events: ChatEvent[];
  deliver?: (event: ChatEvent) => void;
};

const same = (left: SpeculationIdentity, right: SpeculationIdentity) =>
  left.sessionId === right.sessionId && left.inputRevision === right.inputRevision;

/** One cancellable provider request. Its events reach Dialogue only after claim. */
export class SpeculativeChat {
  private slot?: Slot;
  private draining?: Promise<unknown>;
  private readonly port: DialoguePort;
  private readonly maxAgeMs: number;
  private readonly diagnostic?: (event: SpeculationDiagnostic) => void;

  constructor(port: DialoguePort, maxAgeMs: number, diagnostic?: (event: SpeculationDiagnostic) => void) {
    this.port = port;
    this.maxAgeMs = maxAgeMs;
    this.diagnostic = diagnostic;
  }

  prepare(identity: SpeculationIdentity, request: ChatTurnInput): boolean {
    if (this.slot || this.draining) return false;
    let invalidate!: () => void;
    const invalidated = new Promise<void>(resolve => { invalidate = resolve; });
    const timer = setTimeout(() => this.discard(identity), this.maxAgeMs);
    timer.unref?.();
    const slot: Slot = { identity, signature: JSON.stringify(request), startedAt: performance.now(), timer,
      ready: Promise.resolve(), invalidated, invalidate, events: [] };
    this.slot = slot;
    slot.ready = Promise.resolve().then(async () => {
      if (this.slot !== slot) return;
      this.record('speculative-started', slot);
      const accepted = await this.port.runTurn(request, event => {
        if (slot.deliver) slot.deliver(event);
        else if (this.slot === slot) {
          if (event.type === 'error' || slot.events.length >= 12_000) this.discard(identity);
          else slot.events.push(event);
        }
      });
      if (this.slot === slot) slot.accepted = accepted;
      void accepted.completed.then(result => {
        if (result.status !== 'completed' && this.slot === slot) this.discard(identity);
      }, () => { if (this.slot === slot) this.discard(identity); });
    }).catch(() => { if (this.slot === slot) this.discard(identity); });
    return true;
  }

  wait(identity: SpeculationIdentity, request: ChatTurnInput): Promise<void> | undefined {
    const slot = this.match(identity, request);
    if (slot) return Promise.race([slot.ready, slot.invalidated]);
  }

  claim(identity: SpeculationIdentity, request: ChatTurnInput) {
    const slot = this.match(identity, request);
    if (!slot?.accepted) return;
    this.slot = undefined;
    clearTimeout(slot.timer);
    this.record('speculative-confirmed', slot);
    return {
      port: this.port,
      accepted: slot.accepted,
      release(deliver: (event: ChatEvent) => void) {
        slot.deliver = deliver;
        for (const event of slot.events) deliver(event);
        slot.events.length = 0;
      },
    };
  }

  discard(identity?: SpeculationIdentity): void {
    const slot = this.slot;
    if (!slot || identity && !same(slot.identity, identity)) return;
    this.slot = undefined;
    clearTimeout(slot.timer);
    slot.events.length = 0;
    slot.invalidate();
    this.record('speculative-discarded', slot);
    this.draining = this.port.cancel().catch(() => {}).finally(() => { this.draining = undefined; });
  }

  async close(): Promise<void> { this.discard(); await this.draining; }

  private match(identity: SpeculationIdentity, request: ChatTurnInput): Slot | undefined {
    const slot = this.slot;
    if (slot && performance.now() - slot.startedAt <= this.maxAgeMs &&
        same(slot.identity, identity) && slot.signature === JSON.stringify(request)) return slot;
  }

  private record(type: SpeculationDiagnostic['type'], slot: Slot): void {
    this.diagnostic?.({ type, sessionId: slot.identity.sessionId, inputRevision: slot.identity.inputRevision,
      durationMs: performance.now() - slot.startedAt });
  }
}
