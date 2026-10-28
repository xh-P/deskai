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
console.log('renderer-player: pass')
