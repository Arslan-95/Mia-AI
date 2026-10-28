import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordBargeInGate, meaningfulSpeech } from '../src/speech/barge-in.js';

test('noise, empty recognition and annotation text do not interrupt Mia', () => {
  const gate = new WordBargeInGate(); gate.start(1);
  for (const text of ['', '...', '[noise]', '<inaudible>', 'um', 'hmm']) {
    assert.equal(gate.observe(1, text, false, 1000), false);
    assert.equal(gate.observe(1, text, true, 2000), false);
  }
});
test('one finalized word interrupts once and a stable partial can interrupt before endpointing', () => {
  const gate = new WordBargeInGate(); gate.start(1);
  assert.equal(gate.observe(1, 'Stop', true, 200), true);
  assert.equal(gate.observe(1, 'Stop', true, 300), false);
  gate.start(2);
  assert.equal(gate.observe(2, 'Open', false, 1000), false);
  assert.equal(gate.observe(2, 'Open Anna', false, 1120), false);
  assert.equal(gate.observe(2, 'Open Anna', false, 1200), true);
});
test('a single partial can become stable without a second provider event, and revisions cancel it', () => {
  const gate = new WordBargeInGate(); gate.start(1, true, true);
  assert.equal(gate.observe(1, 'Stop', false, 1000, false), false);
  assert.equal(gate.due(1), 1180);
  assert.equal(gate.confirmStable(1, 1179), false);
  assert.equal(gate.confirmStable(1, 1180), true);
  assert.equal(gate.confirmStable(1, 1300), false);
  assert.equal(gate.due(1), undefined);
  gate.start(2, true, true); gate.observe(2, 'Stop', false, 1000);
  gate.observe(2, '[noise]', false, 1100);
  assert.equal(gate.due(2), undefined); assert.equal(gate.confirmStable(2, 1300), false);
  gate.start(3, true); gate.observe(3, 'Stop', false, 1000, false);
  assert.equal(gate.due(3), undefined); assert.equal(gate.confirmStable(3, 1300), false);
});
test('a revised first word restarts stability and words need acoustic evidence on processed input', () => {
  const gate = new WordBargeInGate(); gate.start(1, true);
  assert.equal(gate.observe(1, 'Open', false, 1000), false);
  assert.equal(gate.observe(1, 'No', false, 1200), false);
  assert.equal(gate.observe(1, 'No', false, 1350), false);
  assert.equal(gate.observe(1, 'No', false, 1400), true);
  gate.start(2, true);
  assert.equal(gate.observe(2, 'the meeting starts at six', true, 2000, false), false);
  assert.equal(gate.meaningful(2, 'the meeting starts at six'), false);
  assert.equal(gate.observe(2, 'the meeting starts at six', true, 2100, true), true);
  assert.equal(gate.meaningful(2, 'the meeting starts at six'), true);
  assert.equal(meaningfulSpeech('Нет, открой другой чат'), true);
  assert.equal(meaningfulSpeech('2'), true);
  gate.start(3);
  assert.equal(gate.observe(3, 'Open', false, 1000), false);
  assert.equal(gate.observe(3, '[noise]', false, 1500), false);
  assert.equal(gate.observe(3, 'Open', false, 1600), false);
  assert.equal(gate.observe(3, 'Open', false, 1800), true);
});
