import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DialoguePort } from '../../../packages/voice-core/src/dialogue.ts';
import type { LocalDshSpeech } from '../../../packages/dsh-adapter/src/speech.ts';
import { LocalDshChat } from '../../../packages/dsh-adapter/src/session.ts';
import { OpenAICompatibleChat } from '../../../packages/dsh-adapter/src/openai-chat.ts';
import { CharacterChat, type CharacterKnowledge } from './character-knowledge.ts';

export type ChatRuntimeConfig =
  | { provider: 'dsh-session'; speculativeVoice?: { maxAgeMs: number } }
  | { provider: 'openai-compatible'; baseUrl: string; model: string; apiKeyEnv?: string; timeoutMs?: number };

export async function readChatRuntimeConfig(root: string): Promise<ChatRuntimeConfig> {
  const config = JSON.parse(await readFile(path.join(root, 'config/voice/chat-runtime.json'), 'utf8')) as Record<string, unknown>;
  if (config.provider === 'dsh-session') {
    if (config.speculativeVoice === undefined) return { provider: 'dsh-session' };
    const { maxAgeMs } = (config.speculativeVoice ?? {}) as { maxAgeMs?: number };
    if (maxAgeMs === undefined || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new Error('INVALID_SPECULATIVE_CHAT_CONFIG');
    return { provider: 'dsh-session', speculativeVoice: { maxAgeMs } };
  }
  if (config.provider !== 'openai-compatible') throw new Error('CHAT_PROVIDER_CONFIG');
  if (typeof config.baseUrl !== 'string' || typeof config.model !== 'string' || !config.model.trim()
    || (config.apiKeyEnv !== undefined && (typeof config.apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/u.test(config.apiKeyEnv)))) throw new Error('CHAT_PROVIDER_CONFIG');
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { throw new Error('CHAT_PROVIDER_URL'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('CHAT_PROVIDER_URL');
  if (url.username || url.password || url.search || url.hash) throw new Error('CHAT_PROVIDER_URL');
  const timeoutMs = config.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 10_000 || (timeoutMs as number) > 300_000)) throw new Error('CHAT_PROVIDER_CONFIG');
  return { provider: 'openai-compatible', baseUrl: url.toString(), model: config.model, ...(config.apiKeyEnv ? { apiKeyEnv: config.apiKeyEnv } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }) };
}

type ChatRuntime = { port: DialoguePort; speculative?: { port: DialoguePort; maxAgeMs: number } };

/** Speculation gets a separate text-only dsh session owner so its cancellation cannot affect confirmed Chat. */
export async function createChatRuntime(host: LocalDshSpeech, root: string, knowledge?: CharacterKnowledge): Promise<ChatRuntime> {
  const config = await readChatRuntimeConfig(root);
  const withKnowledge = (port: DialoguePort) => knowledge ? new CharacterChat(port, knowledge) : port;
  if (config.provider === 'dsh-session') return { port: withKnowledge(new LocalDshChat(host, root)),
    ...(config.speculativeVoice ? { speculative: { port: withKnowledge(new LocalDshChat(host, root)), ...config.speculativeVoice } } : {}) };
  const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  if (config.apiKeyEnv && !apiKey) throw new Error('MISSING_CREDENTIAL');
  return { port: withKnowledge(new OpenAICompatibleChat(root, { baseUrl: config.baseUrl, model: config.model, apiKey, timeoutMs: config.timeoutMs })) };
}

export async function createChatPort(host: LocalDshSpeech, root: string): Promise<DialoguePort> {
  return (await createChatRuntime(host, root)).port;
}
