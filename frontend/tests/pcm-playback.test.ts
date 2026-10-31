import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PcmPlayback } from '../src/audio/pcmPlayback';
import { CancelledError } from '../src/errors';
import type { PlaybackProgress } from '../src/audio/types';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
test('native pause freezes progress and resumes only the remaining original samples', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const pcm = Uint8Array.from({ length: 240000 }, (_, i) => i % 251);
  const parts: Uint8Array[] = [], progress: PlaybackProgress[] = [];
  let finish!: () => void, reject!: (error: Error) => void, completed = false;
  const player = new PcmPlayback(pcm, bytes => { parts.push(bytes); return new Promise<void>((yes, no) => { finish = yes; reject = no; }); }, async () => { reject(new CancelledError()); });
  try {
    const task = player.play(new AbortController().signal, value => progress.push(value)).then(() => { completed = true; });
    await flush(); t.mock.timers.tick(1250); await player.pause(); await flush();
    t.mock.timers.tick(180000); await flush();
    assert.equal(completed, false); assert.equal(progress.at(-1)?.positionMs, 1250); assert.equal(parts.length, 1);
    player.resume(); await flush();
    assert.equal(parts.length, 2); assert.deepEqual(parts[1], pcm.subarray(60000));
    finish(); await task;
    assert.equal(progress.at(-1)?.positionMs, 5000); assert.equal(completed, true);
  } finally { t.mock.timers.reset(); }
});

test('stopping a paused native message rejects its pending completion and cannot resume later', async () => {
  let reject!: (error: Error) => void;
  const player = new PcmPlayback(new Uint8Array(48000), () => new Promise<void>((_, no) => { reject = no; }), async () => { reject(new CancelledError()); });
  const controller = new AbortController();
  const task = player.play(controller.signal); const rejected = assert.rejects(task, CancelledError);
  await flush(); await player.pause(); await flush(); controller.abort(); await rejected;
  player.resume();
});

test('cancellation during the initial player handoff cannot start late audio', async () => {
  let starts = 0;
  const player = new PcmPlayback(new Uint8Array(48000), async () => { starts++; }, async () => {});
  const controller = new AbortController();
  const task = player.play(controller.signal);
  controller.abort();
  await assert.rejects(task, CancelledError);
  assert.equal(starts, 0);
});
