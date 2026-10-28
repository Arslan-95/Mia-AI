import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlaybackEchoGate } from '../src/audio/echo';

function voice(seed: number, ms = 2000, gain = .3) {
  const samples = ms * 24;
  const bytes = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / 24000;
    const envelope = .45 + .4 * Math.sin(t * 19 + seed);
    const value = Math.round(32767 * gain * envelope * (Math.sin(t * (800 + seed * 43)) + .3 * Math.sin(t * (1900 + seed * 17))));
    bytes[i * 2] = value & 255; bytes[i * 2 + 1] = value >> 8 & 255;
  }
  return bytes;
}
function mix(a: Uint8Array, gain: number, b?: Uint8Array, bGain = 1) {
  const output = new Uint8Array(a.length), av = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const bv = b && new DataView(b.buffer, b.byteOffset, b.byteLength), out = new DataView(output.buffer);
  for (let i = 0; i < a.length; i += 2) out.setInt16(i, Math.max(-32768, Math.min(32767, Math.round(av.getInt16(i, true) * gain + (bv && i < b.length ? bv.getInt16(i, true) * bGain : 0)))), true);
  return output;
}
// Mic input of `ms`, delivered in 80 ms packets as the native module does,
// starting at `at`; returns everything the gate forwarded.
function feed(gate: PlaybackEchoGate, input: Uint8Array, at: number) {
  const output: Uint8Array[] = [];
  for (let offset = 0; offset < input.length; offset += 3840) {
    output.push(...gate.process(input.subarray(offset, offset + 3840), at + (offset + 3840) / 48));
  }
  return output;
}
const length = (parts: Uint8Array[]) => parts.reduce((sum, part) => sum + part.length, 0);
const silent = (parts: Uint8Array[]) => parts.every(part => part.every(byte => byte === 0));
const delayed = (source: Uint8Array, ms: number) => { const out = new Uint8Array(source.length); out.set(source.subarray(0, source.length - ms * 48), ms * 48); return out; };

test('without playback, input is forwarded unchanged and immediately', () => {
  const gate = new PlaybackEchoGate(), human = voice(7, 160);
  assert.deepEqual(gate.process(human, 1000), [human]);
});

test('residual echo during playback becomes silence of the same length', () => {
  const gate = new PlaybackEchoGate(), reply = voice(1, 3000);
  gate.begin(reply, 'reply', 0);
  for (const gain of [.3, .1, -.2]) {
    const gated = new PlaybackEchoGate(); gated.begin(reply, 'reply', 0);
    const output = feed(gated, mix(delayed(reply, 150), gain), 0);
    assert.ok(silent(output), `residual at gain ${gain}`);
    assert.equal(length(output) + 10 * 960, reply.length, 'only the decision lookahead is still held');
    assert.equal(gated.stats.openings, 0);
  }
});

test('a person speaking over Mia is forwarded including the onset, and the timeline is preserved', () => {
  const gate = new PlaybackEchoGate(), reply = voice(1, 3000);
  gate.begin(reply, 'reply', 0);
  const echo = mix(delayed(reply, 150), .05);
  feed(gate, echo.subarray(0, 1600 * 48), 0);
  const human = voice(7, 800, .5);
  const output = feed(gate, mix(echo.subarray(1600 * 48, 2400 * 48), 1, human), 1600);
  assert.equal(gate.stats.openings, 1);
  assert.equal(length(output), human.length, 'one forwarded or silent frame per captured frame');
  // The first 10 released frames were held before the person spoke; the
  // decision window may forward the last few of them as pre-roll.
  const frames = Array.from({ length: length(output) / 960 }, (_, i) => Buffer.concat(output).subarray(i * 960, (i + 1) * 960));
  assert.ok(silent(frames.slice(0, 7)));
  assert.ok(frames.slice(10).every(part => part.some(byte => byte !== 0)), 'speech is forwarded from its first frame');
});

test('the gate learns how strong the residual is, within bounds, per capture session', () => {
  const gate = new PlaybackEchoGate(), reply = voice(1, 6000);
  gate.begin(reply, 'reply', 0);
  feed(gate, mix(delayed(reply, 150), .01), 0);
  assert.equal(gate.coupling, -35, 'suppressed echo cannot turn the gate into a plain noise gate');
  gate.reset();
  assert.equal(gate.coupling, -15, 'a new session (e.g. after a route change) starts conservatively');
});

test('a long sentence over Mia stays forwarded: the person’s voice does not teach the gate', () => {
  const gate = new PlaybackEchoGate(), reply = voice(1, 7000);
  gate.begin(reply, 'reply', 0);
  const echo = mix(delayed(reply, 150), .05);
  feed(gate, echo.subarray(0, 2000 * 48), 0);
  const learned = gate.coupling;
  const output = feed(gate, mix(echo.subarray(2000 * 48, 6000 * 48), 1, voice(7, 4000, .12)), 2000);
  const frames = Array.from({ length: length(output) / 960 }, (_, i) => Buffer.concat(output).subarray(i * 960, (i + 1) * 960));
  const forwarded = frames.slice(10).filter(frame => frame.some(byte => byte !== 0)).length;
  assert.ok(forwarded >= frames.length - 10 - 3, `forwarded ${forwarded} of ${frames.length - 10} speech frames`);
  // Only the slow leak after 2 s of open gate (2.5 dB/s), not the voice itself.
  assert.ok(gate.coupling - learned <= (4000 - 2000) / 20 * .05 + .5, `coupling moved from ${learned} to ${gate.coupling}`);
});

test('flushing held input never produces a packet the server rejects', () => {
  const gate = new PlaybackEchoGate(), reply = voice(1, 1000);
  gate.begin(reply, 'reply', 0);
  const output = [...feed(gate, mix(delayed(reply, 150), .05), 0)];
  gate.end('reply', 1000);
  output.push(...gate.process(voice(7, 80), 1600));
  assert.ok(output.every(part => part.length <= 3840), `largest packet ${Math.max(...output.map(part => part.length))}`);
});

test('after playback ends and its tail expires, held input is flushed and forwarding resumes', () => {
  const gate = new PlaybackEchoGate(), reply = voice(1, 1000), human = voice(7, 160);
  gate.begin(reply, 'reply', 0);
  feed(gate, mix(delayed(reply, 150), .05), 0);
  gate.end('reply', 1000);
  const flushed = gate.process(human, 1600);
  assert.equal(length(flushed), 10 * 960 + human.length);
  assert.deepEqual(gate.process(human, 1800), [human]);
});

test('late completion of an older reply cannot end a newer reference', () => {
  const gate = new PlaybackEchoGate(), reply = voice(3, 2000);
  gate.begin(voice(1), 'old', 0); gate.begin(reply, 'new', 1000); gate.end('old', 1100);
  assert.ok(silent(feed(gate, mix(delayed(reply, 150), .1).subarray(0, 800 * 48), 1000)));
});
