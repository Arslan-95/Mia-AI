import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResidualEchoGuard } from '../src/audio/echo';

function voice(seed: number, ms = 2000) {
  const samples = ms * 24;
  const bytes = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / 24000;
    const envelope = .45 + .4 * Math.sin(t * 19 + seed);
    const value = Math.round(32767 * .3 * envelope * (Math.sin(t * (800 + seed * 43)) + .3 * Math.sin(t * (1900 + seed * 17))));
    bytes[i * 2] = value & 255; bytes[i * 2 + 1] = value >> 8 & 255;
  }
  return bytes;
}
function mix(a: Uint8Array, gain: number, b?: Uint8Array) {
  const output = new Uint8Array(a.length), av = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const bv = b && new DataView(b.buffer, b.byteOffset, b.byteLength), out = new DataView(output.buffer);
  for (let i = 0; i < a.length; i += 2) out.setInt16(i, Math.max(-32768, Math.min(32767, Math.round(av.getInt16(i, true) * gain + (bv?.getInt16(i, true) ?? 0)))), true);
  return output;
}
function allZero(parts: Uint8Array[]) { return parts.every(part => part.every(byte => byte === 0)); }

test('delayed speaker copies at different volumes and polarity are silenced before recognition', () => {
  const source = voice(1);
  for (const gain of [.03, .3, -.2]) {
    const gate = new ResidualEchoGuard(); gate.begin(source, 'reply', 1000);
    // Actual speaker position 400ms; input arrives 230ms later, including tap delay.
    const echo = mix(source.subarray(400 * 48, 480 * 48), gain);
    const output = gate.process(echo, 1710);
    assert.equal(output.length, 1); assert.ok(allZero(output), `residual speaker copy at gain ${gain}`);
    assert.equal(gate.stats.echoFrames, 1);
  }
});

test('independent human speech over an echo is preserved byte-for-byte, even if words are identical', () => {
  const reference = voice(1), human = voice(7);
  const gate = new ResidualEchoGuard(); gate.begin(reference, 'same words', 1000);
  const input = mix(reference.subarray(400 * 48, 480 * 48), .15, human.subarray(0, 80 * 48));
  assert.deepEqual(gate.process(input, 1710), [input]);
  assert.equal(gate.stats.speechFrames, 1);
});

test('a quiet near-end voice survives a louder copy of the speaker signal', () => {
  const reference = voice(1), human = mix(voice(7), .1);
  const gate = new ResidualEchoGuard(); gate.begin(reference, 'reply', 1000);
  const input = mix(reference.subarray(400 * 48, 480 * 48), .5, human.subarray(0, 80 * 48));
  assert.deepEqual(gate.process(input, 1710), [input]);
});

test('high-frequency near-end speech must not disappear in the coarse timing signal', () => {
  const reference = voice(1), highVoice = new Uint8Array(3840), view = new DataView(highVoice.buffer);
  for (let i = 0; i < highVoice.length / 2; i++) view.setInt16(i * 2, Math.round(2200 * Math.sin(2 * Math.PI * 4000 * i / 24000)), true);
  const gate = new ResidualEchoGuard(); gate.begin(reference, 'reply', 1000);
  const input = mix(reference.subarray(400 * 48, 480 * 48), .5, highVoice);
  assert.deepEqual(gate.process(input, 1710), [input]);
  const quiet = new ResidualEchoGuard(); quiet.begin(reference, 'reply', 1000);
  assert.deepEqual(quiet.process(highVoice, 1710), [highVoice]);
});

test('short packets retain the beginning of real speech until classification; echo tail expires', () => {
  const reference = voice(1), human = voice(7).subarray(0, 80 * 48);
  const gate = new ResidualEchoGuard(); gate.begin(reference, 'reply', 1000);
  assert.deepEqual(gate.process(human.subarray(0, 40 * 48), 1500), []);
  assert.deepEqual(gate.process(human.subarray(40 * 48), 1540), [human]);
  gate.end('reply', 1600);
  const echo = mix(reference.subarray(400 * 48, 480 * 48), .15);
  assert.ok(allZero(gate.process(echo, 1710)));
  assert.deepEqual(gate.process(human, 2500), [human]);
  gate.reset(); assert.deepEqual(gate.process(human.subarray(0, 4), 2501), [human.subarray(0, 4)]);
});

test('silence is not amplified and late completion cannot terminate a newer speaker reference', () => {
  const gate = new ResidualEchoGuard(), reference = voice(3);
  gate.begin(voice(1), 'old', 0); gate.begin(reference, 'new', 1000); gate.end('old', 1100);
  assert.ok(allZero(gate.process(new Uint8Array(3840), 1200)));
  assert.ok(allZero(gate.process(mix(reference.subarray(400 * 48, 480 * 48), .1), 1710)));
});
