import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseCoordinationPlan, type CoordinationPlan } from '../../packages/voice-core/src/coordination.ts';
import { DesktopTurnCoordinator } from '../../apps/desktop/src/turn-coordinator.ts';
import { HostApi } from '../../apps/host/src/api.ts';
import { LocalHost } from '../../apps/host/src/host.ts';
import { dialogueContext, taskStatus } from '../../apps/host/src/context.ts';
import type { ControlContext, ControlReceipt, ControlTurn } from '../../apps/host/src/conversation-control.ts';
import type { WorkOperationReceipt } from '../../packages/work-core/src/operations.ts';
import type { ProviderPort, ProviderRequest } from '../../packages/work-core/src/types.ts';
import type { AcceptanceReceipt } from '../../packages/work-core/src/completion.ts';

const turnFor = (text: string, conversationId = 'conversation'): ControlTurn => ({ id: randomUUID(), conversationId, text });

test('a completed plan cannot execute after the active conversation changes', async () => {
  const planned = Promise.withResolvers<void>();
  const decision = Promise.withResolvers<CoordinationPlan>();
  let conversationId = 'initial-conversation';
  let accepted = false;
  const dialogue = {
    discardSpeculative() {},
    async submit() { assert.fail('old input reached Chat'); },
  };
  const planner = {
    async plan() { planned.resolve(); return decision.promise; },
    async cancel() {},
  };
  const commands: string[] = [];
  const coordinator = new DesktopTurnCoordinator({
    current: () => ({ sessionId: 'live', conversationId, dialogue, planner }),
    ready: async () => {},
    host: async () => ({
      async snapshot() { assert.fail('unexpected fallback'); },
      async command<T>(command: { type: string }) {
        commands.push(command.type);
        return { planning: {}, chat: {} } as T;
      },
    }),
    emit() {}, announce() {}, onIdle() {},
  });
  const pending = coordinator.submit({ text: '提交任务', source: 'text', onAccepted: () => { accepted = true; } });
  await planned.promise;
  conversationId = 'replacement-conversation';
  decision.resolve({ intent: 'submit', references: null });
  assert.deepEqual(await pending, { accepted: false });
  assert.deepEqual(commands, ['plan-context']);
  assert.equal(accepted, false);
  assert.equal(coordinator.busy, false);
});

async function settle(host: LocalHost, taskId: string) {
  for (let i = 0; i < 150; i++) {
    const { tasks, attempts } = host.work.snapshot();
    const attempt = attempts.find(item => item.id === tasks.find(task => task.id === taskId)?.attemptIds.at(-1));
    if (attempt?.assessment) { assert.equal(attempt.status, 'completed'); return attempt; }
    await delay(20);
  }
  throw new Error('Work assessment timed out');
}

test('coordination rejects incomplete controls and prose, and accepts declared intents', () => {
  assert.deepEqual(parseCoordinationPlan('{"intent":"chat"}'), { intent: 'chat' });
  assert.deepEqual(parseCoordinationPlan('{"intent":"submit","references":null,"authoring":true}'), { intent: 'submit', references: null, authoring: true });
  for (const value of ['已经完成', '{"intent":"cancel"}', '{"intent":"app","sessionId":"x"}', '{"intent":"submit","references":null,"prompt":"replace user input"}'])
    assert.throws(() => parseCoordinationPlan(value));
});

test('dialogue context reflects host capabilities and the actual execution receipt', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deskai-context-'));
  const provider: ProviderPort = {
    start: async () => ({ outcome: 'completed', summary: 'Done' }),
    append: async () => {}, cancel: async () => {}, reply: async () => {}
  };
  const host = await LocalHost.open(path.join(directory, 'host'), provider, directory);
  try {
    const inquiry = turnFor('你除了聊天还能做什么？');
    const { chat: context } = await host.command({ type: 'plan-context', turn: inquiry }) as ControlContext;
    assert.deepEqual(await host.command({ type: 'plan', turn: inquiry, plan: { intent: 'chat' } }), context.receipt);
    assert.deepEqual(context.receipt, { kind: 'chat' });
    assert.equal(host.snapshot().work.tasks.length, 0);
    assert.deepEqual(context.capabilities.applications, []);
    assert.equal(context.capabilities.work.executor, 'dsh');
    assert.equal(context.capabilities.selectedProject?.id, host.selectedProjectId);
    const turn = turnFor('Create a note');
    await host.command({ type: 'plan-context', turn });
    const receipt = await host.command({ type: 'plan', turn, plan: { intent: 'submit', references: null } }) as WorkOperationReceipt;
    assert.equal(receipt.kind, 'work-operation');
    assert.equal(host.snapshot().work.tasks[0].id, receipt.task.id);
    assert.deepEqual(dialogueContext(host.snapshot(), receipt).receipt, receipt);
    await settle(host, receipt.task.id);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Host resolves same-project ambiguity, respects cross-project ownership and replays the bound Work', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deskai-references-'));
  const stateDir = path.join(directory, 'host');
  const firstProject = path.join(directory, '甲项目'), secondProject = path.join(directory, '乙项目');
  await Promise.all([mkdir(firstProject), mkdir(secondProject)]);
  const calls: ProviderRequest[] = [];
  const provider: ProviderPort = {
    async start(request, notify) {
      calls.push(request);
      if (request.requestId) notify({ type: 'request-admitted', requestId: request.requestId });
      return { outcome: 'completed', providerSessionId: request.providerSessionId ?? `native-${request.taskId}` };
    },
    async append() {}, async cancel() {}, async reply() {}
  };
  let host = await LocalHost.open(stateDir, provider, firstProject);
  try {
    const home = host.selectedProjectId;
    const remote = host.work.createProject({ name: '乙项目', path: secondProject });
    async function seed(projectId: string, title: string) {
      const { task } = await host.command({ type: 'work', command: { type: 'submit', projectId, title, prompt: `处理${title}` } }) as WorkOperationReceipt;
      await settle(host, task.id);
      return task;
    }
    const daily = await seed(home, '日报');
    const weekly = await seed(home, '周报');
    const remoteDaily = await seed(remote.id, '日报');
    await host.command({ type: 'select', projectId: home });

    const turn = turnFor('继续这个');
    const { planning } = await host.command({ type: 'plan-context', turn }) as ControlContext;
    const token = (task: { id: string }) => planning.references.find(row => row.token === `work_item:${task.id}`)!.token;
    const plan = { intent: 'resume' as const, references: [token(weekly)], referenceText: '这个' };
    const card = await host.command({ type: 'plan', turn, plan }) as ControlReceipt;
    assert.equal(card.kind, 'reference-clarification');
    assert.deepEqual(card.options.map(option => option.label).sort(), ['周报', '日报']);
    assert.equal(calls.length, 3);

    const selection = { clarificationId: card.id, optionId: card.options.find(option => option.label === '日报')!.id };
    const confirmation = turnFor('日报');
    const next = await host.command({ type: 'plan-context', turn: confirmation }) as ControlContext;
    assert.equal(next.planning.pendingClarification?.id, card.id);
    const replayChoice = { type: 'reference-select' as const, conversationId: turn.conversationId, selection };
    await assert.rejects(host.command({ ...replayChoice, conversationId: 'another-conversation' }), /COORDINATION_SELECTION_EXPIRED/);
    const receipts = await Promise.all([
      host.command({ type: 'plan', turn: confirmation, plan: { intent: 'choose', ...selection } }), host.command(replayChoice)
    ]) as WorkOperationReceipt[];
    const [receipt] = receipts;
    assert.equal(receipt.task.id, daily.id);
    assert.equal(receipt.operation.id, turn.id);
    assert.deepEqual(receipts[1].operation, receipt.operation);
    await settle(host, daily.id);
    assert.equal(calls.length, 4);
    assert.equal(calls[3].prompt, turn.text);
    assert.equal(calls[3].providerSessionId, `native-${daily.id}`);

    const wrongProject = turnFor('继续乙项目的日报');
    await host.command({ type: 'plan-context', turn: wrongProject });
    await assert.rejects(host.command({ type: 'plan', turn: wrongProject,
      plan: { intent: 'resume', references: [token(daily)], referenceText: '日报' } }), /COORDINATION_PROJECT_MISMATCH/);
    const cross = turnFor('继续乙项目的日报');
    await host.command({ type: 'plan-context', turn: cross });
    const crossReceipt = await host.command({ type: 'plan', turn: cross,
      plan: { intent: 'resume', references: [token(remoteDaily)], referenceText: '日报' } }) as WorkOperationReceipt;
    assert.equal(crossReceipt.task.id, remoteDaily.id);
    await settle(host, remoteDaily.id);
    assert.equal(calls.length, 5);
    assert.equal(calls[4].providerSessionId, `native-${remoteDaily.id}`);

    await host.close(); host = await LocalHost.open(stateDir, provider, firstProject);
    const replay = await host.command({ type: 'plan', turn, plan }) as WorkOperationReceipt;
    assert.equal(replay.execution.runId, receipt.execution.runId);
    assert.equal(replay.execution.requestId, turn.id);
    assert.equal(replay.operation.state, 'acknowledged');
    assert.deepEqual(await host.command(replayChoice), replay);
    assert.deepEqual(await host.command({ type: 'work-receipt', operationId: turn.id }), replay);
    await assert.rejects(host.command({ type: 'plan', turn: { ...turn, text: '继续另一项' }, plan }), /WORK_OPERATION_CONFLICT/);
    assert.equal(calls.length, 5);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('local control API requires its own bearer capability and rejects browser-origin use', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deskai-api-'));
  const api = new HostApi(); let commands = 0;
  try {
    await api.start(directory, () => ({ ready: true }), async () => { commands++; return { accepted: true }; });
    const descriptor = JSON.parse(await readFile(path.join(directory, 'local-api.json'), 'utf8'));
    assert.equal((await fetch(descriptor.url + '/snapshot')).status, 401);
    const headers = { authorization: `Bearer ${descriptor.token}` };
    assert.equal((await fetch(descriptor.url + '/snapshot', { headers: { ...headers, origin: 'http://127.0.0.1' } })).status, 401);
    assert.deepEqual(await (await fetch(descriptor.url + '/snapshot', { headers })).json(), { ready: true });
    assert.equal((await fetch(descriptor.url + '/command', { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal(commands, 1);
  } finally { await api.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Work assessment uses actual delivery and persists only explicit acceptance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deskai-review-'));
  const project = path.join(directory, 'project'); await mkdir(project);
  const stateDir = path.join(directory, 'host');
  await writeFile(path.join(project, 'preexisting.txt'), 'already here');
  const provider: ProviderPort = {
    async start(request, notify) {
      if (request.prompt === 'unverified') notify({ type: 'artifact', path: 'preexisting.txt' });
      if (request.prompt === 'deliver') {
        await writeFile(path.join(request.projectPath, 'report.txt'), 'verified output');
        notify({ type: 'artifact', path: 'report.txt' });
      }
      return { outcome: 'completed', summary: 'The work is done.' };
    },
    async append() {}, async cancel() {}, async reply() {}
  };
  let host = await LocalHost.open(stateDir, provider, project);
  async function run(prompt: string, file: string) {
    const { task } = await host.work.dispatch({ type: 'submit', projectId: host.selectedProjectId, prompt, expectedArtifacts: [file] });
    for (let i = 0; i < 150; i++) {
      const attempt = host.snapshot().work.attempts.find(item => item.taskId === task.id);
      if (attempt?.assessment) return { task, attempt };
      await delay(20);
    }
    throw new Error('Work assessment timed out');
  }
  try {
    const missing = await run('missing', 'missing.txt');
    assert.deepEqual(missing.attempt.assessment?.missingFiles, ['missing.txt']);
    assert.equal(missing.attempt.assessment?.review, 'open');
    await assert.rejects(host.work.review(missing.task.id, missing.attempt.id, 'accept'), /WORK_REVIEW_NOT_READY/);
    const invalid = await run('unverified', 'preexisting.txt');
    assert.equal(invalid.attempt.assessment?.delivery.failures[0].reason, 'WORK_ARTIFACT_NOT_ATTRIBUTABLE');
    assert.equal(invalid.attempt.assessment?.review, 'open');
    const ready = await run('deliver', 'report.txt');
    assert.equal(ready.attempt.assessment?.review, 'review_ready');
    assert.equal(ready.attempt.acceptance, undefined);
    await writeFile(path.join(project, 'report.txt'), 'changed after review');
    await assert.rejects(host.work.review(ready.task.id, ready.attempt.id, 'accept'), /WORK_REVIEW_NOT_READY/);
    await writeFile(path.join(project, 'report.txt'), 'verified output');
    const receipt = await host.work.review(ready.task.id, ready.attempt.id, 'accept') as AcceptanceReceipt;
    assert.equal(receipt.assessment.review, 'accepted');
    await host.close(); host = await LocalHost.open(stateDir, provider, project);
    assert.deepEqual(await host.work.review(ready.task.id, ready.attempt.id, 'accept'), receipt);
    const status = taskStatus(host.snapshot(), { taskId: ready.task.id });
    assert.equal(status.tasks[0].execution, 'completed');
    assert.equal(status.tasks[0].review, 'accepted');
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});
