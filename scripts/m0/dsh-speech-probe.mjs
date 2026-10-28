import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

const root = resolve(import.meta.dirname, '../..');
const providerId = 'sensevoice-local';
const pollMs = 250;
const preparationTimeoutMs = 45 * 60 * 1000;
const defaultIdleTimeoutMs = 5 * 60 * 1000;

function sleep(ms) { return new Promise(resolveSleep => setTimeout(resolveSleep, ms)); }

function safeError(error) {
  const message = String(error?.message ?? error)
    .replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{24,}/g, '[redacted]')
    .replace(/(?:sk-[A-Za-z0-9_-]+)/g, '[redacted]')
    .replace(/(token|cookie|secret|authorization)=[^\s&]+/gi, '$1=[redacted]')
    .replace(/[A-Z]:\\[^\s:]+/g, '[local-path]');
  return message.slice(0, 400);
}

function providerFrom(catalog) {
  return catalog?.providers?.find(provider => provider.id === providerId);
}

function latestCatalog(frames) {
  for (let index = frames.length - 1; index >= 0; index--) {
    const frame = frames[index];
    if (frame?.type === 'item' && frame.value?.providers) return frame.value;
  }
  return undefined;
}

function stateSummary(provider) {
  const preparation = provider?.preparation ?? {};
  return {
    phase: preparation.phase,
    step: preparation.step,
    resource: preparation.phase === 'downloading' ? preparation.resource : undefined,
    completedBytes: preparation.phase === 'downloading' ? preparation.completedBytes : undefined,
    totalBytes: preparation.phase === 'downloading' ? preparation.totalBytes : undefined,
    steps: preparation.steps?.map(({ kind, status }) => ({ kind, status })),
    failureReason: preparation.download?.reason,
    failureCode: preparation.download?.code,
    failureStatus: preparation.download?.status
  };
}

async function waitForProvider(follower, predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const provider = providerFrom(latestCatalog(follower.frames));
    if (provider && predicate(provider)) return provider;
    await sleep(pollMs);
  }
  const provider = providerFrom(latestCatalog(follower.frames));
  throw new Error(`${description} timeout; last phase=${provider?.preparation?.phase ?? 'missing'}`);
}

async function inspectCache() {
  const providerRoot = resolve(root, 'node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice');
  const assets = JSON.parse(await readFile(join(providerRoot, 'runtime/assets.json'), 'utf8'));
  const dataRoot = dshHomePath('speech-to-text', 'sensevoice');
  const files = [
    { kind: 'int8_model', name: assets.models.int8.name, path: join(dataRoot, 'models', 'sensevoice-onnx', assets.models.int8.name), bytes: assets.models.int8.bytes },
    { kind: 'tokens', name: assets.tokens.name, path: join(dataRoot, 'models', 'sensevoice-onnx', assets.tokens.name), bytes: assets.tokens.bytes },
    { kind: 'vad', name: assets.vad.name, path: join(dataRoot, 'models', 'silero', assets.vad.name), bytes: assets.vad.bytes }
  ];
  const inspected = await Promise.all(files.map(async file => {
    try {
      const current = await stat(file.path);
      return { kind: file.kind, name: file.name, exists: current.isFile(), bytes: current.size, expectedBytes: file.bytes };
    } catch {
      return { kind: file.kind, name: file.name, exists: false, bytes: 0, expectedBytes: file.bytes };
    }
  }));
  return {
    files: inspected,
    missingBytes: inspected.filter(file => !file.exists || file.bytes !== file.expectedBytes).reduce((sum, file) => sum + file.expectedBytes, 0),
    complete: inspected.every(file => file.exists && file.bytes === file.expectedBytes)
  };
}

async function configuredIdleTimeoutMs() {
  const patch = await readFile(resolve(root, 'config/voice/dsh-m0.patch.yml'), 'utf8');
  const match = patch.match(/^\s*idleTimeoutMs:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : defaultIdleTimeoutMs;
}

function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('fixture is not a RIFF/WAVE file');
  let offset = 12;
  let format;
  let dataBytes;
  while (offset + 8 <= buffer.length) {
    const tag = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const content = offset + 8;
    if (content + length > buffer.length) throw new Error('fixture WAV chunk exceeds file size');
    if (tag === 'fmt ') {
      format = {
        codec: buffer.readUInt16LE(content),
        channels: buffer.readUInt16LE(content + 2),
        sampleRate: buffer.readUInt32LE(content + 4),
        bitsPerSample: buffer.readUInt16LE(content + 14)
      };
    } else if (tag === 'data') dataBytes = length;
    offset = content + length + (length & 1);
  }
  if (!format || dataBytes === undefined) throw new Error('fixture WAV lacks fmt or data chunk');
  if (format.codec !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bitsPerSample !== 16) {
    throw new Error(`fixture is not PCM16 mono 16 kHz: ${JSON.stringify(format)}`);
  }
  return { ...format, dataBytes, durationSeconds: dataBytes / (format.sampleRate * format.channels * format.bitsPerSample / 8) };
}

function transcriptSummary(text) {
  const normalized = String(text ?? '').trim();
  return {
    nonEmpty: normalized.length > 0,
    characters: [...normalized].length,
    hanCharacters: (normalized.match(/\p{Script=Han}/gu) ?? []).length,
    kanaCharacters: (normalized.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length,
    latinWords: (normalized.match(/[A-Za-z]+/g) ?? []).length
  };
}

export async function runSpeech({ call, open, report }) {
  const speechReport = {
    providerId,
    cpuOnly: true,
    transcriptContentStored: false,
    rawAudioStored: false,
    checks: [],
    preparationTransitions: [],
    transcriptions: []
  };
  report.speech = speechReport;
  let follower;
  let idleStart;

  try {
    const cacheBefore = await inspectCache();
    speechReport.cacheBefore = cacheBefore;
    const initialCatalog = await call('speech/catalog', {});
    const selected = providerFrom(initialCatalog);
    if (!selected) throw new Error(`speech/catalog did not advertise ${providerId}`);
    speechReport.catalog = {
      provider: {
        id: selected.id,
        name: selected.name,
        location: selected.location,
        languages: selected.languages,
        setupEstimate: selected.setupEstimate
      },
      selection: initialCatalog.selection,
      maxAudioBytes: initialCatalog.maxAudioBytes,
      maxDurationSeconds: initialCatalog.maxDurationSeconds,
      initialState: stateSummary(selected)
    };
    speechReport.checks.push({ check: 'catalog', ok: true, state: stateSummary(selected) });

    follower = open('speech/follow', {});
    await follower.until(frame => frame.type === 'item' && Boolean(frame.value?.providers), 30000);
    speechReport.checks.push({ check: 'follow', ok: true, initialState: stateSummary(providerFrom(latestCatalog(follower.frames))) });

    const initial = await waitForProvider(
      follower,
      provider => ['unprepared', 'standby', 'ready', 'failed'].includes(provider.preparation?.phase),
      30000,
      'initial cache inspection'
    );
    speechReport.preparationTransitions.push({ atMs: 0, ...stateSummary(initial) });

    let preparationStart = Date.now();
    if (initial.preparation?.phase === 'unprepared') {
      await call('speech/prepare', { providerId });
      speechReport.checks.push({ check: 'prepare_started', ok: true });
      try {
        const downloading = await waitForProvider(
          follower,
          provider => provider.preparation?.phase === 'downloading',
          120000,
          'preparation download start'
        );
        speechReport.preparationTransitions.push({ atMs: Date.now() - preparationStart, ...stateSummary(downloading) });
        const cancelStart = Date.now();
        await call('speech/cancelPreparation', { providerId });
        const cancelled = await waitForProvider(
          follower,
          provider => ['cancelled', 'unprepared', 'failed'].includes(provider.preparation?.phase),
          30000,
          'preparation cancellation'
        );
        speechReport.checks.push({
          check: 'cancel_preparation',
          attempted: true,
          ok: cancelled.preparation?.phase === 'cancelled',
          ms: Date.now() - cancelStart,
          resultingState: stateSummary(cancelled)
        });
      } catch (error) {
        speechReport.checks.push({ check: 'cancel_preparation', attempted: false, ok: false, reason: safeError(error) });
      }
      preparationStart = Date.now();
      await call('speech/prepare', { providerId });
    } else if (initial.preparation?.phase === 'standby') {
      // With a verified cache, exercise cancellation during worker wake/load rather than redownloading assets.
      await call('speech/prepare', { providerId });
      try {
        const waking = await waitForProvider(
          follower,
          provider => ['waking', 'loading'].includes(provider.preparation?.phase),
          30000,
          'cached worker wake'
        );
        speechReport.preparationTransitions.push({ atMs: Date.now() - preparationStart, ...stateSummary(waking) });
        const cancelStart = Date.now();
        await call('speech/cancelPreparation', { providerId });
        const cancelled = await waitForProvider(
          follower,
          provider => ['cancelled', 'standby', 'failed'].includes(provider.preparation?.phase),
          30000,
          'cached worker cancellation'
        );
        speechReport.checks.push({
          check: 'cancel_preparation',
          attempted: true,
          scope: 'cached_worker_wake',
          ok: cancelled.preparation?.phase === 'cancelled',
          ms: Date.now() - cancelStart,
          resultingState: stateSummary(cancelled)
        });
      } catch (error) {
        speechReport.checks.push({ check: 'cancel_preparation', attempted: false, scope: 'cached_worker_wake', ok: false, reason: safeError(error) });
      }
      preparationStart = Date.now();
      await call('speech/prepare', { providerId });
    } else if (initial.preparation?.phase === 'failed') {
      throw new Error(`provider initial inspection failed: ${initial.preparation.download?.reason ?? initial.preparation.phase}`);
    }

    const ready = await waitForProvider(
      follower,
      provider => ['ready', 'standby'].includes(provider.preparation?.phase),
      preparationTimeoutMs,
      'speech prepare'
    );
    speechReport.preparationTiming = {
      ms: Date.now() - preparationStart,
      mode: cacheBefore.complete ? 'cached_worker_prepare_or_wake' : 'resource_prepare_with_missing_assets',
      resourceCacheCompleteAtProbeEntry: cacheBefore.complete,
      coldDownloadDurationMeasured: false,
      terminalState: stateSummary(ready),
      downloadedBytesByResource: Object.fromEntries(Object.entries(aggregateDownloads(follower.frames)))
    };
    speechReport.checks.push({ check: 'prepare', ok: true, ms: speechReport.preparationTiming.ms, terminalState: ready.preparation.phase });
    speechReport.preparationTransitions.push({ atMs: speechReport.preparationTiming.ms, ...stateSummary(ready) });

    const fixtures = [
      { language: 'zh', file: 'm0-sensevoice-zh.wav' },
      { language: 'en', file: 'm0-sensevoice-en.wav' },
      { language: 'ja', file: 'm0-sensevoice-ja.wav' }
    ];
    for (const fixture of fixtures) {
      const path = resolve(root, 'tests/voice/fixtures', fixture.file);
      const audio = await readFile(path);
      const wav = parseWav(audio);
      if (audio.length > initialCatalog.maxAudioBytes) throw new Error(`${fixture.file} exceeds dsh audio limit`);
      if (wav.durationSeconds > initialCatalog.maxDurationSeconds) throw new Error(`${fixture.file} exceeds dsh duration limit`);
      const startedAt = Date.now();
      try {
        const result = await call('speech/transcribe', {
          request: { audioBase64: audio.toString('base64'), providerId, language: fixture.language }
        });
        const wallMs = Date.now() - startedAt;
        const summary = transcriptSummary(result.text);
        speechReport.transcriptions.push({
          language: fixture.language,
          fixture: fixture.file,
          wav: { sampleRate: wav.sampleRate, channels: wav.channels, bitsPerSample: wav.bitsPerSample, durationSeconds: Number(wav.durationSeconds.toFixed(3)), bytes: audio.length },
          result: { ...summary, audioSeconds: result.audioSeconds, inferenceSeconds: result.inferenceSeconds, wallMs },
          confidenceFieldPresent: Object.hasOwn(result, 'confidence')
        });
      } catch (error) {
        speechReport.transcriptions.push({
          language: fixture.language,
          fixture: fixture.file,
          wav: { sampleRate: wav.sampleRate, channels: wav.channels, bitsPerSample: wav.bitsPerSample, durationSeconds: Number(wav.durationSeconds.toFixed(3)), bytes: audio.length },
          error: safeError(error),
          wallMs: Date.now() - startedAt
        });
      }
    }
    const firstZh = speechReport.transcriptions.find(result => result.language === 'zh' && result.result);
    if (firstZh) {
      const path = resolve(root, 'tests/voice/fixtures/m0-sensevoice-zh.wav');
      const audio = await readFile(path);
      const startedAt = Date.now();
      try {
        const result = await call('speech/transcribe', {
          request: { audioBase64: audio.toString('base64'), providerId, language: 'zh' }
        });
        speechReport.warmRepeat = {
          language: 'zh',
          result: { ...transcriptSummary(result.text), audioSeconds: result.audioSeconds, inferenceSeconds: result.inferenceSeconds, wallMs: Date.now() - startedAt },
          confidenceFieldPresent: Object.hasOwn(result, 'confidence')
        };
      } catch (error) {
        speechReport.warmRepeat = { language: 'zh', error: safeError(error), wallMs: Date.now() - startedAt };
      }
    }
    speechReport.checks.push({
      check: 'transcribe_languages',
      ok: speechReport.transcriptions.length === 3 && speechReport.transcriptions.every(result => result.result?.nonEmpty),
      languages: speechReport.transcriptions.map(result => ({ language: result.language, nonEmpty: result.result?.nonEmpty ?? false, error: result.error }))
    });
    speechReport.cancellationLimits = {
      preparationCancellationTested: speechReport.checks.some(check => check.check === 'cancel_preparation' && check.ok),
      transcriptionCancellationTested: false,
      reason: 'The provided call adapter performs a non-stream HTTP Remote request without an AbortSignal parameter; only the preparation cancellation Remote is exposed to this probe.'
    };

    const effectiveIdleTimeoutMs = await configuredIdleTimeoutMs();
    if (effectiveIdleTimeoutMs === 0) {
      speechReport.idleTimeout = {
        tested: false,
        observed: false,
        configuredMs: 0,
        interpretation: 'The M0 host patch explicitly disables idle worker reclamation (0 means retain until provider release); non-zero timeout reclamation was not tested.'
      };
      speechReport.checks.push({ check: 'idle_timeout', tested: false, configuredMs: 0 });
    } else {
      idleStart = Date.now();
      const returnedToStandby = await waitForProvider(
        follower,
        provider => provider.preparation?.phase === 'standby',
        effectiveIdleTimeoutMs + 60000,
        'idle worker release'
      );
      speechReport.idleTimeout = {
        tested: true,
        observed: true,
        elapsedMs: Date.now() - idleStart,
        configuredMs: effectiveIdleTimeoutMs,
        state: stateSummary(returnedToStandby)
      };
      speechReport.checks.push({ check: 'idle_timeout', ok: true, ms: speechReport.idleTimeout.elapsedMs, phase: returnedToStandby.preparation.phase });
    }
  } catch (error) {
    speechReport.fatal = safeError(error);
    speechReport.checks.push({ check: 'speech_probe', ok: false, reason: speechReport.fatal });
    throw error;
  } finally {
    if (follower) follower.close();
  }
}

function aggregateDownloads(frames) {
  const totals = {};
  for (const frame of frames) {
    const provider = providerFrom(frame?.type === 'item' ? frame.value : undefined);
    const preparation = provider?.preparation;
    if (preparation?.phase !== 'downloading') continue;
    const key = preparation.resource ?? 'unknown';
    const observed = Number(preparation.completedBytes) || 0;
    totals[key] = Math.max(totals[key] ?? 0, observed);
  }
  return totals;
}
