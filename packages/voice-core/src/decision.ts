export const DECISION_REASONS = ['direct_request', 'answer_to_question', 'sharing', 'clarification', 'unfinished', 'backchannel', 'not_addressed', 'closing', 'uncertain'] as const;
export type DecisionReason = typeof DECISION_REASONS[number];
export type DecisionAction = 'SPEAK' | 'WAIT' | 'SILENT';
export type DecisionHeader = { v: 1; action: DecisionAction; reason: DecisionReason; expectsReply: boolean };

function assertUniqueKeys(line: string): void {
  const seen = new Set<string>();
  let i = 1;
  const spaces = () => { while (/\s/u.test(line[i] ?? '')) i++; };
  const readString = (): string => {
    const start = i++;
    let escaped = false;
    while (i < line.length) {
      const char = line[i++];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') return JSON.parse(line.slice(start, i)) as string;
    }
    throw new Error('invalid decision JSON string');
  };
  while (i < line.length - 1) {
    spaces();
    if (line[i] !== '"') throw new Error('invalid decision field');
    const key = readString();
    if (seen.has(key)) throw new Error(`duplicate decision field: ${key}`);
    seen.add(key);
    spaces();
    if (line[i++] !== ':') throw new Error('invalid decision field separator');
    spaces();
    if (line[i] === '"') readString();
    else if (line[i] === '{' || line[i] === '[') throw new Error('nested decision value forbidden');
    else while (i < line.length && line[i] !== ',' && line[i] !== '}') i++;
    spaces();
    if (line[i] === ',') i++;
    else if (line[i] !== '}') throw new Error('invalid decision field boundary');
    else break;
  }
}

/** Validate a complete first line. Caller must enforce the newline and byte limit. */
export function parseDecisionHeader(line: string): DecisionHeader {
  if (Buffer.byteLength(line, 'utf8') > 512) throw new Error('decision header exceeds 512 UTF-8 bytes');
  if (!line.startsWith('{') || !line.endsWith('}')) throw new Error('decision header is not a bare JSON object');
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error('invalid decision JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid decision object');
  const data = value as Record<string, unknown>;
  assertUniqueKeys(line);
  const keys = Object.keys(data).sort();
  if (keys.join(',') !== 'action,expectsReply,reason,v') throw new Error('decision fields must be exactly v/action/reason/expectsReply');
  if (data.v !== 1) throw new Error('unsupported decision version');
  if (data.action !== 'SPEAK' && data.action !== 'WAIT' && data.action !== 'SILENT') throw new Error('invalid decision action');
  if (!DECISION_REASONS.includes(data.reason as DecisionReason)) throw new Error('invalid decision reason');
  if (typeof data.expectsReply !== 'boolean' || (data.action !== 'SPEAK' && data.expectsReply)) throw new Error('invalid expectsReply');
  return data as DecisionHeader;
}
