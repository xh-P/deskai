import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactRegistry } from './index.ts';

export interface ExportReceipt {
  id: string;
  artifactId: string;
  taskId: string;
  attemptId?: string;
  sha256: string;
  destination: string;
  approvedAt: string;
  finishedAt?: string;
  status: 'approved' | 'exported' | 'failed';
  error?: string;
}

/** A trusted client approves a specific artifact and destination. Publish once without replacing existing files. */
export class ArtifactExports {
  private readonly registry: ArtifactRegistry;
  private readonly directory: string;
  private readonly receipts = new Map<string, ExportReceipt>();
  constructor(directory: string, registry: ArtifactRegistry) { this.directory = directory; this.registry = registry; }

  private staged(receipt: ExportReceipt) { return path.join(path.dirname(receipt.destination), `.deskai-export-${receipt.id}.tmp`); }

  private async save(receipt: ExportReceipt) {
    const file = path.join(this.directory, `${receipt.id}.json`);
    const temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify(receipt), { flush: true });
    await rename(temp, file);
    this.receipts.set(receipt.id, { ...receipt });
  }

  list(): ExportReceipt[] { return [...this.receipts.values()].map(receipt => ({ ...receipt })); }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const file of (await readdir(this.directory)).filter(file => file.endsWith('.json'))) {
      const receipt = JSON.parse(await readFile(path.join(this.directory, file), 'utf8')) as ExportReceipt;
      if (file !== `${receipt.id}.json`) throw new Error('ARTIFACT_EXPORT_LEDGER_INVALID');
      this.receipts.set(receipt.id, receipt);
      const temporary = this.staged(receipt);
      if (receipt.status === 'approved') {
        const confirmed = await this.wasPublished(receipt);
        await this.finish(receipt, confirmed ? undefined : 'ARTIFACT_EXPORT_INTERRUPTED');
      }
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async wasPublished(receipt: ExportReceipt): Promise<boolean> {
    try {
      const [staged, target] = await Promise.all([lstat(this.staged(receipt), { bigint: true }), lstat(receipt.destination, { bigint: true })]);
      return staged.isFile() && target.isFile() && staged.dev === target.dev && staged.ino === target.ino &&
        createHash('sha256').update(await readFile(receipt.destination)).digest('hex') === receipt.sha256;
    } catch { return false; }
  }

  private async finish(receipt: ExportReceipt, error?: string) {
    receipt.status = error ? 'failed' : 'exported'; receipt.error = error; receipt.finishedAt = new Date().toISOString();
    await this.save(receipt);
  }

  async export(artifactId: string, destination: string): Promise<ExportReceipt> {
    if (typeof destination !== 'string' || !path.isAbsolute(destination) || !path.basename(destination)) throw new Error('ARTIFACT_EXPORT_DESTINATION_REQUIRED');
    const { artifact, bytes } = await this.registry.readVerified(artifactId);
    const target = path.join(await realpath(path.dirname(destination)), path.basename(destination));
    const receipt: ExportReceipt = { id: randomUUID(), artifactId, taskId: artifact.taskId, attemptId: artifact.attemptId,
      sha256: artifact.sha256, destination: target, approvedAt: new Date().toISOString(), status: 'approved' };
    await this.save(receipt);
    const temporary = this.staged(receipt);
    let error: string | undefined;
    let staged = false;
    try {
      await writeFile(temporary, bytes, { flag: 'wx', flush: true }); staged = true;
      await link(temporary, target);
    } catch (cause) { error = (cause as NodeJS.ErrnoException).code ?? 'ARTIFACT_EXPORT_FAILED'; }
    await this.finish(receipt, error);
    if (staged) await rm(temporary, { force: true }).catch(() => {});
    return receipt;
  }
}
