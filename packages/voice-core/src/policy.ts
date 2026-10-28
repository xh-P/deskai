import { classifyLocalText } from './index.ts';

export type LocalAction = 'MODEL' | 'STOP' | 'RESUME' | 'WAIT' | 'SILENT' | 'DROP';
export type LocalContext = { outputPlaying: boolean; expectsReply: boolean; pausedOutput?: boolean; noSpeech?: boolean; acousticEcho?: boolean };

/** Narrow intent rules. Similar text alone is never acoustic echo evidence. */
export function localDecision(text: string, context: LocalContext): LocalAction {
  if (context.noSpeech || context.acousticEcho) return 'DROP';
  const classified = classifyLocalText(text, { playing: context.outputPlaying || context.pausedOutput === true, expectsReply: context.expectsReply });
  if (classified === 'empty') return 'DROP';
  if (classified === 'stop') return 'STOP';
  if (classified === 'backchannel') return 'RESUME';
  const value = text.trim().replace(/[\s。.!！?？…]+$/u, '').toLocaleLowerCase();
  if (/^(?:no[,，]?\s*wait|ちょっと待って|少し待って)$/u.test(value)) return 'STOP';
  if (/^(?:那个[，,、…\s]*我想一下|等一下[，,、\s]*我还没想好|让我想想|我还没说完|我想一下|one moment[，,\s]*i(?:'|’)m thinking|let me think|i(?:'|’)m not finished|えっと[、，,\s]*考え中|まだ話している途中です|まだ考えています)$/u.test(value)) return 'WAIT';
  if (/^(?:谢谢[，,\s]*先这样|谢谢[，,\s]*就这样|thanks[，,\s]*that(?:'|’)s all|thank you[，,\s]*that(?:'|’)s all|ありがとう[、，,\s]*これで大丈夫)$/u.test(value)) return 'SILENT';
  if (/^(?:我在跟别人说话[，,\s]*不用回答|我在和别人说话[，,\s]*不用回答|i(?:'|’)m talking to someone else[，,\s]*don(?:'|’)t answer|他の人と話しています[、，,\s]*返事は不要です)$/u.test(value)) return 'SILENT';
  if (context.expectsReply && /^(?:不用了|不想回答|no thanks|no thank you|答えたくないです|もういいです)$/u.test(value)) return 'SILENT';
  return 'MODEL';
}
