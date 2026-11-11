import path from 'node:path';
import { readBundle, bundlePath } from '../../../packages/app-core/src/bundle.ts';
import type { ArtifactRegistry } from '../../../packages/app-core/src/artifacts.ts';
import type { DeliveryEvidence } from '../../../packages/work-core/src/completion.ts';
import type { WorkAttempt, WorkTask } from '../../../packages/work-core/src/types.ts';

/** Read current, Host-registered bytes for the exact Work and its declared outputs. */
export async function verifyWorkDelivery(registry: ArtifactRegistry, task: WorkTask, attempt: WorkAttempt, claims: string[]): Promise<DeliveryEvidence> {
  const evidence: DeliveryEvidence = { files: [], appEntries: [], failures: [] };
  if (!task.workspace) return evidence;
  const workspace = task.workspace.path;
  const records = new Map(registry.listArtifacts().filter(file => file.taskId === task.id && !path.relative(file.workDir, workspace))
    .map(file => [bundlePath(file.relativePath), file]));
  const current = [...records].filter(([, file]) => file.attemptId === attempt.id).map(([name]) => name);
  const declared = claims.map(name => bundlePath(path.relative(workspace, path.resolve(workspace, name))));
  const expected = (task.expectedArtifacts ?? []).filter(name => records.has(name));
  for (const relativePath of new Set([...current, ...declared, ...expected])) {
    const file = records.get(relativePath);
    if (!file) { evidence.failures.push({ relativePath, reason: 'WORK_ARTIFACT_NOT_ATTRIBUTABLE' }); continue; }
    try {
      const { artifact } = await registry.readVerified(file.id);
      evidence.files.push({ id: artifact.id, relativePath, sha256: artifact.sha256 });
    } catch (error) { evidence.failures.push({ relativePath, reason: error instanceof Error ? error.message : String(error) }); }
  }
  if (task.authoring) {
    const entries = [...records.keys()].filter(name => /\.html$/i.test(name) &&
      records.has(path.posix.join(path.posix.dirname(name), 'auip.manifest.json')));
    for (const relativePath of entries) {
      try { await readBundle(registry, records.get(relativePath)!.id); evidence.appEntries.push(relativePath); }
      catch (error) { evidence.failures.push({ relativePath, reason: error instanceof Error ? error.message : String(error) }); }
    }
  }
  return evidence;
}
