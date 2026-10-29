import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import RemoteSpeech from "@deepseek-ai/dsh-experimental-api-speech-to-text";
import { validateWave } from "@deepseek-ai/dsh-experimental-speech-to-text/wave";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixturesDir = join(root, "tests", "voice", "fixtures");
const configPath = join(root, "config", "voice", "dsh-m0.patch.yml");
const outputDir = join(root, "outputs", "desktop-validation", "voice-flow-20261030");
const baseline = {
  threads: 4,
  maxAudioBytes: 4 * 1024 * 1024,
  vadThreshold: 0.5,
  minSpeechSeconds: 0.25,
  minSilenceSeconds: 0.5,
  vadOnsetPaddingSeconds: 0.3,
  segmentSeconds: 30,
};
const numericConfigKeys = Object.keys(baseline);
const sampleRate = 16_000;
const sampleNames = ["m0-sensevoice-zh.wav", "m0-sensevoice-ja.wav", "m0-sensevoice-en.wav"];
let activeWorker;
let interrupted = false;

function selectedMode(argv) {
  const index = argv.indexOf("--mode");
  const mode = index < 0 ? "baseline" : argv[index + 1];
  if (mode !== "baseline" && mode !== "candidate") {
    throw new Error("Use --mode baseline or --mode candidate.");
  }
  if (index >= 0 && argv[index + 2] !== undefined && argv[index + 2].startsWith("--") === false) {
    throw new Error("Unexpected argument after --mode.");
  }
  return mode;
}

async function explicitNumericValues(id, keys) {
  const source = await readFile(configPath, "utf8");
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s*- id:\\s*${id}\\s*$`).test(line));
  if (start < 0) throw new Error(`Could not find the ${id} section in config/voice/dsh-m0.patch.yml.`);
  const indent = lines[start].match(/^\s*/)[0].length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)- id:/);
    if (match && match[1].length === indent) {
      end = index;
      break;
    }
  }
  const block = lines.slice(start + 1, end).join("\n");
  const values = {};
  for (const key of keys) {
    const match = block.match(new RegExp(`^\\s*${key}\\s*:\\s*([+-]?(?:\\d+\\.?\\d*|\\.\\d+))(?:\\s+#.*)?\\s*$`, "m"));
    if (match) values[key] = Number(match[1]);
  }
  return values;
}

async function parametersFor(mode) {
  if (mode === "baseline") {
    const sources = Object.fromEntries(numericConfigKeys.map((key) => [key, "installed provider default"]));
    sources.threads = "task baseline (4 threads)";
    return { ...baseline, sources };
  }

  const candidate = { ...baseline };
  const sources = Object.fromEntries(numericConfigKeys.map((key) => [key, "installed provider default"]));
  sources.threads = "task baseline (4 threads)";
  const explicit = await explicitNumericValues("speech-to-text-sensevoice", numericConfigKeys);
  for (const [key, value] of Object.entries(explicit)) {
    candidate[key] = value;
    sources[key] = "explicit value in config/voice/dsh-m0.patch.yml";
  }
  return { ...candidate, sources };
}

async function remoteConfigFor(mode) {
  const values = mode === "candidate"
    ? await explicitNumericValues("api-speech-to-text", ["maxAudioBytes", "maxDurationSeconds"])
    : { maxAudioBytes: baseline.maxAudioBytes, maxDurationSeconds: 120 };
  if (!Number.isFinite(values.maxAudioBytes) || !Number.isFinite(values.maxDurationSeconds)) {
    throw new Error("Remote speech byte and duration limits must be explicit numeric config values.");
  }
  return RemoteSpeech.Config(values);
}

function parsePcm16Wav(bytes, name) {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${name} is not a RIFF/WAVE file.`);
  }
  let format;
  let channels;
  let rate;
  let bits;
  let pcm;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > bytes.length) throw new Error(`${name} has a truncated WAV chunk.`);
    if (id === "fmt " && size >= 16) {
      format = bytes.readUInt16LE(bodyStart);
      channels = bytes.readUInt16LE(bodyStart + 2);
      rate = bytes.readUInt32LE(bodyStart + 4);
      bits = bytes.readUInt16LE(bodyStart + 14);
    }
    if (id === "data") pcm = bytes.subarray(bodyStart, bodyEnd);
    offset = bodyEnd + (size % 2);
  }
  if (format !== 1 || channels !== 1 || rate !== sampleRate || bits !== 16 || !pcm || pcm.length % 2 !== 0) {
    throw new Error(`${name} must be PCM16, 16 kHz, mono WAV.`);
  }
  return { name, pcm, durationSeconds: pcm.length / (sampleRate * 2) };
}

function makePcm16Wav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function getSamples(pcm) {
  const samples = new Float32Array(pcm.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = pcm.readInt16LE(index * 2) / 32768;
  }
  return samples;
}

function segmentWithVad(input, parameters, modelPath) {
  const require = createRequire(import.meta.url);
  const sherpa = require("sherpa-onnx-node");
  const detector = new sherpa.Vad({
    sileroVad: {
      model: modelPath,
      threshold: parameters.vadThreshold,
      minSilenceDuration: parameters.minSilenceSeconds,
      minSpeechDuration: parameters.minSpeechSeconds,
      maxSpeechDuration: parameters.segmentSeconds,
      windowSize: 512,
    },
    sampleRate,
    numThreads: parameters.threads,
    provider: "cpu",
    debug: 0,
  }, parameters.segmentSeconds + parameters.minSilenceSeconds + 1);

  const samples = getSamples(input.pcm);
  const segments = [];
  const onsetPadding = Math.round(parameters.vadOnsetPaddingSeconds * sampleRate);
  let firstSegment = true;
  const drain = () => {
    while (!detector.isEmpty()) {
      const segment = detector.front(false);
      const start = segment.start;
      const end = start + segment.samples.length;
      const padding = firstSegment ? Math.min(start, onsetPadding) : 0;
      segments.push({
        startSeconds: start / sampleRate,
        endSeconds: end / sampleRate,
        paddedStartSeconds: (start - padding) / sampleRate,
        paddedEndSeconds: end / sampleRate,
        onsetPaddingSeconds: padding / sampleRate,
      });
      firstSegment = false;
      detector.pop();
    }
  };
  for (let offset = 0; offset < samples.length; offset += 512) {
    detector.acceptWaveform(samples.subarray(offset, offset + 512));
    drain();
  }
  detector.flush();
  drain();
  return segments;
}

function countMatches(text, expression) {
  return [...text.matchAll(expression)].length;
}

function summarizeTranscript(text) {
  return {
    textLengthCodePoints: [...text].length,
    hanCount: countMatches(text, /\p{Script=Han}/gu),
    kanaCount: countMatches(text, /\p{Script=Hiragana}|\p{Script=Katakana}/gu),
    latinCount: countMatches(text, /\p{Script=Latin}/gu),
    nonEmpty: text.trim().length > 0,
    textSha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

async function runBoundaryChecks(port, token, remoteConfig, input, parameters, vadPath) {
  const durationSamples = remoteConfig.maxDurationSeconds * sampleRate;
  if (!Number.isInteger(durationSamples) || input.pcm.length > durationSamples * 2) {
    throw new Error("The fixture cannot be padded to the configured legal duration boundary.");
  }
  const exactPcm = Buffer.concat([input.pcm, Buffer.alloc(durationSamples * 2 - input.pcm.length)]);
  const exactWav = makePcm16Wav(exactPcm);
  const overWav = makePcm16Wav(Buffer.concat([exactPcm, Buffer.alloc(2)]));

  let validatorExactSeconds;
  let validatorExactAccepted = false;
  try {
    validatorExactSeconds = validateWave(exactWav, remoteConfig.maxDurationSeconds);
    validatorExactAccepted = true;
  } catch {}
  let validatorOverRejected = false;
  try {
    validateWave(overWav, remoteConfig.maxDurationSeconds);
  } catch {
    validatorOverRejected = true;
  }

  const exactSegments = segmentWithVad({ name: "zh padded to Remote duration limit (memory only)", pcm: exactPcm }, parameters, vadPath);
  const exactStarted = performance.now();
  const exactResponse = await fetch(`http://127.0.0.1:${port}/transcribe?language=auto`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "audio/wav" },
    body: exactWav,
    signal: AbortSignal.timeout(120_000),
  });
  let exactResult;
  if (exactResponse.ok) {
    try {
      exactResult = await exactResponse.json();
    } catch {
      throw new Error("ASR worker returned an invalid exact-boundary response.");
    }
  }
  const exactWallMs = performance.now() - exactStarted;
  if (exactResult && (typeof exactResult.text !== "string" || !Number.isFinite(exactResult.inferenceSeconds))) {
    throw new Error("ASR worker returned an incomplete exact-boundary response.");
  }
  const exactTranscript = exactResult ? summarizeTranscript(exactResult.text) : undefined;
  if (exactResult) exactResult.text = "";

  const overResponse = await fetch(`http://127.0.0.1:${port}/transcribe?language=auto`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "audio/wav" },
    body: overWav,
    signal: AbortSignal.timeout(120_000),
  });

  return {
    remoteConfig: {
      maxAudioBytes: remoteConfig.maxAudioBytes,
      maxDurationSeconds: remoteConfig.maxDurationSeconds,
      publicConfigParsed: true,
    },
    validator: {
      exactBytes: exactWav.length,
      exactAccepted: validatorExactAccepted,
      exactSeconds: validatorExactSeconds,
      oneSampleOverBytes: overWav.length,
      oneSampleOverRejected: validatorOverRejected,
    },
    workerHttp: {
      exactStatus: exactResponse.status,
      exactWallMs,
      exactInferenceMs: exactResult ? exactResult.inferenceSeconds * 1000 : null,
      exactVADSegments: exactSegments.length,
      exactTextNonEmpty: exactTranscript?.nonEmpty ?? null,
      exactTextLengthCodePoints: exactTranscript?.textLengthCodePoints ?? null,
      exactHanCount: exactTranscript?.hanCount ?? null,
      exactKanaCount: exactTranscript?.kanaCount ?? null,
      exactLatinCount: exactTranscript?.latinCount ?? null,
      exactTextSha256: exactTranscript?.textSha256 ?? null,
      oneSampleOverStatus: overResponse.status,
    },
    byteCapMatchesRemoteConfig: remoteConfig.maxAudioBytes === parameters.maxAudioBytes,
  };
}

function startWorker(workerPath, config, dataRoot) {
  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [workerPath, JSON.stringify(config)], {
    cwd: dataRoot,
    env: { ...process.env, DSH_SPEECH_TOKEN: token, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  activeWorker = { child, closed };
  child.stderr.resume();

  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Worker did not become ready within 120 seconds.")), 120_000);
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve({ port, token });
    };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, newline));
        if (!Number.isInteger(value.port) || value.port < 1) throw new Error();
        finish(undefined, value.port);
      } catch {
        finish(new Error("Worker returned an invalid readiness response."));
      }
    };
    const onError = () => finish(new Error("Could not start the local ASR worker."));
    const onClose = (code) => finish(new Error(`Worker exited before readiness (code ${code ?? "unknown"}).`));
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function stopWorker(worker) {
  if (!worker) return null;
  const { child, closed } = worker;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  let timer;
  const result = await Promise.race([
    closed,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5_000); }),
  ]);
  clearTimeout(timer);
  if (result) return result;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  return closed;
}

function formatSeconds(value) {
  return value.toFixed(3);
}

function renderReport(report) {
  const lines = [
    `# ASR 边界探针：${report.mode}`,
    "",
    `- 状态：${report.status}`,
    `- 运行时间（UTC）：${report.startedAt}`,
    ...(Number.isFinite(report.workerStartupMs) ? [`- 本地 worker 启动与模型加载：${report.workerStartupMs.toFixed(1)} ms`] : []),
    `- 识别：SenseVoiceSmall int8，本地 CPU，固定请求语言 auto；未使用云模型、GPU 或麦克风。`,
    `- 输入：tests/voice/fixtures 下现有合成 WAV；复合样本仅在内存中拼接两份中文 WAV 与 700 ms 零值静音。`,
    `- 文字隐私：未写入转写正文或音频；仅记录字符统计、SHA-256 与是否非空。字符计数不是准确率。`,
    "",
    "## 参数",
    "",
    "| 参数 | 数值 | 来源 |",
    "|---|---:|---|",
  ];
  for (const key of numericConfigKeys) lines.push(`| ${key} | ${report.parameters[key]} | ${report.parameters.sources[key]} |`);
  lines.push("", "## 请求结果", "", "| 类型 | 输入 | 音频秒数 | VAD 段数 | wall ms | inference ms | 文本码点数 | 汉字 | 假名 | 拉丁字母 | 预期 | 非空 | 文本 SHA-256 |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|:---:|---|");
  for (const row of report.rows) {
    const text = row.transcript;
    lines.push(`| ${row.kind} | ${row.name} | ${formatSeconds(row.durationSeconds)} | ${row.segments.length} | ${row.wallMs.toFixed(1)} | ${row.inferenceMs.toFixed(1)} | ${text.textLengthCodePoints} | ${text.hanCount} | ${text.kanaCount} | ${text.latinCount} | ${row.requiredNonEmpty ? "非空" : "空"} | ${text.nonEmpty ? "是" : "否"} | ${text.textSha256} |`);
  }
  const emptyRequiredRows = report.rows.filter((row) => row.requiredNonEmpty && !row.transcript.nonEmpty);
  const nonEmptyExpectedEmptyRows = report.rows.filter((row) => !row.requiredNonEmpty && row.transcript.nonEmpty);
  lines.push(
    "",
    "## 非空检查",
    "",
    emptyRequiredRows.length === 0 && nonEmptyExpectedEmptyRows.length === 0 && report.rows.length > 0
      ? `要求非空的 ${report.rows.filter((row) => row.requiredNonEmpty).length} 项语音转写均非空；预期空文本的控制输入按空文本单独判定。这不代表识别准确率。`
      : emptyRequiredRows.length > 0 || nonEmptyExpectedEmptyRows.length > 0
        ? `语音空转写 ${emptyRequiredRows.length} 项、预期空文本但返回非空 ${nonEmptyExpectedEmptyRows.length} 项。探针运行完成不代表通过，**不得标记为通过**。`
        : "没有完成转写请求，无法判定非空。",
  );
  if (report.boundaryChecks) {
    const checks = report.boundaryChecks;
    lines.push(
      "",
      "## 20 秒输入边界",
      "",
      `- 本地公开 Remote Config schema：已解析，maxAudioBytes=${checks.remoteConfig.maxAudioBytes}，maxDurationSeconds=${checks.remoteConfig.maxDurationSeconds}。`,
      `- 本地公开 validateWave：精确边界 ${checks.validator.exactBytes} bytes / ${checks.validator.exactSeconds ?? "—"} s 接受=${checks.validator.exactAccepted}；多 1 sample（${checks.validator.oneSampleOverBytes} bytes）拒绝=${checks.validator.oneSampleOverRejected}。`,
      `- 本探针专属 worker HTTP：精确边界状态=${checks.workerHttp.exactStatus}、wall=${checks.workerHttp.exactWallMs.toFixed(1)} ms、inference=${checks.workerHttp.exactInferenceMs?.toFixed(1) ?? "—"} ms、VAD 段数=${checks.workerHttp.exactVADSegments}、非空=${checks.workerHttp.exactTextNonEmpty}；多 1 sample 状态=${checks.workerHttp.oneSampleOverStatus}。`,
      "- 检查范围仅含公开配置 schema、validateWave 与本探针 worker 的大小限制；未运行完整 dsh Remote/RPC 链路。",
    );
  }
  if (report.assertions) {
    lines.push("", "## Candidate 结构断言", "", `判定：${report.acceptanceStatus}。`, "", "| 断言 | 结果 |", "|---|:---:|");
    for (const assertion of report.assertions) lines.push(`| ${assertion.name} | ${assertion.passed ? "通过" : "失败"} |`);
    if (report.acceptanceStatus !== "通过（结构检查，不代表准确率）") {
      lines.push("", "探针运行完成不代表通过，**不得标记为通过**。");
    }
  }
  lines.push("", "## VAD 分段与首段起音回填", "", "起止为 VAD 返回样本位置；“回填后起点”按 worker 实际逻辑只对整个请求的第一段回填 `vadOnsetPaddingSeconds`，后续段不回填。时间单位为相对输入起点的秒。", "");
  for (const row of report.rows) {
    lines.push(`### ${row.name}`, "", "| 段 | VAD 起点 | VAD 终点 | 回填后起点 | 回填后终点 | 实际首段回填 |", "|---:|---:|---:|---:|---:|---:|");
    if (row.segments.length === 0) lines.push("| — | — | — | — | — | — |");
    row.segments.forEach((segment, index) => {
      lines.push(`| ${index + 1} | ${formatSeconds(segment.startSeconds)} | ${formatSeconds(segment.endSeconds)} | ${formatSeconds(segment.paddedStartSeconds)} | ${formatSeconds(segment.paddedEndSeconds)} | ${formatSeconds(segment.onsetPaddingSeconds)} s |`);
    });
    lines.push("");
  }
  if (report.failure) lines.push("## 运行异常", "", report.failure, "");
  if (report.workerExit) lines.push(`- Worker 退出：code=${report.workerExit.code ?? "null"}, signal=${report.workerExit.signal ?? "null"}`);
  lines.push("", "## 限制", "", "这些文件是合成 fixture，不能代表真人语音、真实房间、麦克风采集或回声环境。本探针不做主观听校，不据字符长度/hash 推断识别质量。", "");
  return lines.join("\n");
}

async function main() {
  const mode = selectedMode(process.argv.slice(2));
  const parameters = await parametersFor(mode);
  const remoteConfig = await remoteConfigFor(mode);
  const dataRoot = dshHomePath("speech-to-text", "sensevoice");
  const modelPath = join(dataRoot, "models", "sensevoice-onnx", "model.int8.onnx");
  const tokensPath = join(dataRoot, "models", "sensevoice-onnx", "tokens.txt");
  const vadPath = join(dataRoot, "models", "silero", "silero_vad.onnx");
  const report = {
    mode,
    status: "未完成",
    startedAt: new Date().toISOString(),
    parameters,
    rows: [],
  };
  const modeSuffix = mode === "baseline" ? "baseline" : "candidate";
  const reportPath = join(outputDir, `asr-boundary-probe-${modeSuffix}-20261030.md`);
  let worker;

  try {
    if (interrupted) throw new Error("Interrupted before starting the probe.");
    for (const [path, label] of [[dataRoot, "SenseVoice data root"], [modelPath, "SenseVoice int8 model"], [tokensPath, "SenseVoice tokens"], [vadPath, "Silero VAD model"]]) {
      if (!existsSync(path)) throw new Error(`Missing required local asset: ${label}.`);
    }
    const fixtures = [];
    for (const name of sampleNames) {
      const bytes = await readFile(join(fixturesDir, name));
      fixtures.push({ ...parsePcm16Wav(bytes, name), kind: "语音fixture", requiredNonEmpty: true });
    }
    const chinese = fixtures[0];
    const silence = Buffer.alloc(Math.round(0.7 * sampleRate) * 2);
    const compositePcm = Buffer.concat([chinese.pcm, silence, chinese.pcm]);
    fixtures.push({
      name: "m0-sensevoice-zh+700ms-silence+zh.wav (memory only)",
      pcm: compositePcm,
      durationSeconds: compositePcm.length / (sampleRate * 2),
      kind: "语音fixture",
      requiredNonEmpty: true,
    });
    if (mode === "candidate") {
      const silencePcm = Buffer.alloc(sampleRate * 2);
      fixtures.push({
        name: "1s-zero-silence-control (memory only)",
        pcm: silencePcm,
        durationSeconds: 1,
        kind: "静音控制",
        requiredNonEmpty: false,
      });
    }

    const workerPath = join(root, "node_modules", "@deepseek-ai", "dsh-experimental-speech-to-text-sensevoice", "lib", "worker.js");
    const config = {
      dataRoot,
      modelDirectory: dirname(modelPath),
      vadModelPath: vadPath,
      precision: "int8",
      threads: parameters.threads,
      segmentSeconds: parameters.segmentSeconds,
      vadThreshold: parameters.vadThreshold,
      minSpeechSeconds: parameters.minSpeechSeconds,
      minSilenceSeconds: parameters.minSilenceSeconds,
      vadOnsetPaddingSeconds: parameters.vadOnsetPaddingSeconds,
      maxAudioBytes: parameters.maxAudioBytes,
      model: modelPath,
      tokens: tokensPath,
      vad: vadPath,
    };
    const workerStart = performance.now();
    const ready = await startWorker(workerPath, config, dataRoot);
    worker = activeWorker;
    report.workerStartupMs = performance.now() - workerStart;

    for (const input of fixtures) {
      if (interrupted) throw new Error("Probe interrupted.");
      const segments = segmentWithVad(input, parameters, vadPath);
      const started = performance.now();
      const response = await fetch(`http://127.0.0.1:${ready.port}/transcribe?language=auto`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ready.token}`,
          "content-type": "audio/wav",
        },
        body: makePcm16Wav(input.pcm),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`ASR request failed with HTTP ${response.status}.`);
      let result;
      try {
        result = await response.json();
      } catch {
        throw new Error("ASR worker returned an invalid response.");
      }
      if (typeof result.text !== "string" || !Number.isFinite(result.inferenceSeconds)) {
        throw new Error("ASR worker returned an incomplete response.");
      }
      const wallMs = performance.now() - started;
      report.rows.push({
        name: input.name,
        kind: input.kind,
        requiredNonEmpty: input.requiredNonEmpty,
        durationSeconds: input.durationSeconds,
        segments,
        wallMs,
        inferenceMs: result.inferenceSeconds * 1000,
        transcript: summarizeTranscript(result.text),
      });
      result.text = "";
    }
    if (mode === "candidate") {
      report.boundaryChecks = await runBoundaryChecks(ready.port, ready.token, remoteConfig, fixtures[0], parameters, vadPath);
      const speechRows = report.rows.filter((row) => row.requiredNonEmpty);
      const silenceRow = report.rows.find((row) => row.kind === "静音控制");
      const boundary = report.boundaryChecks;
      report.assertions = [
        {
          name: "四份语音输入各恰有 1 个 VAD 段",
          passed: speechRows.length === 4 && speechRows.every((row) => row.segments.length === 1),
        },
        {
          name: "四份语音输入均为非空文本",
          passed: speechRows.length === 4 && speechRows.every((row) => row.transcript.nonEmpty),
        },
        {
          name: "1 秒静音控制为 0 个 VAD 段且空文本",
          passed: silenceRow !== undefined && silenceRow.segments.length === 0 && !silenceRow.transcript.nonEmpty,
        },
        {
          name: "公开 Remote Config 与 validateWave 接受 20 秒并拒绝多 1 sample",
          passed: boundary.remoteConfig.publicConfigParsed
            && boundary.byteCapMatchesRemoteConfig
            && boundary.validator.exactAccepted
            && boundary.validator.exactSeconds === 20
            && boundary.validator.oneSampleOverRejected,
        },
        {
          name: "专属 worker 接受精确字节上限并以 413 拒绝超限 1 sample",
          passed: boundary.workerHttp.exactStatus === 200
            && boundary.workerHttp.exactVADSegments === 1
            && boundary.workerHttp.oneSampleOverStatus === 413,
        },
      ];
      report.acceptanceStatus = report.assertions.every((assertion) => assertion.passed)
        ? "通过（结构检查，不代表准确率）"
        : "未通过";
    }
    report.status = "完成";
  } catch (error) {
    report.status = "失败";
    report.failure = error instanceof Error ? error.message : "Unknown probe failure.";
  } finally {
    report.workerExit = await stopWorker(worker ?? activeWorker);
    activeWorker = undefined;
    await mkdir(outputDir, { recursive: true });
    await writeFile(reportPath, renderReport(report), "utf8");
  }

  process.stdout.write(`Report: ${reportPath}\nStatus: ${report.status}\n`);
  if (report.status !== "完成" || report.acceptanceStatus === "未通过") process.exitCode = 1;
}

process.on("SIGINT", () => {
  interrupted = true;
  activeWorker?.child.kill();
});

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Probe failed."}\n`);
  process.exitCode = 1;
});
