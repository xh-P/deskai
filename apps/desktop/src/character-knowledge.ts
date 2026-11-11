import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { DialoguePort } from '../../../packages/voice-core/src/dialogue.ts';
import { DEFAULT_PERSONA_ID, isPersonaId } from '../../../packages/voice-core/src/persona-catalog.ts';
import type { CharacterLookup, CharacterReference } from '../../../packages/voice-core/src/character-reference.ts';
import type { ChatEvent, ChatTurnInput } from '../../../packages/dsh-adapter/src/session.ts';

type WorkerReply = { id: number; hits?: CharacterReference[]; nearestDistance?: number | null; error?: string };
type Waiter = (value: WorkerReply) => void;
type Worker = { child: ChildProcessWithoutNullStreams; waiting: Map<number, Waiter> };

/** Owns one CPU worker shared by confirmed and speculative Chat. */
export class CharacterKnowledge {
  private readonly source: string;
  private readonly cache: string;
  private readonly python: string;
  private readonly script: string;
  private worker?: Worker;
  private sequence = 0;

  constructor(root: string) {
    this.source = path.join(root, 'config/character-knowledge');
    this.cache = path.join(root, '.cache/character-knowledge');
    this.python = path.join(this.cache, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    this.script = path.join(root, 'services/character-knowledge/knowledge.py');
  }

  async lookup(input: ChatTurnInput, signal: AbortSignal): Promise<CharacterLookup> {
    if (!input.characterKnowledge) return { status: 'disabled', hits: [] };
    const characterId = input.persona?.id ?? input.personaId ?? DEFAULT_PERSONA_ID;
    if (!isPersonaId(characterId) || !existsSync(path.join(this.source, `${characterId}.json`))) return { status: 'no-corpus', hits: [] };
    if (![this.python, path.join(this.cache, 'model/model.onnx'), path.join(this.cache, 'model/tokenizer.json'),
      path.join(this.cache, 'indexes', characterId, 'index.json')].every(file => existsSync(file)))
      return { status: 'unavailable', code: 'KNOWLEDGE_SETUP_REQUIRED', hits: [] };
    const started = performance.now();
    const reply = await this.request(characterId, input.text, signal);
    const hits = reply.hits ?? [];
    if (reply.error) return { status: 'unavailable', hits, code: reply.error };
    return { status: hits.length ? 'hit' : 'miss', hits, nearestDistance: reply.nearestDistance ?? undefined,
      elapsedMs: Math.round((performance.now() - started) * 10) / 10 };
  }

  private start(): Worker {
    const child = spawn(this.python, ['-u', this.script, 'serve', this.source, this.cache], { windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', OMP_NUM_THREADS: '2' }, stdio: 'pipe' });
    const worker: Worker = { child, waiting: new Map() };
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let reply: WorkerReply;
      try { reply = JSON.parse(line) as WorkerReply; }
      catch { this.stopWorker(worker, 'KNOWLEDGE_WORKER_PROTOCOL'); return; }
      worker.waiting.get(reply.id)?.(reply);
    });
    child.stderr.resume();
    child.stdin.on('error', () => this.stopWorker(worker, 'KNOWLEDGE_WORKER_EXITED'));
    child.once('error', () => this.stopWorker(worker, 'KNOWLEDGE_WORKER_UNAVAILABLE'));
    child.once('close', () => { lines.close(); this.stopWorker(worker, 'KNOWLEDGE_WORKER_EXITED'); });
    return this.worker = worker;
  }

  private request(characterId: string, text: string, signal: AbortSignal): Promise<WorkerReply> {
    signal.throwIfAborted();
    const worker = this.worker ?? this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); worker.waiting.delete(id); signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => this.stopWorker(worker, 'KNOWLEDGE_WORKER_TIMEOUT'), 10_000);
      worker.waiting.set(id, reply => { cleanup(); resolve(reply); });
      signal.addEventListener('abort', abort, { once: true });
      worker.child.stdin.write(JSON.stringify({ id, characterId, text }) + '\n');
    });
  }

  private stopWorker(worker: Worker, code: string) {
    if (this.worker !== worker) return;
    this.worker = undefined;
    for (const [id, finish] of worker.waiting) finish({ id, error: code });
    if (worker.child.exitCode === null) worker.child.kill();
  }

  close() { if (this.worker) this.stopWorker(this.worker, 'KNOWLEDGE_WORKER_CLOSED'); }
}

export class CharacterChat implements DialoguePort {
  private lookup?: AbortController;
  private readonly port: DialoguePort;
  private readonly knowledge: CharacterKnowledge;

  constructor(port: DialoguePort, knowledge: CharacterKnowledge) { this.port = port; this.knowledge = knowledge; }

  async runTurn(input: ChatTurnInput, emit: (event: ChatEvent) => void) {
    if (this.lookup) throw new Error('CHAT_TURN_BUSY');
    const controller = new AbortController();
    this.lookup = controller;
    const result = await this.knowledge.lookup(input, controller.signal).finally(() => {
      if (this.lookup === controller) this.lookup = undefined;
    });
    controller.signal.throwIfAborted();
    const accepted = await this.port.runTurn({ ...input, characterReference: result.hits }, emit);
    const knowledge = { ...result, hits: result.hits.map(({ text: _text, ...reference }) => reference) };
    return { ...accepted, knowledge };
  }

  cancel() {
    this.lookup?.abort(new Error('CHAT_KNOWLEDGE_CANCELLED'));
    this.lookup = undefined;
    return this.port.cancel();
  }
}
