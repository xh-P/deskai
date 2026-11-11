import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export type Artifact = { id: string; taskId: string; attemptId?: string; workDir: string; relativePath: string; sha256: string };
type ArtifactInput = Omit<Artifact, 'id' | 'sha256'>;
type Authorize = (taskId: string, workDir: string, relativePath: string, attemptId?: string) => boolean | Promise<boolean>;
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

export class ArtifactRegistry {
  private records = new Map<string, Artifact>();
  private saving: Promise<void> = Promise.resolve();
  private options: { authorize: Authorize; storageFile?: string };
  constructor(options: { authorize: Authorize; storageFile?: string }) { this.options = options; }
  async load(): Promise<void> {
    if (!this.options.storageFile) return;
    try {
      const records: unknown = JSON.parse(await readFile(this.options.storageFile, 'utf8'));
      if (!Array.isArray(records)) throw new Error('Invalid artifact registry');
      for (const item of records) if (item && typeof item.id === 'string' && typeof item.taskId === 'string' && typeof item.workDir === 'string' && typeof item.relativePath === 'string' && /^[a-f0-9]{64}$/.test(item.sha256)) this.records.set(item.id, item);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private async save(): Promise<void> {
    if (!this.options.storageFile) return;
    const storageFile = this.options.storageFile;
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(path.dirname(storageFile), { recursive: true });
      const temporary = `${storageFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify([...this.records.values()]), { encoding: 'utf8', flush: true });
      await rename(temporary, storageFile);
    });
    await this.saving;
  }
  async registerArtifact(input: ArtifactInput, expectedSha256?: string): Promise<Artifact> {
    if (!input.taskId || !input.relativePath || path.isAbsolute(input.relativePath)) throw new Error('Invalid artifact identity or relative path');
    if (!await this.options.authorize(input.taskId, input.workDir, input.relativePath, input.attemptId)) throw new Error('Artifact is not attributable to this attempt');
    const root = await realpath(input.workDir);
    const file = await realpath(path.resolve(root, input.relativePath));
    const info = await stat(file);
    if (!inside(root, file) || !info.isFile() || info.size > MAX_ARTIFACT_BYTES) throw new Error('Artifact must be a bounded file inside its work directory');
    const bytes = await readFile(file);
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error('Artifact is too large');
    const record = { id: randomUUID(), taskId: input.taskId, attemptId: input.attemptId, workDir: root, relativePath: path.relative(root, file), sha256: digest(bytes) };
    if (expectedSha256 && record.sha256 !== expectedSha256) throw new Error('Artifact changed since the attempt was collected');
    const existing = [...this.records.values()].find(item => item.taskId === record.taskId && item.attemptId === record.attemptId && item.workDir === record.workDir && item.relativePath === record.relativePath && item.sha256 === record.sha256);
    if (existing) return { ...existing };
    this.records.set(record.id, record);
    try { await this.save(); }
    catch (error) { this.records.delete(record.id); throw error; }
    return { ...record };
  }
  listArtifacts(): Artifact[] { return [...this.records.values()].map(item => ({ ...item })); }
  async readVerified(id: string): Promise<{ artifact: Artifact; bytes: Buffer }> {
    const artifact = this.records.get(id); if (!artifact) throw new Error('Unknown artifact');
    if (!await this.options.authorize(artifact.taskId, artifact.workDir, artifact.relativePath, artifact.attemptId)) throw new Error('Artifact authorization revoked');
    const file = await realpath(path.resolve(artifact.workDir, artifact.relativePath));
    if (!inside(artifact.workDir, file)) throw new Error('Artifact escaped its work directory');
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) throw new Error('Artifact is not a bounded file');
    const bytes = await readFile(file); if (digest(bytes) !== artifact.sha256) throw new Error('Artifact changed since registration');
    return { artifact: { ...artifact }, bytes };
  }
}
