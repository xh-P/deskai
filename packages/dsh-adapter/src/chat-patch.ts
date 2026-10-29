import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { parseDocument } from 'yaml';
import { buildSystemPrompt, validatePersona } from '../../voice-core/src/prompts.ts';

export type SavedModelSelection = { provider: string; model: string; reasoningEffort?: string };
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
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
  // Keep an explicit desktop route. Otherwise use the route configured through
  // the original Web entry. Credentials remain in dsh's shared credential store.
  for (const relative of ['profiles/deskai2-voice-m1/cordis.patch.yml', 'cordis.patch.yml', 'profiles/web/cordis.patch.yml']) {
    try {
      const selection = extractModelSelection(await readFile(path.join(home, relative), 'utf8'));
      if (selection) return selection;
    } catch { /* No saved route: leave the installed dsh default unchanged. */ }
  }
}

/** Generated overlay is passed to the owned dsh Host; source persona cards remain unchanged. */
export async function prepareChatPatch(root: string): Promise<string> {
  const definitions = [
    ['nagato-normal-light', 'deskai2-voice-m2-nagato'],
    ['assistant-neutral', 'deskai2-voice-m2-neutral']
  ] as const;
  const entries: object[] = await Promise.all(definitions.map(async ([cardId, presetId]) => {
    const card = validatePersona(JSON.parse(await readFile(path.join(root, 'config/personas', `${cardId}.json`), 'utf8')));
    if (card.id !== cardId) throw new Error('CHAT_PERSONA_ID_MISMATCH');
    const prompt = buildSystemPrompt(card);
    return { insert: [{ id: `preset-${presetId}`, name: '@deepseek-ai/dsh-agent-preset', config: {
      id: presetId, name: `DeskAI2 ${card.displayName} voice chat`, plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona',
        config: { complete: true, includeRuntimeContext: false, prefix: prompt.text } }]
    } }] };
  }));
  const selection = await savedModelSelection();
  if (selection) entries.unshift({ id: 'agent-default-model', config: selection });
  const out = path.join(root, '.cache/voice/dsh-m2.patch.yml');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(entries, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return out;
}
