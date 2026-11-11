import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { HostClient } from '../../host/src/client.ts';

/** Desktop starts a missing service and leaves its lifetime under Host control. */
export async function connectHost(client: HostClient, root: string) {
  const existing = await client.snapshot().catch(() => undefined);
  if (existing) return existing;
  const node = process.env.DESKAI_NODE_EXECUTABLE;
  if (!node) throw new Error('HOST_NODE_REQUIRED');
  const directory = client.directory;
  const logPath = path.join(directory, 'host.log');
  await mkdir(directory, { recursive: true });
  const log = await open(logPath, 'a', 0o600);
  try {
    const env = { ...process.env, DESKAI_HOST_DIR: directory, DESKAI_PROJECT_ROOT: root };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const entry = fileURLToPath(new URL('../../host/src/server.js', import.meta.url));
    const child = spawn(node, [entry], { cwd: root, env, windowsHide: true, detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.once('error', error => console.error('Host launch failed', error));
    child.unref();
  } finally { await log.close(); }
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const snapshot = await client.snapshot().catch(() => undefined);
    if (snapshot) return snapshot;
    await delay(250);
  }
  throw new Error(`HOST_START_FAILED (${logPath})`);
}
