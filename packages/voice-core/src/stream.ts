import { parseDecisionHeader, type DecisionHeader } from './decision.ts';
import { createHash } from 'node:crypto';

export type ProtocolEvent =
  | { type: 'header'; header: DecisionHeader }
  | { type: 'body'; text: string }
  | { type: 'violation'; reason: string }
  | { type: 'error'; reason: string };

/** Consumes only non-reasoning assistant text supplied by the adapter. */
export class DecisionStream {
  private line = '';
  private header?: DecisionHeader;
  private ended = false;
  private failed = false;
  private bodyLength = 0;
  private extraReported = false;
  private readonly maxBodyCharacters: number;

  constructor(maxBodyCharacters = 32768) {
    if (!Number.isSafeInteger(maxBodyCharacters) || maxBodyCharacters < 1 || maxBodyCharacters > 1_000_000) throw new RangeError('invalid body limit');
    this.maxBodyCharacters = maxBodyCharacters;
  }

  push(chunk: string): ProtocolEvent[] {
    if (this.ended || this.failed) return [];
    if (typeof chunk !== 'string') throw new TypeError('assistant text chunk required');
    if (!this.header) {
      const newline = chunk.indexOf('\n');
      if (newline < 0) {
        this.line += chunk;
        if (Buffer.byteLength(this.line, 'utf8') > 512) return this.fail('decision header exceeds 512 UTF-8 bytes');
        return [];
      }
      this.line += chunk.slice(0, newline);
      if (this.line.endsWith('\r')) this.line = this.line.slice(0, -1);
      try { this.header = parseDecisionHeader(this.line); }
      catch (error) { return this.fail(error instanceof Error ? error.message : 'invalid decision header'); }
      this.line = '';
      return [{ type: 'header', header: this.header }, ...this.acceptBody(chunk.slice(newline + 1))];
    }
    return this.acceptBody(chunk);
  }

  finish(): ProtocolEvent[] {
    if (this.ended) return [];
    this.ended = true;
    if (!this.header && !this.failed) return this.fail('missing complete decision header');
    return [];
  }

  private acceptBody(text: string): ProtocolEvent[] {
    if (!text) return [];
    if (this.header?.action !== 'SPEAK') {
      if (this.extraReported) return [];
      this.extraReported = true;
      return [{ type: 'violation', reason: 'WAIT/SILENT emitted body' }];
    }
    this.bodyLength += text.length;
    if (this.bodyLength > this.maxBodyCharacters) return this.fail('decision body exceeds limit');
    return [{ type: 'body', text }];
  }

  private fail(reason: string): ProtocolEvent[] {
    this.failed = true;
    this.line = '';
    return [{ type: 'error', reason }];
  }
}

export type AssistantChunk = { attemptId: string; index: number; revision: number; text: string };
export type ChunkResult = 'accepted' | 'duplicate' | 'gap' | 'revision_conflict' | 'abandoned' | 'limit';

type Cursor = { nextIndex: number; revision: number; abandoned: boolean; known: Map<number, { revision: number; digest: string }> };

/** Live chunk cursor. Durable messages and reconnect snapshots must never be fed as new body. */
export class ChunkCursor {
  private readonly cursors = new Map<string, Cursor>();
  private readonly maxAttempts: number;
  private readonly maxChunksPerAttempt: number;

  constructor(maxAttempts = 64, maxChunksPerAttempt = 8192) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Number.isSafeInteger(maxChunksPerAttempt) || maxChunksPerAttempt < 1) throw new RangeError('invalid chunk cursor limits');
    this.maxAttempts = maxAttempts;
    this.maxChunksPerAttempt = maxChunksPerAttempt;
  }

  baseline(attemptId: string, nextIndex: number, revision: number): void {
    this.validate(attemptId, nextIndex, revision);
    const current = this.cursors.get(attemptId);
    if (current?.abandoned) return;
    if (current && (nextIndex < current.nextIndex || revision < current.revision)) throw new Error('reconnect baseline cannot move backward');
    if (!current) this.set(attemptId, { nextIndex, revision, abandoned: false, known: new Map() });
    else { current.nextIndex = nextIndex; current.revision = revision; }
  }

  abandon(attemptId: string): void {
    const current = this.cursors.get(attemptId);
    this.set(attemptId, { nextIndex: current?.nextIndex ?? 0, revision: current?.revision ?? 0, abandoned: true, known: current?.known ?? new Map() });
  }

  accept(chunk: AssistantChunk): ChunkResult {
    this.validate(chunk.attemptId, chunk.index, chunk.revision);
    if (typeof chunk.text !== 'string') throw new TypeError('chunk text required');
    const current = this.cursors.get(chunk.attemptId);
    if (current?.abandoned) return 'abandoned';
    if (current) {
      if (chunk.index < current.nextIndex) {
        const known = current.known.get(chunk.index);
        if (known) return known.revision === chunk.revision && known.digest === this.digest(chunk.text) ? 'duplicate' : 'revision_conflict';
        return chunk.revision <= current.revision ? 'duplicate' : 'revision_conflict';
      }
      if (chunk.index > current.nextIndex) return 'gap';
      if (chunk.revision <= current.revision) return 'revision_conflict';
    } else if (chunk.index !== 0) return 'gap';
    const cursor = current ?? { nextIndex: 0, revision: -1, abandoned: false, known: new Map() };
    if (cursor.known.size >= this.maxChunksPerAttempt) return 'limit';
    cursor.known.set(chunk.index, { revision: chunk.revision, digest: this.digest(chunk.text) });
    cursor.nextIndex = chunk.index + 1;
    cursor.revision = chunk.revision;
    this.set(chunk.attemptId, cursor);
    return 'accepted';
  }

  private validate(attemptId: string, index: number, revision: number): void {
    if (!attemptId || attemptId.length > 128 || !Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(revision) || revision < 0) throw new RangeError('invalid chunk identity');
  }

  private digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

  private set(id: string, cursor: Cursor): void {
    if (!this.cursors.has(id) && this.cursors.size >= this.maxAttempts) this.cursors.delete(this.cursors.keys().next().value!);
    this.cursors.set(id, cursor);
  }
}
