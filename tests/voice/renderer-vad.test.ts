import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameQueue } from '../../apps/desktop/renderer/src/frame-queue.ts';

test('stateful VAD inference remains serial and flushes pending frames on close', async () => {
  const done: (() => void)[] = [], processed: number[] = [], errors: unknown[] = [];
  const queue = new FrameQueue(frame => new Promise<void>(resolve => {
    processed.push(frame[0]); done.push(resolve);
  }), error => errors.push(error));
  queue.push(new Float32Array([1])); queue.push(new Float32Array([2]));
  await Promise.resolve();
  assert.deepEqual(processed, [1]);
  const closing = queue.close();
  done[0](); await closing;
  assert.deepEqual(processed, [1]);
  queue.push(new Float32Array([3]));
  assert.deepEqual(processed, [1]);
  assert.equal(errors.length, 0);
});

test('slow VAD has a hard bounded frame queue and signals overload instead of dropping speech silently', async () => {
  let settle!: () => void;
  const errors: unknown[] = [], processed: number[] = [];
  const queue = new FrameQueue(async frame => { processed.push(frame[0]); await new Promise<void>(resolve => { settle = resolve; }); }, error => errors.push(error), 3);
  queue.push(new Float32Array([1])); queue.push(new Float32Array([2])); queue.push(new Float32Array([3]));
  queue.push(new Float32Array([4]));
  await Promise.resolve();
  assert.equal(errors.length, 1);
  assert.deepEqual(processed, [1]);
  settle(); await queue.close();
  assert.deepEqual(processed, [1]);
});
