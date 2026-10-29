import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LocalDshSpeech } from '../../.cache/desktop-main/packages/dsh-adapter/src/speech.js';
import { LocalDshChat } from '../../.cache/desktop-main/packages/dsh-adapter/src/session.js';
import { DecisionStream } from '../../.cache/desktop-main/packages/voice-core/src/stream.js';
import { localDecision } from '../../.cache/desktop-main/packages/voice-core/src/policy.js';

// This targeted diagnostic is deliberately separate from the full semantic suite.
// It sends only three fixed synthetic fixture transcripts and preserves the exact
// assistant text deltas needed to diagnose DecisionStream protocol errors.
if (!process.argv.includes('--real-model')) {
  throw new Error('真实 dsh 协议样本需显式 --real-model；此脚本会发送 3 个固定合成案例。');
}

const root = path.resolve(import.meta.dirname, '../..');
const ids = ['zh-not-addressed', 'ja-unfinished-think', 'en-closing'];
const suite = JSON.parse(await readFile(path.join(root, 'tests/voice/fixtures/m2-semantic-cases.json'), 'utf8'));
const byId = new Map(suite.cases.map(item => [item.id, item]));
const selected = ids.map(id => {
  const item = byId.get(id);
  if (!item) throw new Error(`FIXTURE_NOT_FOUND:${id}`);
  return item;
});
const observed = {
  schemaVersion: 1,
  observationSource: 'actual dsh configured model; fixed synthetic fixture transcripts',
  cases: [],
  startupErrorCode: null
};
const outputDir = path.join(root, 'outputs/desktop-validation/m2');
const service = new LocalDshSpeech(root);

function keepParserEvents(record, events) {
  for (const event of events) {
    if (event.type === 'header') {
      record.parsedHeader = { action: event.header.action, reason: event.header.reason };
    } else if (event.type === 'error' || event.type === 'violation') {
      record.parserEvents.push({ type: event.type, reason: event.reason });
    }
  }
}

try {
  await service.start();
  for (const item of selected) {
    const context = item.context;
    const route = localDecision(item.input, {
      outputPlaying: context.outputPlaying,
      pausedOutput: context.pausedOutput,
      expectsReply: context.pendingQuestion?.status === 'awaiting'
    });
    if (route !== 'MODEL') throw new Error(`CASE_DID_NOT_ROUTE_TO_MODEL:${item.id}:${route}`);

    const attempts = [];
    const adapterErrors = [];
    let active;
    const parserFor = record => record.parser ??= new DecisionStream();
    const chat = new LocalDshChat(service, root);
    let settlement;
    try {
      const accepted = await chat.runTurn({
        text: item.input,
        personaId: 'nagato-normal-light',
        mode: item.source,
        replyLanguage: item.language,
        visibleHistory: [],
        deliveryState: { attempts: [], pendingQuestion: undefined }
      }, event => {
        if (event.type === 'attempt-start') {
          active = {
            ordinal: attempts.length + 1,
            revision: event.revision,
            rawText: '',
            rawHeaderLine: null,
            rawTextEndsWithNewline: false,
            parserEvents: []
          };
          attempts.push(active);
          return;
        }
        if (event.type === 'text') {
          if (!active) return;
          active.rawText += event.text;
          keepParserEvents(active, parserFor(active).push(event.text));
          return;
        }
        if (event.type === 'attempt-end') {
          if (active) {
            active.outcome = event.outcome;
            keepParserEvents(active, parserFor(active).finish());
            active.finished = true;
          }
          return;
        }
        if (event.type === 'error') adapterErrors.push(event.code);
      });
      settlement = await accepted.completed;
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_:-]{1,96}$/.test(error.message)
        ? error.message : 'REQUEST_FAILED';
      adapterErrors.push(code);
    }

    for (const attempt of attempts) {
      if (!attempt.finished) keepParserEvents(attempt, parserFor(attempt).finish());
      delete attempt.parser;
      attempt.finished = undefined;
      attempt.rawHeaderLine = attempt.rawText.includes('\n')
        ? attempt.rawText.slice(0, attempt.rawText.indexOf('\n'))
        : attempt.rawText || null;
      attempt.rawTextEndsWithNewline = attempt.rawText.endsWith('\n');
    }
    observed.cases.push({
      id: item.id,
      attempts,
      adapterErrors,
      settlement: settlement ? { status: settlement.status, code: settlement.code ?? null } : null
    });
  }
} catch (error) {
  const code = error instanceof Error && /^[A-Z0-9_:-]{1,96}$/.test(error.message)
    ? error.message : 'PROTOCOL_SAMPLE_FAILED';
  observed.startupErrorCode = code;
} finally {
  await service.dispose();
  await mkdir(outputDir, { recursive: true });
  const outPath = path.join(outputDir, 'semantic-protocol-samples-real.json');
  await writeFile(outPath, JSON.stringify(observed, null, 2));
  const summary = observed.cases.map(item => ({
    id: item.id,
    attempts: item.attempts.length,
    parserEvents: item.attempts.flatMap(attempt => attempt.parserEvents).length,
    adapterErrors: item.adapterErrors
  }));
  console.log(JSON.stringify({ startupErrorCode: observed.startupErrorCode, cases: summary }));
  if (observed.startupErrorCode || observed.cases.some(item => item.adapterErrors.length)) process.exitCode = 1;
}
