import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PetActivity } from '../../packages/desktop-pet/src/projection.ts';
import { defaultPetPreferences, mergePetPreferences } from '../../apps/desktop/src/pet-settings.ts';

test('pet follows real input and model decisions without inventing a reply', () => {
  const activity = new PetActivity();
  const state = () => activity.snapshot(defaultPetPreferences);
  assert.equal(state().state, 'off');
  activity.startSession('session-1', true);
  assert.equal(state().state, 'listening');
  activity.input('TRANSCRIBING');
  assert.equal(state().state, 'recognizing');
  activity.dialogue({ type: 'model-state', state: 'generating' });
  assert.equal(state().state, 'thinking');
  activity.dialogue({ type: 'decision', turnId: 't1', generationId: 1, action: 'WAIT', local: false });
  activity.dialogue({ type: 'model-state', state: 'waiting' });
  assert.equal(state().state, 'waiting');
  assert.equal(state().subtitle, '');
  activity.dialogue({ type: 'decision', turnId: 't2', generationId: 2, action: 'SILENT', local: false });
  activity.dialogue({ type: 'model-state', state: 'silent' });
  assert.equal(state().state, 'silent');
  assert.equal(state().subtitle, '');
  activity.stopSession();
  assert.equal(state().state, 'off');
  activity.startSession('session-2', true);
  activity.fail();
  activity.stopSession(true);
  assert.equal(state().state, 'error');
  activity.startSession('session-3', true);
  assert.equal(state().state, 'listening');
});

test('mouth and subtitles require a matching playback receipt; clear rejects stale generations', () => {
  const activity = new PetActivity();
  const state = () => activity.snapshot(defaultPetPreferences);
  activity.startSession('session-1', true);
  activity.dialogue({ type: 'model-state', state: 'generating' });
  const cue = { type: 'gesture', attemptId: 'attempt-1', generationId: 1, timing: 'speech',
    gesture: { name: 'shake_head', strength: 'normal' } } as const;
  activity.dialogue(cue);
  activity.spoken({ generationId: 1, text: '真实句子', completed: false });
  assert.notEqual(state().state, 'speaking');
  assert.equal(state().gesture, undefined);
  activity.playback({ sessionId: 'other-session', generationId: 1, playing: true, paused: false });
  activity.spoken({ generationId: 1, text: '真实句子', completed: false });
  assert.notEqual(state().state, 'speaking');
  activity.playback({ sessionId: 'session-1', generationId: 1, playing: true, paused: false });
  activity.spoken({ generationId: 1, attemptId: 'attempt-1', segmentId: 'segment-1', text: '真实句子', completed: false });
  const mouth = { sessionId: 'session-1', generationId: 1, attemptId: 'attempt-1', segmentId: 'segment-1',
    frame: 4096, sampleRate: 48000, open: .55, shape: -.2 };
  assert.equal(activity.mouth(mouth), true);
  assert.equal(activity.mouth(mouth), false, 'duplicate audio frames cannot reanimate the mouth');
  assert.equal(activity.mouth({ ...mouth, frame: 4200, segmentId: 'next' }), false);
  assert.equal(state().state, 'speaking');
  assert.equal(state().subtitle, '真实句子');
  assert.equal(state().gesture?.name, 'shake_head');
  activity.output('pause', 1);
  activity.playback({ sessionId: 'session-1', generationId: 1, playing: true, paused: false });
  assert.equal(activity.mouth({ ...mouth, frame: 4500 }), false);
  assert.equal(state().state, 'paused');
  assert.equal(state().subtitle, '');
  assert.equal(state().gesture, undefined);
  activity.output('resume', 1);
  activity.spoken({ generationId: 1, text: '旧回执', completed: false });
  assert.notEqual(state().state, 'speaking');
  activity.output('clear', 2);
  activity.dialogue(cue);
  activity.playback({ sessionId: 'session-1', generationId: 1, playing: true, paused: false });
  activity.spoken({ generationId: 1, attemptId: 'attempt-1', text: '已取消内容', completed: false });
  assert.notEqual(state().state, 'speaking');
  assert.equal(state().subtitle, '');
  assert.equal(state().gesture, undefined);
  activity.playback({ sessionId: 'session-1', generationId: 2, playing: true, paused: false });
  activity.spoken({ generationId: 2, text: '新回执', completed: false });
  assert.equal(state().subtitle, '新回执');
  for (const generationId of [3, 4, 5]) {
    activity.output('clear', generationId);
    assert.equal(activity.mouth({ ...mouth, generationId: generationId - 1, frame: 8000 }), false);
    activity.playback({ sessionId: 'session-1', generationId, playing: true, paused: false });
    activity.spoken({ generationId, attemptId: 'attempt-1', segmentId: 'segment-1', text: '恢复播报', completed: false });
    assert.equal(activity.mouth({ ...mouth, generationId, frame: 10000 }), true);
  }
  activity.stopSession();
  activity.playback({ sessionId: 'session-1', generationId: 2, playing: true, paused: false });
  assert.equal(state().state, 'off');
});

test('pet appearance preferences remain separate and validate supported values', () => {
  const update = mergePetPreferences(defaultPetPreferences, { variant: 'witch-normal', size: 300, visible: false });
  assert.equal(update.variant, 'witch-normal');
  assert.equal(update.size, 300);
  assert.equal(update.visible, false);
  assert.throws(() => mergePetPreferences(update, { size: 500 }), /INVALID_PET_SIZE/);
  assert.throws(() => mergePetPreferences(update, { voiceId: 'other' }), /INVALID_PET_PREFERENCES/);
});
