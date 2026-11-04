import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamedSpeech } from '../src/shared/audio/streamedSpeech';

test('speech starts before synthesis finishes, queues native batches and waits for their playback', async () => {
  const releases: (() => void)[] = [];
  const played: number[] = [];
  let starts = 0;
  let settled = false;
  const stream = new StreamedSpeech(bytes => {
    played.push(bytes.length);
    return new Promise<void>(resolve => releases.push(resolve));
  }, () => { starts++; }, error => { assert.equal(error, undefined); settled = true; });

  stream.push(new Uint8Array(4000));
  assert.equal(starts, 0);
  stream.push(new Uint8Array(8000));
  assert.equal(starts, 1);
  stream.push(new Uint8Array(12000));
  stream.push(new Uint8Array(2000));
  stream.finish();
  assert.deepEqual(played, [12000, 12000]);
  assert.equal(settled, false);
  releases[0]!();
  await Promise.resolve();
  assert.deepEqual(played, [12000, 12000, 2000]);
  releases[1]!();
  releases[2]!();
  await Promise.resolve();
  assert.equal(settled, true);
});

test('cancelled speech never queues more audio after outstanding native batches finish', async () => {
  const releases: (() => void)[] = [];
  const stream = new StreamedSpeech(() => new Promise<void>(resolve => releases.push(resolve)),
    () => {}, () => assert.fail('Cancelled playback must not report success'));
  for (let part = 0; part < 3; part++) stream.push(new Uint8Array(12000));
  stream.cancel();
  stream.finish();
  releases.forEach(resolve => resolve());
  await Promise.resolve();
  assert.equal(releases.length, 2);
});
