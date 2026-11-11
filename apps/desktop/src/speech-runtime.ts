import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalQwenSpeech, type QwenInferenceOptions } from './local-qwen-speech.ts';
import { AEC_MODES, type AecMode } from '../../../packages/voice-core/src/aec-mode.ts';
import type { EndpointConfig, InterruptionConfig } from '../../../packages/voice-core/src/input-config.ts';

export type SpeechMode = 'wake' | 'conversation';
export type InputRuntimeConfig = {
  aec: { mode: AecMode };
  wake: { phrases: string[]; idleTimeoutMs: number };
  interruption: InterruptionConfig;
  endpoint: EndpointConfig;
  conversation: { provider: 'dsh' | 'openai' | 'qwen-local'; baseUrl?: string; model?: string; apiKeyEnv?: string; python?: string; device?: string;
    idlePolicy?: 'resident' | 'unload'; inference?: QwenInferenceOptions };
};

/** Configuration contains no credentials. apiKeyEnv names an environment variable. */
export async function loadInputRuntimeConfig(root: string): Promise<InputRuntimeConfig> {
  const config = JSON.parse(await readFile(path.join(root, 'config/voice/input-runtime.json'), 'utf8')) as InputRuntimeConfig;
  const { wake, endpoint, conversation, interruption, aec } = config;
  if (!aec || !(AEC_MODES as readonly string[]).includes(aec.mode)) throw new Error('INVALID_AEC_CONFIG');
  if (!interruption?.echo) throw new Error('INVALID_INTERRUPTION_CONFIG');
  const { startDelayMs, confirmMs, minVoicedMs, preRollMs, referenceLookbackMs, minRms, minReferenceRms, rawMinRmsMultiplier, vadThreshold, echo } = interruption;
  const durations = [startDelayMs, confirmMs, minVoicedMs, preRollMs, referenceLookbackMs];
  const levels = [minRms, minReferenceRms, vadThreshold, echo.waveformCorrelation, echo.rawCorrelation, echo.residualCorrelation, echo.residualRatio,
    echo.strongRawCorrelation, echo.strongRawResidualCorrelation, echo.singleSignalCorrelation];
  if (!durations.every(n => Number.isFinite(n) && n >= 0 && n <= 3000) || confirmMs <= 64 || minVoicedMs <= 0
    || minVoicedMs > confirmMs || referenceLookbackMs <= 0 || !levels.every(n => Number.isFinite(n) && n > 0 && n <= 1)
    || !Number.isFinite(rawMinRmsMultiplier) || rawMinRmsMultiplier < 1) throw new Error('INVALID_INTERRUPTION_CONFIG');
  if (!wake || !Array.isArray(wake.phrases) || !wake.phrases.length || wake.phrases.some(p => typeof p !== 'string' || !p.trim()) || !Number.isFinite(wake.idleTimeoutMs) || wake.idleTimeoutMs <= 0) throw new Error('INVALID_WAKE_CONFIG');
  if (!endpoint || ![endpoint.candidateWindowMs, endpoint.continuationWindowMs, endpoint.unfinishedWindowMs].every(n => Number.isFinite(n) && n > 0 && n <= 3000) || endpoint.candidateWindowMs > endpoint.continuationWindowMs || endpoint.unfinishedWindowMs < endpoint.continuationWindowMs || !Number.isFinite(endpoint.vadThreshold) || endpoint.vadThreshold <= 0 || endpoint.vadThreshold > 1) throw new Error('INVALID_ENDPOINT_CONFIG');
  if (!conversation || !['dsh', 'openai', 'qwen-local'].includes(conversation.provider) || (conversation.idlePolicy !== undefined && !['resident', 'unload'].includes(conversation.idlePolicy))) throw new Error('INVALID_CONVERSATION_ASR_CONFIG');
  const inference = conversation.inference;
  if (inference && (!['official', 'cuda_graph'].includes(inference.engine) || typeof inference.flashAttention !== 'boolean'
    || !Number.isSafeInteger(inference.graphCapacity) || inference.graphCapacity <= 256)) throw new Error('INVALID_QWEN_INFERENCE_CONFIG');
  return config;
}

/** The local dsh service is owned and started by the caller. */
export class SpeechRuntime {
  private readonly local: { transcribe(wav: Uint8Array, signal: AbortSignal): Promise<{ text: string }> };
  private readonly config: InputRuntimeConfig['conversation'];
  private readonly qwen?: LocalQwenSpeech;
  constructor(local: { transcribe(wav: Uint8Array, signal: AbortSignal): Promise<{ text: string }> }, config: InputRuntimeConfig['conversation'], root = process.cwd()) {
    this.local = local; this.config = config;
    if (config.provider === 'qwen-local') this.qwen = new LocalQwenSpeech(root, config);
  }
  prepare(): Promise<void> { return this.qwen?.prepare() ?? Promise.resolve(); }
  diagnostics() { return this.qwen?.diagnostics(); }
  standby(): void { if (this.config.idlePolicy === 'unload') this.qwen?.dispose(); }
  dispose(): void { this.qwen?.dispose(); }

  async transcribe(mode: SpeechMode, wav: Uint8Array, signal: AbortSignal): Promise<string> {
    if (mode === 'wake' || this.config.provider === 'dsh') return (await this.local.transcribe(wav, signal)).text;
    if (this.qwen) return this.qwen.transcribe(wav, signal);
    const { baseUrl, model, apiKeyEnv } = this.config;
    if (!baseUrl || !model) throw new Error('CONVERSATION_ASR_NOT_CONFIGURED');
    let url: URL;
    try { url = new URL(baseUrl.replace(/\/+$/, '') + '/audio/transcriptions'); } catch { throw new Error('CONVERSATION_ASR_INVALID_URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('CONVERSATION_ASR_INVALID_URL');
    const key = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
    if (apiKeyEnv && !key) throw new Error('CONVERSATION_ASR_KEY_MISSING');
    const form = new FormData();
    form.append('model', model);
    form.append('file', new Blob([Uint8Array.from(wav)], { type: 'audio/wav' }), 'speech.wav');
    const response = await fetch(url, { method: 'POST', body: form, signal, headers: key ? { Authorization: `Bearer ${key}` } : {} });
    if (!response.ok) throw new Error(`CONVERSATION_ASR_HTTP_${response.status}`);
    const result = await response.json() as { text?: unknown };
    if (typeof result.text !== 'string') throw new Error('CONVERSATION_ASR_INVALID_RESPONSE');
    return result.text;
  }
}
