/** A spoken sentence keeps its source span: cleaned speech is never a raw prefix. */
export type SpokenSentence = { text: string; rawText: string; rawStart: number; rawEnd: number };
const action = /微笑|点头|搖頭|摇头|抬头|低头|眨眼|看着|翻开|叹气|笑う|頷|うなず|ため息|見つめ|首を|smil|nod|sigh|laugh|shrug|looks? at|turns? (?:to|away)|動作|动作/iu;

export function cleanSpeech(raw: string): string {
  return raw.replace(/```[\s\S]*?(?:```|$)/gu, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/gu, ' ')
    .replace(/`[^`]*(?:`|$)/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/(?:https?:\/\/|www\.)[^\s<>()。！？]+/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/(?<!\*)\*(?!\*)([^*\n]*)(?:\*(?!\*)|$)/gu, (_match, inner: string) => action.test(inner) ? ' ' : inner)
    .replace(/[（(【\[]([^\n）)】\]]*)(?:[）)】\]]|$)/gmu, (match, inner: string) => action.test(inner) ? ' ' : match)
    .replace(/(?:^|\n)\s*(?:#{1,6}\s*|[-+*]\s+|\d+[.)]\s+)/gu, ' ')
    .replace(/[*_~#]/gu, '').replace(/[\t\r\n ]+/gu, ' ').trim();
}

/** Holds incomplete markup/tokens until their boundary is known; bounded by the reply budget. */
export class SentenceStream {
  private raw = '';
  private cursor = 0;
  private ended = false;
  private readonly maxText: number;
  private readonly maxSentence: number;
  constructor(maxText = 12000, maxSentence = 180) { this.maxText = maxText; this.maxSentence = maxSentence; }
  append(text: string): void {
    if (this.ended || this.raw.length + text.length > this.maxText) throw new Error('SPEECH_TEXT_LIMIT');
    this.raw += text;
  }
  finish(): void { this.ended = true; }
  next(): SpokenSentence | undefined {
    if (this.cursor === this.raw.length) return;
    const start = this.cursor;
    let fence = '', inline = false, brackets = 0, emphasis = '';
    for (let i = start; i < this.raw.length; i++) {
      const triple = this.raw.slice(i, i + 3);
      if (triple === '```' || triple === '~~~') {
        if (!fence) fence = triple; else if (fence === triple) fence = '';
        i += 2; continue;
      }
      if (fence) continue;
      const char = this.raw[i];
      if (char === '`') { inline = !inline; continue; }
      if (inline) continue;
      if (char === '*') {
        const marker = this.raw[i + 1] === '*' ? '**' : '*';
        if (!emphasis) emphasis = marker; else if (emphasis === marker) emphasis = '';
        if (marker === '**') i++;
        continue;
      }
      if (emphasis) continue;
      if ('[（(【'.includes(char)) brackets++;
      if (']）)】'.includes(char)) brackets = Math.max(0, brackets - 1);
      if (brackets) continue;
      const token = this.raw.slice(start, i + 1).match(/\S+$/u)?.[0] ?? '';
      const url = /(?:https?:\/\/|www\.)/iu.test(token);
      let boundary = /[。！？!?\n]/u.test(char) && !url;
      if (char === '.' && !url) {
        const next = this.raw[i + 1];
        const before = this.raw.slice(start, i + 1);
        const abbreviation = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|[A-Z])\.$/iu.test(before) || /(?:\b[A-Za-z]\.){2,}$/u.test(before);
        boundary = !abbreviation && !(digit(this.raw[i - 1]) && digit(next)) && !!next && /\s/u.test(next);
      }
      if (!url && i - start >= this.maxSentence && /[，、,;；:\s]/u.test(char)) boundary = true;
      if (!url && i - start >= this.maxSentence && /[\p{Script=Han}\u3040-\u30ff]/u.test(char)) boundary = true;
      // Wait for a following character so streamed punctuation/URL/markdown stays intact.
      if (boundary && (i + 1 < this.raw.length || this.ended)) return this.take(start, i + 1);
    }
    if (this.ended) return this.take(start, this.raw.length);
    return;
  }
  private take(start: number, end: number): SpokenSentence {
    this.cursor = end;
    const rawText = this.raw.slice(start, end);
    return { text: cleanSpeech(rawText), rawText, rawStart: start, rawEnd: end };
  }
}
function digit(value: string | undefined): boolean { return value !== undefined && /[0-9]/u.test(value); }
