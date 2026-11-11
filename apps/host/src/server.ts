import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { DshWorkProvider } from '../../../packages/dsh-adapter/src/work-provider.ts';
import { loadWorkOptions, WorkRuntime } from '../../../packages/dsh-adapter/src/work-runtime.ts';
import { HostApi } from './api.ts';
import { LocalHost } from './host.ts';
import type { HostCommand } from './protocol.ts';
import { hostDirectory } from './state-directory.ts';

async function serve() {
  const root = path.resolve(process.env.DESKAI_PROJECT_ROOT ?? process.cwd());
  const directory = hostDirectory();
  const options = await loadWorkOptions(root);
  const api = new HostApi();
  let runtime: WorkRuntime;
  let host: LocalHost;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    await api.quiesce();
    try { await host.close(); await runtime.dispose(); } finally { await api.close(); }
  })();
  const stop = () => void close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  await api.start(directory, () => host.snapshot(), async raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_HOST_COMMAND');
    const input = raw as HostCommand;
    if (input.type === 'shutdown') { setImmediate(stop); return { stopping: true }; }
    return host.command(input);
  }, async () => {
    const state = await realpath(directory);
    runtime = new WorkRuntime(root, options, path.join(state, 'dsh-runtime.json'), () => host?.changed());
    host = await LocalHost.open(state, new DshWorkProvider(runtime, root), options.cwd, runtime);
    host.subscribe(() => api.broadcast());
  }, (taskId, after, send) => host.trace.subscribe(taskId, after, send)).catch(async error => {
    await host?.close(); await runtime?.dispose();
    throw error;
  });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  console.log(`DeskAI Host ready (${directory})`);
}

void serve().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
