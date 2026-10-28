import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSystemPrompt, validatePersona } from '../../voice-core/src/prompts.ts';

/** Generated overlay is passed to the owned dsh Host; source persona cards remain unchanged. */
export async function prepareChatPatch(root: string): Promise<string> {
  const definitions = [
    ['nagato-normal-light', 'deskai2-voice-m2-nagato'],
    ['assistant-neutral', 'deskai2-voice-m2-neutral']
  ] as const;
  const entries = await Promise.all(definitions.map(async ([cardId, presetId]) => {
    const card = validatePersona(JSON.parse(await readFile(path.join(root, 'config/personas', `${cardId}.json`), 'utf8')));
    if (card.id !== cardId) throw new Error('CHAT_PERSONA_ID_MISMATCH');
    const prompt = buildSystemPrompt(card);
    return { insert: [{ id: `preset-${presetId}`, name: '@deepseek-ai/dsh-agent-preset', config: {
      id: presetId, name: `DeskAI2 ${card.displayName} voice chat`, plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona',
        config: { complete: true, includeRuntimeContext: false, prefix: prompt.text } }]
    } }] };
  }));
  const out = path.join(root, '.cache/voice/dsh-m2.patch.yml');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(entries, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return out;
}
