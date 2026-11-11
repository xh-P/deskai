import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundledPersonas } from '../../../packages/voice-core/src/persona-files.ts';
import { isRelationshipMode, type RelationshipMode } from '../../../packages/voice-core/src/persona-catalog.ts';
import { validatePersona, type Persona } from '../../../packages/voice-core/src/prompts.ts';
import type { DialogueHistoryEntry } from '../../../packages/voice-core/src/dialogue.ts';

export type CharacterDraft = Pick<Persona, 'displayName' | 'traits' | 'speechStyle'> & { id?: string; revision?: number };
export type CharacterSummary = Pick<Persona, 'id' | 'displayName' | 'revision'> & { relationships?: Record<RelationshipMode, string> };
export type ConversationRecord = { id: string; persona: Persona; relationshipMode: RelationshipMode;
  title?: string; createdAt: string; updatedAt: string; history: DialogueHistoryEntry[] };
export type ConversationSummary = { id: string; personaId: string; displayName: string; revision: number;
  relationshipMode: RelationshipMode; relationship?: string; title: string; updatedAt: string };

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flush: true });
  await rename(temporary, file);
}

export class CharacterStore {
  private readonly roles = new Map<string, Persona>();
  private readonly overrides = new Map<string, Persona>();
  private readonly file?: string;
  private writes: Promise<unknown> = Promise.resolve();

  private constructor(directory?: string) { this.file = directory && path.join(directory, 'characters.json'); }

  static async open(root: string, directory?: string) {
    const store = new CharacterStore(directory);
    for (const card of await bundledPersonas(root)) store.roles.set(card.id, card);
    const saved = store.file ? await readJson(store.file) : undefined;
    if (saved !== undefined) {
      if (!Array.isArray(saved)) throw new Error('CHARACTER_STORE_INVALID');
      for (const value of saved) {
        const card = validatePersona(value);
        store.overrides.set(card.id, card); store.roles.set(card.id, card);
      }
    }
    return store;
  }

  list(): CharacterSummary[] {
    return [...this.roles.values()].map(({ id, displayName, revision, roleplay }) => ({ id, displayName, revision,
      relationships: roleplay && { friend: roleplay.relationships.friend.displayName, kyon: roleplay.relationships.kyon.displayName } }));
  }

  get(id: string): Persona {
    const card = this.roles.get(id);
    if (!card) throw new Error('CHARACTER_NOT_FOUND');
    return structuredClone(card);
  }

  save(draft: CharacterDraft): Promise<Persona> {
    const work = this.writes.then(async () => {
      const current = draft.id === undefined ? undefined : this.get(draft.id);
      if (current && current.revision !== draft.revision) throw new Error('CHARACTER_REVISION_CHANGED');
      const card = validatePersona({ ...(current ?? { schemaVersion: 1, id: `character-${randomUUID()}`,
        mode: 'light-persona', avoid: [], examples: [] }), revision: (current?.revision ?? 0) + 1,
        displayName: draft.displayName?.trim(), traits: draft.traits, speechStyle: draft.speechStyle });
      const next = new Map(this.overrides).set(card.id, card);
      if (this.file) await writeJson(this.file, [...next.values()]);
      this.overrides.set(card.id, card); this.roles.set(card.id, card);
      return structuredClone(card);
    });
    this.writes = work.catch(() => {});
    return work;
  }
}

export function conversationSummary(record: ConversationRecord): ConversationSummary {
  const { id, persona, relationshipMode, title, updatedAt } = record;
  return { id, personaId: persona.id, displayName: persona.displayName, revision: persona.revision, relationshipMode,
    relationship: persona.roleplay?.relationships[relationshipMode].displayName,
    title: title ?? '新会话', updatedAt };
}

/** Stores the owning role revision and the delivery ledger's bounded visible history. */
export class ConversationArchive {
  private readonly records = new Map<string, ConversationRecord>();
  private readonly directory?: string;
  private dirty = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<unknown> = Promise.resolve();

  private constructor(directory?: string) { this.directory = directory && path.join(directory, 'conversations'); }

  static async open(directory?: string) {
    const archive = new ConversationArchive(directory);
    if (!archive.directory) return archive;
    await mkdir(archive.directory, { recursive: true });
    for (const file of await readdir(archive.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(file)) continue;
      const record = await readJson(path.join(archive.directory, file)) as ConversationRecord | undefined;
      if (!record || record.id !== file.slice(0, -5) || !isRelationshipMode(record.relationshipMode) || !Array.isArray(record.history))
        throw new Error('CONVERSATION_ARCHIVE_INVALID');
      record.persona = validatePersona(record.persona);
      archive.records.set(record.id, record);
    }
    return archive;
  }

  list(): ConversationSummary[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(conversationSummary);
  }

  get(id: string): ConversationRecord {
    const record = this.records.get(id);
    if (!record) throw new Error('CONVERSATION_NOT_FOUND');
    return structuredClone(record);
  }

  async create(persona: Persona, relationshipMode: RelationshipMode): Promise<ConversationRecord> {
    const time = new Date().toISOString();
    const record: ConversationRecord = { id: randomUUID(), persona: structuredClone(persona),
      relationshipMode: persona.roleplay ? relationshipMode : 'friend', createdAt: time, updatedAt: time, history: [] };
    await this.persist(record);
    this.records.set(record.id, record);
    return structuredClone(record);
  }

  checkpoint(id: string, history: DialogueHistoryEntry[]) {
    const record = this.records.get(id);
    if (!record || JSON.stringify(record.history) === JSON.stringify(history)) return;
    const title = record.title ?? history.find(entry => entry.role === 'user')?.text.slice(0, 44);
    this.records.set(id, { ...record, title, history, updatedAt: new Date().toISOString() });
    if (!this.directory) return;
    this.dirty.add(id);
    this.timer ??= setTimeout(() => { void this.flush().catch(error => console.error('Conversation archive:', error)); }, 180);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    const work = this.writing.then(async () => {
      const batch = [...this.dirty]; this.dirty.clear();
      try { for (const id of batch) await this.persist(this.records.get(id)!); }
      catch (error) { for (const id of batch) this.dirty.add(id); throw error; }
    });
    this.writing = work.catch(() => {});
    await work;
  }

  private async persist(record: ConversationRecord) {
    if (this.directory) await writeJson(path.join(this.directory, `${record.id}.json`), record);
  }
}
