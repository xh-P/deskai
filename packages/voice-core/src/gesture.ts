export const GESTURE_NAMES = ['nod', 'shake_head', 'tilt_left', 'tilt_right', 'look_left', 'look_right', 'look_up', 'look_down'] as const;
export type GestureName = typeof GESTURE_NAMES[number];
export type Gesture = { name: GestureName; strength: 'subtle' | 'normal' };

const marker = '[gesture:';
const command = /^\[gesture:([a-z_]+):(subtle|normal)\]/u;

/** Split the optional leading directive from the streamed reply before delivery accounting. */
export class GestureReply {
  private leading: string | undefined = '';
  private trimBody = false;
  private readonly allowed: readonly GestureName[];
  gesture?: Gesture;

  constructor(allowed: readonly GestureName[]) { this.allowed = allowed; }

  append(delta: string): string {
    if (this.leading === undefined) {
      if (!this.trimBody) return delta;
      const body = delta.trimStart();
      this.trimBody = !body;
      return body;
    }
    this.leading += delta;
    const candidate = this.leading.trimStart();
    if (marker.startsWith(candidate)) return '';
    if (!candidate.startsWith(marker)) return this.finish();
    const end = candidate.search(/[\]\r\n]/u);
    if (end < 0) return '';

    const match = command.exec(candidate);
    const name = this.allowed.find(item => item === match?.[1]);
    if (name && match) this.gesture = { name, strength: match[2] === 'normal' ? 'normal' : 'subtle' };
    const body = candidate.slice(end + 1).trimStart();
    this.leading = undefined;
    this.trimBody = !body;
    return body;
  }

  finish(): string {
    const text = this.leading ?? '';
    this.leading = undefined;
    return text.trimStart().startsWith(marker) ? '' : text;
  }
}
