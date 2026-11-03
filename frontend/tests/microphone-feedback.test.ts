import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MicrophoneFeedback, microphoneCuePcm } from '../src/shared/audio/microphoneFeedback';

test('ready microphone plays once after 200 ms, including the first ready state', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cues: boolean[] = [];
  const feedback = new MicrophoneFeedback({ play: enabled => cues.push(enabled), stop() {} });
  feedback.update(true);
  t.mock.timers.tick(199); assert.deepEqual(cues, []);
  t.mock.timers.tick(1); assert.deepEqual(cues, [true]);
  feedback.update(true); t.mock.timers.tick(1000); assert.deepEqual(cues, [true]);
  feedback.update(false); t.mock.timers.tick(200); assert.deepEqual(cues, [true, false]);
  feedback.update(true); t.mock.timers.tick(200); assert.deepEqual(cues, [true, false, true]);
  feedback.reset();
});

test('disabled startup is silent and quick reversals cancel outdated cues', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cues: boolean[] = [];
  const feedback = new MicrophoneFeedback({ play: enabled => cues.push(enabled), stop() {} });
  feedback.update(false); t.mock.timers.tick(1000); assert.deepEqual(cues, []);
  feedback.update(true); t.mock.timers.tick(100);
  feedback.update(false); t.mock.timers.tick(100); assert.deepEqual(cues, []);
  feedback.update(true); t.mock.timers.tick(199); assert.deepEqual(cues, []);
  t.mock.timers.tick(1); assert.deepEqual(cues, [true]);
  feedback.reset();
});

test('background, failed startup and disposal cancel pending feedback and stop a playing cue', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cues: boolean[] = []; let stops = 0;
  const feedback = new MicrophoneFeedback({ play: enabled => cues.push(enabled), stop() { stops++; } });
  feedback.update(true); t.mock.timers.tick(100); feedback.reset();
  t.mock.timers.tick(1000); assert.deepEqual(cues, []);
  feedback.update(true); t.mock.timers.tick(200); assert.deepEqual(cues, [true]);
  const previous = stops; feedback.pause(); assert.equal(stops, previous + 1);
  feedback.update(true); t.mock.timers.tick(1000); assert.deepEqual(cues, [true], 'temporary media capture does not reannounce the same state');
  feedback.reset();
});

test('feedback playback failure cannot break microphone state transitions', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const feedback = new MicrophoneFeedback({ play() { throw new Error('Audio interrupted'); }, stop() {} });
  feedback.update(true); assert.doesNotThrow(() => t.mock.timers.tick(200));
  feedback.update(false); assert.doesNotThrow(() => t.mock.timers.tick(200));
  feedback.reset();
});

test('on and off cues are short, distinct, unclipped PCM with silent edges', () => {
  const on = microphoneCuePcm(true), off = microphoneCuePcm(false);
  assert.equal(on.length / 48, 162);
  assert.equal(off.length, on.length);
  assert.notDeepEqual(on, off);
  for (const pcm of [on, off]) {
    const samples = new DataView(pcm.buffer);
    assert.equal(samples.getInt16(0, true), 0);
    assert.equal(samples.getInt16(pcm.length - 2, true), 0);
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(samples.getInt16(i, true)));
    assert(peak > 8000 && peak < 15000);
  }
});
