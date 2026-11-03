import type { SpeechMode } from './speech-runtime.ts';

/** A generation identifies the mode that owned an in-flight ASR request. */
export class WakeGate {
  private activeUntil = 0;
  private generation = 0;
  private readonly phrases: string[];
  private readonly idleTimeoutMs: number;
  constructor(phrases: string[], idleTimeoutMs = 180_000) {
    this.idleTimeoutMs = idleTimeoutMs;
    this.phrases = phrases.map(p => p.trim().toLocaleLowerCase()).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!this.phrases.length || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) throw new Error('INVALID_WAKE_CONFIG');
  }
  snapshot(now: number): { mode: SpeechMode; generation: number } {
    if (this.activeUntil && now >= this.activeUntil) { this.activeUntil = 0; this.generation++; }
    return { mode: this.activeUntil ? 'conversation' : 'wake', generation: this.generation };
  }
  touch(now: number): void { if (this.snapshot(now).mode === 'conversation') this.activeUntil = now + this.idleTimeoutMs; }
  reset(): void { this.activeUntil = 0; this.generation++; }
  accept(text: string, route: { mode: SpeechMode; generation: number }, now: number): { accepted: boolean; text: string; woke: boolean } {
    const current = this.snapshot(now);
    if (route.generation !== current.generation || route.mode !== current.mode) return { accepted: false, text: '', woke: false };
    if (current.mode === 'conversation') { this.touch(now); return { accepted: !!text.trim(), text: text.trim(), woke: false }; }
    const lower = text.toLocaleLowerCase();
    const match = this.phrases.map(phrase => ({ phrase, index: lower.indexOf(phrase) })).filter(item => item.index >= 0).sort((a, b) => a.index - b.index || b.phrase.length - a.phrase.length)[0];
    if (!match) return { accepted: false, text: '', woke: false };
    const rest = text.slice(match.index + match.phrase.length).replace(/^[\s\p{P}\p{S}]+/u, '').trim();
    this.activeUntil = now + this.idleTimeoutMs;
    this.generation++;
    return { accepted: !!rest, text: rest, woke: true };
  }
}
