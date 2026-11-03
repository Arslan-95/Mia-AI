import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pcmLevel } from '../src/audio/level';

test('visual PCM meter handles silence, signed samples and clipped peaks without modifying audio', () => {
  assert.equal(pcmLevel(new Uint8Array()), 0);
  assert.equal(pcmLevel(new Uint8Array([0, 0, 0])), 0);
  const samples = new Uint8Array([0, 32, 0, 224]);
  assert.equal(pcmLevel(samples), .75);
  assert.deepEqual([...samples], [0, 32, 0, 224]);
  assert.equal(pcmLevel(new Uint8Array([255, 127, 0, 128])), 1);
});

test('playback meter follows the current audio window and returns silence beyond the end', () => {
  const bytes = new Uint8Array([0, 0, 0, 32, 0, 0]);
  assert.equal(pcmLevel(bytes, 0, 1), 0);
  assert.equal(pcmLevel(bytes, 1, 1), .75);
  assert.equal(pcmLevel(bytes, 2, 1), 0);
  assert.equal(pcmLevel(bytes, 999), 0);
});
