import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcousticEvidence } from '../src/speech/acoustic-evidence.js';
import { WordBargeInGate } from '../src/speech/barge-in.js';

function pcm(ms: number, impulse = false) {
  const bytes = new Uint8Array(ms * 48), view = new DataView(bytes.buffer);
  for (let i = 0; i < ms * 24; i++) view.setInt16(i * 2, impulse ? i === 300 ? 30000 : 0 : Math.round(2000 * Math.sin(i * .1)), true);
  return bytes;
}
test('silence and a single impulse are not sustained near-end speech', () => {
  const audio = new AcousticEvidence(); audio.observe(new Uint8Array(3840));
  assert.equal(audio.hasSpeech(), false);
  audio.observe(pcm(80, true)); assert.equal(audio.hasSpeech(), false);
  audio.observe(pcm(80)); assert.equal(audio.hasSpeech(), true);
  audio.observe(new Uint8Array(2100 * 48)); assert.equal(audio.hasSpeech(), false);
  assert.equal(audio.hasSpeech(240), true, 'delayed ASR events refer to the audio position, not receipt time');
  audio.observe(pcm(80)); audio.reset(); assert.equal(audio.hasSpeech(), false);
});
test('a delayed completed turn consumes only its own audio, preserving the next utterance', () => {
  const audio = new AcousticEvidence(); audio.observe(pcm(80)); audio.observe(pcm(80));
  audio.consumeThrough(80); assert.equal(audio.hasSpeech(), true);
  audio.consumeThrough(160); assert.equal(audio.hasSpeech(), false);
});
test('words require audio evidence, and repeating Mia verbatim is allowed with real speech', () => {
  const gate = new WordBargeInGate(); gate.start(1, true);
  for (const text of ['I', 'I can', 'I can help you']) {
    assert.equal(gate.observe(1, text, true, 1000, false), false);
    assert.equal(gate.meaningful(1, text), false);
  }
  assert.equal(gate.observe(1, 'I can help you', true, 1200, true), true);
  assert.equal(gate.meaningful(1, 'I can help you'), true);
});
