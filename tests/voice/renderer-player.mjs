import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

const messages = []
let Player
class FakeProcessor { constructor() { this.port = { onmessage: null, postMessage: message => messages.push(message) } } }
const source = await readFile(resolve('apps/desktop/renderer/public/worklets/pcm-player.js'), 'utf8')
runInNewContext(source, { AudioWorkletProcessor: FakeProcessor, Float32Array, sampleRate: 48000, registerProcessor: (_name, type) => { Player = type } })
const player = new Player()
const send = data => player.port.onmessage({ data })
const render = () => { const mono = new Float32Array(128); player.process([], [[mono]]); return mono }

const ramp = Float32Array.from({ length: 1600 }, (_, index) => index / 1600)
send({ type: 'enqueue', generationId: 1, sampleRate: 16000, samples: ramp, final: true })
const first = render()
assert.ok(Math.abs(first[3] - 1 / 1600) < 0.00001, '16kHz PCM must resample into the 48kHz context')
send({ type: 'pause', generationId: 1 })
assert.equal(render().every(sample => sample === 0), true, 'candidate pause must retain but mute audio')
send({ type: 'resume', generationId: 1 })
assert.ok(Math.abs(render()[0] - (128 / 3 / 1600)) < 0.00001, 'false alarm resumes from unplayed position')
send({ type: 'clear', generationId: 2 })
send({ type: 'enqueue', generationId: 1, sampleRate: 16000, samples: new Float32Array(1600).fill(.9) })
assert.equal(render().every(sample => sample === 0), true, 'old generation must never return')
send({ type: 'enqueue', generationId: 2, sampleRate: 16000, samples: new Float32Array(1600).fill(.25), final: true })
assert.equal(render()[0], .25)
for (let i = 0; i < 40; i++) render()
assert.equal(messages.some(message => message.type === 'state' && message.completed && message.generationId === 2), true)
send({ type: 'enqueue', generationId: 2, sampleRate: 16000, samples: new Float32Array(16000 * 7) })
assert.equal(messages.some(message => message.type === 'overflow'), true, 'queue is bounded to six seconds')

// Real sentence identities survive acknowledgments and playback completion.
const identified = new Player()
const identity = { sessionId: 's', turnId: 't', attemptId: 'a', generationId: 3, voiceRevision: 2, segmentId: 'seg', chunkSeq: 0 }
const input32 = { type: 'enqueue', ...identity, sampleRate: 32000, samples: new Float32Array(3200).fill(.5), segmentFinal: true, final: true }
identified.command(input32)
identified.command(input32)
assert.ok(messages.some(m => m.chunkAccepted && m.segmentId === 'seg' && m.attemptId === 'a' && m.voiceRevision === 2))
const before = messages.filter(m => m.segmentCompleted && m.segmentId === 'seg').length
let frames32 = 0
while (identified.queue.length && frames32 < 10000) {
  identified.process([], [[new Float32Array(128)]])
  frames32 += 128
}
assert.ok(Math.abs(frames32 - 4800) < 128, '32kHz input keeps its 100ms duration in a 48kHz context')
assert.equal(messages.filter(m => m.segmentCompleted && m.segmentId === 'seg').length - before, 1, 'duplicate chunk never repeats a sentence')
identified.command({ type: 'enqueue', ...identity, segmentId: 'seg48', sampleRate: 48000, samples: new Float32Array(4800).fill(.25), segmentFinal: true })
let frames48 = 0
while (identified.queue.length && frames48 < 10000) {
  identified.process([], [[new Float32Array(128)]])
  frames48 += 128
}
assert.ok(Math.abs(frames48 - 4800) < 128, '48kHz remains 100ms after a 32kHz sentence')
identified.command({ type: 'enqueue', ...identity, segmentId: 'gap', chunkSeq: 2, sampleRate: 48000, samples: new Float32Array(128) })
assert.ok(messages.some(m => m.errorCode === 'PLAYBACK_SEQUENCE' && m.segmentId === 'gap'))
identified.command({ type: 'clear', generationId: 4 })
identified.command(input32)
assert.equal(identified.queue.length, 0, 'old identity is rejected after clearing')
console.log('renderer-player: pass')
