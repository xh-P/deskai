import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameQueue } from '../../apps/desktop/renderer/src/frame-queue.ts';
import { AEC_MODES, DEFAULT_AEC_MODE, aecCaptureOptions, aecUsesWebRtc, aecWasmOptions, isAecMode } from '../../packages/voice-core/src/aec-mode.ts';

test('AEC modes map to distinct capture and actual WASM processing paths', () => {
  assert.equal(DEFAULT_AEC_MODE, 'browser-ns');
  assert.deepEqual(AEC_MODES, ['off', 'browser', 'browser-ns', 'webrtc', 'webrtc-ns']);
  assert.deepEqual(aecCaptureOptions('off'), { echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  assert.deepEqual(aecCaptureOptions('browser'), { echoCancellation: true, noiseSuppression: false, autoGainControl: false });
  assert.deepEqual(aecCaptureOptions('browser-ns'), { echoCancellation: true, noiseSuppression: true, autoGainControl: false });
  assert.deepEqual(aecCaptureOptions('webrtc'), aecCaptureOptions('off'));
  assert.deepEqual(aecCaptureOptions('webrtc-ns'), aecCaptureOptions('off'));
  assert.equal(aecUsesWebRtc('browser-ns'), false);
  assert.equal(aecUsesWebRtc('webrtc'), true);
  assert.equal(aecUsesWebRtc('webrtc-ns'), true);
  assert.deepEqual(aecWasmOptions('webrtc'), { noiseSuppression: false });
  assert.deepEqual(aecWasmOptions('webrtc-ns'), { noiseSuppression: true });
  assert.equal(isAecMode('webrtc-ns'), true);
  assert.equal(isAecMode('webrtc-high'), false);
});

test('stateful VAD inference remains serial and flushes pending frames on close', async () => {
  const done: (() => void)[] = [], processed: number[] = [], errors: unknown[] = [];
  const queue = new FrameQueue<Float32Array>(frame => new Promise<void>(resolve => {
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
  const queue = new FrameQueue<Float32Array>(async frame => { processed.push(frame[0]); await new Promise<void>(resolve => { settle = resolve; }); }, error => errors.push(error), 3);
  queue.push(new Float32Array([1])); queue.push(new Float32Array([2])); queue.push(new Float32Array([3]));
  queue.push(new Float32Array([4]));
  await Promise.resolve();
  assert.equal(errors.length, 1);
  assert.deepEqual(processed, [1]);
  settle(); await queue.close();
  assert.deepEqual(processed, [1]);
});
