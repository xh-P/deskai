import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { LocalTtsService, decodePCMFrame, validateRequest, type SynthesisRequest, type VoiceInfo } from '../../packages/tts-adapter/src/index.ts';

const request: SynthesisRequest = { sessionId: 'session', turnId: 'turn', generationId: 2, voiceRevision: 0,
  segmentId: 'segment-attempt-1', voiceId: 'nagato-normal-v2', referenceId: 'ref-01', text: '你好。', language: 'all_zh' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function pcm(overrides: object = {}, rate = 32000): Buffer {
  const header = Buffer.from(JSON.stringify({ v: 1, event: 'audio.chunk', requestId: 'r', ...request,
    chunkSeq: 0, sampleRate: rate, channels: 1, format: 'pcm_s16le', samples: 2, ...overrides }));
  const length = Buffer.alloc(4); length.writeUInt32LE(header.length);
  return Buffer.concat([length, header, Buffer.from([1, 0, 255, 127])]);
}

test('PCM accepts 32/48 kHz and preserves immutable request identity', () => {
  for (const rate of [32000, 48000]) {
    const chunk = decodePCMFrame(pcm({}, rate), 'r', request, 0);
    assert.equal(chunk.sampleRate, rate); assert.deepEqual([...chunk.pcm], [1, 0, 255, 127]);
  }
  for (const override of [{ generationId: 1 }, { voiceRevision: 1 }, { segmentId: 'stale-attempt' }, { requestId: 'old' },
    { voiceId: 'other' }, { referenceId: 'other' }, { samples: 3 }, { channels: 2 }, { format: 'float32' },
    { chunkSeq: 1 }, { samples: 0 }, { sampleRate: 16000 }]) {
    assert.throws(() => decodePCMFrame(pcm(override), 'r', request, 0), /INVALID_TTS_PCM/);
  }
  for (const bytes of [Buffer.alloc(0), Buffer.from([255, 255, 255, 127]), pcm().subarray(0, 10), pcm().subarray(0, -1)])
    assert.throws(() => decodePCMFrame(bytes, 'r', request, 0), /INVALID_TTS_PCM/);
});

test('request validation rejects ambiguous revisions, paths, oversized text and unsupported speed', () => {
  validateRequest(request);
  for (const changes of [{ generationId: true }, { voiceRevision: -1 }, { text: ' ' }, { text: 'a'.repeat(601) },
    { language: 'auto' }, { speed: Number.NaN }, { speed: 2.01 }, { referenceId: '' }])
    assert.throws(() => validateRequest({ ...request, ...changes } as SynthesisRequest), /INVALID_TTS_REQUEST/);
});

async function fixture(onMessage: (frame: Record<string, unknown>, socket: WebSocket) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connection = once(server, 'connection');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const [peer] = await connection as [WebSocket];
  peer.on('message', (raw) => onMessage(JSON.parse(raw.toString()), peer));
  await once(socket, 'open');
  const service = new LocalTtsService('.');
  // Drive the real adapter over loopback WS without loading a GPU or spawning Python.
  const internal = service as unknown as { socket: WebSocket; starting: Promise<VoiceInfo[]>; current: object;
    catalog: VoiceInfo[]; receive: (raw: WebSocket.RawData, binary: boolean) => void };
  internal.socket = socket; internal.starting = Promise.resolve([]);
  internal.current = { state: 'ready', voiceId: request.voiceId, referenceId: request.referenceId, voiceRevision: 0 };
  internal.catalog = [{ id: request.voiceId, name: 'normal', version: 'v2', defaultReferenceId: 'ref-01',
    references: [{ id: 'ref-01', name: 'default' }, { id: 'ref-02', name: 'alternate' }] }];
  socket.on('message', (raw, binary) => internal.receive(raw, binary));
  return { service, close: async () => { await service.dispose(); peer.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

test('adapter streams once, rejects concurrent GPU work and verifies completion counters', async () => {
  let complete: (() => void) | undefined;
  const started = deferred();
  const fixtureState = await fixture((frame, socket) => {
    if (frame.op !== 'synthesize') return;
    socket.send(pcm({ requestId: frame.requestId }));
    complete = () => socket.send(JSON.stringify({ v: 1, event: 'synthesis.completed', ...request,
      requestId: frame.requestId, chunks: 1, samples: 2, canceled: false }));
    started.resolve();
  });
  try {
    const chunks: number[] = [];
    const synthesizing = fixtureState.service.synthesize(request, (chunk) => chunks.push(chunk.chunkSeq));
    await started.promise;
    await assert.rejects(fixtureState.service.synthesize(request, () => {}), /TTS_BUSY/);
    complete!();
    const result = await synthesizing;
    assert.equal(result.canceled, false); assert.deepEqual(chunks, [0]);
  } finally { await fixtureState.close(); }
});

test('cancel suppresses late PCM, waits for worker settlement, then permits the next generation', async () => {
  let synthesis: Record<string, unknown> = {};
  let count = 0;
  const started = deferred();
  const fixtureState = await fixture((frame, socket) => {
    if (frame.op === 'synthesize') {
      synthesis = frame;
      if (count++ === 0) { started.resolve(); return; }
      socket.send(pcm({ requestId: frame.requestId, generationId: frame.generationId }));
      socket.send(JSON.stringify({ v: 1, event: 'synthesis.completed', ...request, generationId: frame.generationId,
        requestId: frame.requestId, chunks: 1, samples: 2, canceled: false }));
    }
    if (frame.op === 'cancel') {
      socket.send(JSON.stringify({ v: 1, event: 'cancel.accepted', requestId: frame.requestId, matched: true }));
      socket.send(pcm({ requestId: synthesis.requestId }));
      socket.send(JSON.stringify({ v: 1, event: 'synthesis.completed', ...request,
        requestId: synthesis.requestId, chunks: 1, samples: 2, canceled: true }));
    }
  });
  try {
    const chunks: number[] = [];
    const synthesisPromise = fixtureState.service.synthesize(request, () => chunks.push(1));
    await started.promise; await fixtureState.service.cancel();
    assert.equal((await synthesisPromise).canceled, true); assert.equal(chunks.length, 0);
    assert.equal((await fixtureState.service.synthesize({ ...request, generationId: 3 }, () => chunks.push(1))).canceled, false);
    assert.deepEqual(chunks, [1]);
  } finally { await fixtureState.close(); }
});

test('corrupt PCM fails the request and closes the owned transport', async () => {
  const fixtureState = await fixture((frame, socket) => socket.send(pcm({ requestId: frame.requestId, voiceRevision: 999 })));
  try { await assert.rejects(fixtureState.service.synthesize(request, () => assert.fail('invalid audio escaped')), /INVALID_TTS_PCM/); }
  finally { await fixtureState.close(); }
});

test('failed voice/reference switch preserves the warmed previous revision and can recover', async () => {
  let switches = 0;
  const fixtureState = await fixture((frame, socket) => {
    if (frame.op !== 'selectVoice') return;
    if (switches++ === 0) socket.send(JSON.stringify({ v: 1, event: 'voice.failed', requestId: frame.requestId,
      state: 'ready', voiceId: request.voiceId, referenceId: 'ref-01', voiceRevision: 0, code: 'VOICE_SWITCH_FAILED' }));
    else socket.send(JSON.stringify({ v: 1, event: 'voice.selected', requestId: frame.requestId,
      state: 'ready', voiceId: request.voiceId, referenceId: 'ref-02', voiceRevision: 1 }));
  });
  try {
    await assert.rejects(fixtureState.service.selectVoice(request.voiceId, 'ref-02'), /VOICE_SWITCH_FAILED/);
    assert.equal(fixtureState.service.getStatus().state, 'ready');
    assert.equal(fixtureState.service.getStatus().voiceRevision, 0);
    assert.deepEqual(await fixtureState.service.selectVoice(request.voiceId, 'ref-02'),
      { voiceId: request.voiceId, referenceId: 'ref-02', voiceRevision: 1 });
    await assert.rejects(fixtureState.service.synthesize(request, () => {}), /STALE_VOICE_SELECTION/);
  } finally { await fixtureState.close(); }
});

test('AbortSignal cancels on the worker and never delivers late PCM', async () => {
  let synthesis: Record<string, unknown> = {};
  const started = deferred();
  const fixtureState = await fixture((frame, socket) => {
    if (frame.op === 'synthesize') { synthesis = frame; started.resolve(); }
    if (frame.op === 'cancel') {
      socket.send(JSON.stringify({ v: 1, event: 'cancel.accepted', requestId: frame.requestId, matched: true }));
      socket.send(pcm({ requestId: synthesis.requestId }));
      socket.send(JSON.stringify({ v: 1, event: 'synthesis.completed', ...request,
        requestId: synthesis.requestId, chunks: 0, samples: 0, canceled: true }));
    }
  });
  try {
    const controller = new AbortController();
    const synthesizing = fixtureState.service.synthesize(request, () => assert.fail('late PCM delivered'), controller.signal);
    const rejected = assert.rejects(synthesizing, { name: 'AbortError' });
    await started.promise; controller.abort(); await rejected;
  } finally { await fixtureState.close(); }
});
