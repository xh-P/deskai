import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PERSONA_ID, isPersonaId } from './persona-catalog.ts';
import { validatePersona } from './prompts.ts';

export async function readBundledPersona(root: string, id = DEFAULT_PERSONA_ID) {
  if (!isPersonaId(id)) throw new Error('INVALID_PERSONA');
  const card = validatePersona(JSON.parse(await readFile(path.join(root, 'config/personas', `${id}.json`), 'utf8')));
  if (card.id !== id) throw new Error('CHAT_PERSONA_ID_MISMATCH');
  return card;
}

export async function bundledPersonas(root: string) {
  const files = await readdir(path.join(root, 'config/personas'));
  return Promise.all(files.filter(file => file.endsWith('.json')).map(file => readBundledPersona(root, file.slice(0, -5))));
}
