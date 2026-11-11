import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkBaseline, WorkChanges, WorkWorkspace } from './types.ts';

const exec = promisify(execFile);
const MANIFEST_DIRECTORY = '.deskai2-artifacts';
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const ARTIFACT_SIZE_LIMIT = 20 * 1024 * 1024;

export function relativeInside(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative : undefined;
}

export function workspacesOverlap(a: string, b: string): boolean {
  return path.relative(a, b) === '' || relativeInside(a, b) !== undefined || relativeInside(b, a) !== undefined;
}

async function git(cwd: string, args: string[], index?: string): Promise<string> {
  const env = { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete (env as NodeJS.ProcessEnv)[key];
  if (index) Object.assign(env, { GIT_INDEX_FILE: index });
  const result = await exec('git', ['-C', cwd, ...args], { env, windowsHide: true, timeout: 90_000, maxBuffer: GIT_OUTPUT_LIMIT });
  return result.stdout;
}

async function gitRoot(cwd: string): Promise<string | undefined> {
  try { return await realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trim()); }
  catch (error) {
    if ((error as { stderr?: string }).stderr?.includes('not a git repository')) return undefined;
    throw error;
  }
}

async function head(cwd: string): Promise<string | undefined> {
  try { return (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim(); }
  catch (error) { if ((error as { code?: number }).code === 1) return undefined; throw error; }
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function fileHash(file: string, size: number): Promise<string | null> {
  return size <= ARTIFACT_SIZE_LIMIT ? createHash('sha256').update(await readFile(file)).digest('hex') : null;
}

/** Provisions Work directories and captures Attempt snapshots without using the live index. */
export class Workspaces {
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  async prepare(taskId: string, projectPath: string, previous?: WorkWorkspace): Promise<WorkWorkspace> {
    if (previous) {
      if (previous.kind === 'git') await this.verifyWorktree(previous);
      if (path.relative(previous.path, await realpath(previous.path)) || !(await stat(previous.path)).isDirectory())
        throw new Error('WORK_WORKSPACE_MOVED');
      return previous;
    }
    const project = await realpath(projectPath);
    if (!(await stat(project)).isDirectory() || !path.relative(this.directory, project) || relativeInside(this.directory, project))
      throw new Error('WORK_PROJECT_DIRECTORY_INVALID');
    const repository = await gitRoot(project);
    const base = repository && await head(repository);
    if (!repository || !base) return { kind: 'local', path: project, ...(repository ? { repository } : {}) };
    const root = path.join(this.directory, 'worktrees', taskId);
    const branch = `codex/deskai-work/${taskId}`;
    const workspace = { kind: 'git' as const, path: path.join(root, path.relative(repository, project)), root, repository, branch };
    if (!await exists(root)) {
      await mkdir(path.dirname(root), { recursive: true });
      const branches = await git(repository, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`]);
      const args = branches.trim() === `refs/heads/${branch}` ? [root, branch] : ['-b', branch, root, base];
      await git(repository, ['worktree', 'add', '--no-track', ...args]);
    }
    await this.verifyWorktree(workspace);
    if (path.relative(workspace.path, await realpath(workspace.path)) || !(await stat(workspace.path)).isDirectory())
      throw new Error('WORK_WORKSPACE_DIRECTORY_INVALID');
    return workspace;
  }

  private async verifyWorktree(workspace: Extract<WorkWorkspace, { kind: 'git' }>) {
    const common = (cwd: string) => git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then(result => realpath(result.trim()));
    const [root, branch, worktreeGit, projectGit] = await Promise.all([gitRoot(workspace.root),
      git(workspace.root, ['symbolic-ref', '--short', 'HEAD']), common(workspace.root), common(workspace.repository)]);
    if (!root || path.relative(root, workspace.root) || branch.trim() !== workspace.branch || path.relative(worktreeGit, projectGit))
      throw new Error('WORK_WORKTREE_BINDING_MISMATCH');
  }

  private async tree(root: string, workDir: string, attemptId: string, stage: 'before' | 'after'): Promise<string> {
    const index = path.join(this.directory, `index-${randomUUID()}`);
    const prefix = path.relative(root, workDir).split(path.sep).join('/');
    const manifest = [prefix, MANIFEST_DIRECTORY].filter(Boolean).join('/');
    try {
      const revision = await head(root);
      await git(root, ['read-tree', revision ?? '--empty'], index);
      await git(root, ['add', '-A', '--', '.', `:(exclude,literal)${manifest}`], index);
      // Remove protocol files from the temporary index even if the base tracked them.
      await git(root, ['rm', '--cached', '-rf', '--ignore-unmatch', '--', `:(literal)${manifest}`], index);
      const tree = (await git(root, ['write-tree'], index)).trim();
      await git(root, ['update-ref', `refs/deskai/attempts/${attemptId}/${stage}`, tree]);
      return tree;
    } finally { await rm(index, { force: true }); }
  }

  async baseline(workspace: WorkWorkspace, attemptId: string): Promise<WorkBaseline> {
    const root = workspace.kind === 'git' ? workspace.root : workspace.repository;
    if (root) return { kind: 'git', root, tree: await this.tree(root, workspace.path, attemptId, 'before') };
    const files = new Map<string, string | null>();
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.name === '.git' || entry.name === MANIFEST_DIRECTORY || !path.relative(this.directory, file)) continue;
        if (entry.isDirectory()) await walk(file);
        if (entry.isFile()) files.set(path.relative(workspace.path, file), await fileHash(file, (await stat(file)).size));
      }
    };
    await walk(workspace.path);
    await mkdir(path.join(this.directory, 'baselines'), { recursive: true });
    await writeFile(this.baselineFile(attemptId), JSON.stringify([...files]), { flush: true });
    return { kind: 'local' };
  }

  private baselineFile(attemptId: string) { return path.join(this.directory, 'baselines', `${attemptId}.json`); }

  async collect(workspace: WorkWorkspace, attemptId: string, baseline: WorkBaseline, claims: string[]) {
    const files: { relativePath: string; sha256: string }[] = [];
    let changes: WorkChanges | undefined;
    let eligible: (file: string, relative: string, sha256: string) => boolean;
    if (baseline.kind === 'git') {
      if (workspace.kind === 'git') await this.verifyWorktree(workspace);
      const { root, tree } = baseline;
      const after = await this.tree(root, workspace.path, attemptId, 'after');
      const paths = (await git(root, ['diff', '--no-ext-diff', '--name-only', '--no-renames', '-z', tree, after])).split('\0').filter(Boolean);
      const gitPaths = new Set(paths);
      changes = { before: tree, after, fileCount: paths.length };
      eligible = file => gitPaths.has(path.relative(root, file).split(path.sep).join('/'));
    } else {
      const before = new Map<string, string | null>(JSON.parse(await readFile(this.baselineFile(attemptId), 'utf8')));
      eligible = (_file, relative, sha256) => sha256 !== before.get(relative);
    }
    for (const claim of new Set(claims)) {
      const file = await realpath(path.resolve(workspace.path, claim)).catch(() => undefined);
      const relative = file && relativeInside(workspace.path, file);
      if (!file || !relative || relative.split(path.sep).some(part => part === '.git' || part === MANIFEST_DIRECTORY)) continue;
      const info = await stat(file);
      if (!info.isFile()) continue;
      const sha256 = await fileHash(file, info.size);
      if (sha256 && eligible(file, relative, sha256)) files.push({ relativePath: relative, sha256 });
    }
    return { changes, files };
  }

  async diff(baseline: WorkBaseline, changes: WorkChanges): Promise<string> {
    if (baseline.kind !== 'git') throw new Error('WORK_DIFF_UNAVAILABLE');
    return git(baseline.root, ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color',
      '--no-renames', '--binary', '--full-index', '--src-prefix=a/', '--dst-prefix=b/', '-U3', changes.before, changes.after, '--']);
  }
}
