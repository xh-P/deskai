import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DialoguePort } from '../../../packages/voice-core/src/dialogue.ts';
import type { LocalDshSpeech } from '../../../packages/dsh-adapter/src/speech.ts';
import { LocalDshChat } from '../../../packages/dsh-adapter/src/session.ts';
import { OpenAICompatibleChat } from '../../../packages/dsh-adapter/src/openai-chat.ts';

export type ChatRuntimeConfig =
  | { provider: 'dsh-session' }
  | { provider: 'openai-compatible'; baseUrl: string; model: string; apiKeyEnv?: string; timeoutMs?: number };

export async function readChatRuntimeConfig(root: string): Promise<ChatRuntimeConfig> {
  const config = JSON.parse(await readFile(path.join(root, 'config/voice/chat-runtime.json'), 'utf8')) as Record<string, unknown>;
  if (config.provider === 'dsh-session') return { provider: 'dsh-session' };
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

/** The desktop selects a Chat provider independently from ASR and TTS. */
export async function createChatPort(host: LocalDshSpeech, root: string): Promise<DialoguePort> {
  const config = await readChatRuntimeConfig(root);
  if (config.provider === 'dsh-session') return new LocalDshChat(host, root);
  const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  if (config.apiKeyEnv && !apiKey) throw new Error('MISSING_CREDENTIAL');
  return new OpenAICompatibleChat(root, { baseUrl: config.baseUrl, model: config.model, apiKey, timeoutMs: config.timeoutMs });
}
