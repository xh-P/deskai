import { randomUUID } from 'node:crypto';
import { boundedText, revision, type ControllerStatus, type JsonObject, type Manifest, type Takeover } from './auip-contract.ts';

export interface ControllerLease {
  lease_id: string;
  principal: 'kurisu';
  executor: 'app_controller';
  generation: number;
  policy_revision: number;
  issued_at_ms: number;
  expires_at_ms: number;
  max_action_rate_hz: number;
  takeover: Takeover;
}
export type ControllerSnapshot = { status: ControllerStatus; reason?: string; lease?: ControllerLease };

/** A policy is provisional until the corresponding application action receipt is accepted. */
export class Controller {
  private readonly policy: NonNullable<Manifest['controller']>;
  private readonly changed: () => void;
  private generation = 0;
  private status: ControllerStatus = 'idle';
  private reason?: string;
  private lease?: ControllerLease;
  private ended?: ControllerLease;
  private timer?: NodeJS.Timeout;
  private revoking = false;

  constructor(policy: NonNullable<Manifest['controller']>, changed: () => void) { this.policy = policy; this.changed = changed; }

  snapshot(): ControllerSnapshot { return { status: this.status, reason: this.reason, lease: this.lease }; }

  propose(action: string): ControllerLease | undefined {
    if (!this.policy.policyActions.includes(action)) return undefined;
    if (this.revoking) throw new Error('controller_revocation_pending');
    const generation = ++this.generation;
    const now = Date.now();
    return { lease_id: `controller_${randomUUID()}`, principal: 'kurisu', executor: 'app_controller', generation,
      policy_revision: generation, issued_at_ms: now, expires_at_ms: now + this.policy.leaseDurationMs,
      max_action_rate_hz: this.policy.maxActionRateHz, takeover: this.policy.takeover };
  }

  activate(lease: ControllerLease) {
    if (lease.expires_at_ms <= Date.now()) throw new Error('controller_lease_expired');
    clearTimeout(this.timer);
    this.lease = lease; this.revoking = false; this.status = 'active'; this.reason = undefined;
    this.timer = setTimeout(() => { this.reset('expired'); this.changed(); }, lease.expires_at_ms - Date.now());
    this.timer.unref();
  }

  revoke(reason: string) {
    if (!this.lease || this.revoking) return undefined;
    this.revoking = true; this.status = 'stopping'; this.reason = reason;
    return { ...this.lease, reason, requested_at_ms: Date.now() };
  }

  report(params: JsonObject) {
    const { status } = params;
    if (status !== 'active' && status !== 'stopping' && status !== 'blocked' && status !== 'idle') throw new Error('invalid_controller_status');
    const id = boundedText(params.lease_id, 120, 'invalid_controller_lease');
    const generation = revision(params.generation);
    if (status === 'idle' && this.ended?.lease_id === id && this.ended.generation === generation) return;
    if (this.lease?.lease_id !== id || this.lease.generation !== generation) throw new Error('stale_controller_lease');
    if (status === 'active' && this.revoking || status === 'stopping' && !this.revoking) throw new Error('controller_status_conflict');
    const reason = typeof params.reason === 'string' ? params.reason.slice(0, 160) : undefined;
    if (status === 'idle' || status === 'blocked') {
      this.reset(reason); this.status = status;
    } else { this.status = status; this.reason = reason; }
  }

  reset(reason?: string) {
    clearTimeout(this.timer);
    this.ended = this.lease ?? this.ended;
    this.lease = undefined; this.revoking = false; this.status = 'idle'; this.reason = reason;
  }
}
