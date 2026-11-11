import { HostClient } from './client.ts';
import type { HostCommand } from './protocol.ts';
import { hostDirectory } from './state-directory.ts';

const client = new HostClient(hostDirectory());
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function main() {
  const [operation, ...args] = process.argv.slice(2);
  switch (operation) {
    case 'snapshot': print(await client.snapshot()); return;
    case 'watch': {
      await client.snapshot();
      const close = client.watch(print);
      process.once('SIGINT', close); process.once('SIGTERM', close);
      return;
    }
    case 'receipt': print(await client.command({ type: 'work-receipt', operationId: args[0] })); return;
    case 'command': print(await client.command(JSON.parse(args.join(' ')) as HostCommand)); return;
    case 'submit': {
      const [projectId, ...prompt] = args;
      print(await client.command({ type: 'work', command: { type: 'submit', projectId, prompt: prompt.join(' ') } })); return;
    }
    case 'accept': case 'recheck': {
      const [taskId, attemptId] = args;
      print(await client.command({ type: 'work', command: { type: operation, taskId, attemptId } })); return;
    }
    case 'export': {
      const [artifactId, destination] = args;
      const receipt = await client.command<{ status: string }>({ type: 'artifact-export', artifactId, destination });
      print(receipt); if (receipt.status !== 'exported') process.exitCode = 1;
      return;
    }
    case 'diff': process.stdout.write(await client.command<string>({ type: 'diff', attemptId: args[0] })); return;
    case 'shutdown': print(await client.command({ type: 'shutdown' })); return;
    default: throw new Error('Usage: host:ctl -- snapshot|watch|receipt <operation-id>|submit <project-id> <prompt>|accept <task-id> <attempt-id>|recheck <task-id> <attempt-id>|diff <attempt-id>|export <artifact-id> <absolute-destination>|command <JSON>|shutdown');
  }
}

void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
