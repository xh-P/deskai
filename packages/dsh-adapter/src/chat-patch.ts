import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { parseDocument } from 'yaml';
import { DESKTOP_CHAT_PRESET, DESKTOP_CHAT_PROMPT } from '../../voice-core/src/prompts.ts';
import { COORDINATOR_PRESET, COORDINATOR_PROMPT } from '../../voice-core/src/coordination.ts';

export type SavedModelSelection = { provider: string; model: string; reasoningEffort?: string };
export const DESKTOP_DSH_PROFILE = 'deskai2-voice';
export const dshHome = () => process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
/** YAML is data only. Select one known plugin; arbitrary config never enters our overlay. */
export function extractModelSelection(text: string): SavedModelSelection | undefined {
  const document = parseDocument(text, { logLevel: 'silent' });
  if (document.errors.length) return;
  let entries: unknown;
  try { entries = document.toJS({ maxAliasCount: 20 }); } catch { return; }
  if (!Array.isArray(entries)) return;
  const row = entries.find(value => value?.id === 'agent-default-model');
  const config = row?.config;
  const valid = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u.test(value);
  if (!valid(config?.provider) || !valid(config?.model)) return;
  return { provider: config.provider, model: config.model,
    ...(valid(config.reasoningEffort) ? { reasoningEffort: config.reasoningEffort } : {}) };
}
async function savedModelSelection(): Promise<SavedModelSelection | undefined> {
  const home = dshHome();
  for (const relative of [`profiles/${DESKTOP_DSH_PROFILE}/cordis.patch.yml`, 'cordis.patch.yml', 'profiles/web/cordis.patch.yml']) {
    try {
      const selection = extractModelSelection(await readFile(path.join(home, relative), 'utf8'));
      if (selection) return selection;
    } catch { /* No saved route: leave the installed dsh default unchanged. */ }
  }
}

export const chatPatchPath = (root: string) => path.join(root, '.cache/voice/chat.patch.yml');

/** Generated overlay for the desktop chat and planning service. */
export async function prepareChatPatch(root: string): Promise<string> {
  const entries: object[] = [{ insert: [
    { id: DESKTOP_CHAT_PRESET, title: 'DeskAI2 voice chat', prompt: DESKTOP_CHAT_PROMPT },
    { id: COORDINATOR_PRESET, title: 'DeskAI Host coordination', prompt: COORDINATOR_PROMPT }
  ].map(({ id, title, prompt }) => ({ id: `preset-${id}`, name: '@deepseek-ai/dsh-agent-preset', config: {
    id, name: title, plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona',
      config: { complete: true, includeRuntimeContext: false, prefix: prompt } }]
  } })) }];
  const selection = await savedModelSelection();
  if (selection) entries.unshift({ id: 'agent-default-model', config: selection });
  const out = chatPatchPath(root);
  await mkdir(path.dirname(out), { recursive: true });
  const temporary = `${out}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(entries, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, out);
  } finally { await rm(temporary, { force: true }); }
  return out;
}
