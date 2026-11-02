import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgressNarration } from '../src/audio/progressNarration';

test('a current update finishes naturally while excess updates are dropped without a backlog', async () => {
  const narration = new ProgressNarration();
  const heard: string[] = [];
  let started!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const done = new Promise<void>(resolve => { finish = resolve; });
  const first = narration.offer(async () => {
    heard.push('finding'); started();
    await done;
  });
  await ready;
  const second = narration.offer(async () => { heard.push('preparing'); });
  const third = narration.offer(async () => { heard.push('ready'); });
  assert.deepEqual(await Promise.all([second, third]), [false, false]);
  finish(); assert.equal(await first, true);
  assert.equal(await narration.offer(async () => { heard.push('ready'); }), true);
  assert.deepEqual(heard, ['finding', 'ready']);
});

test('source or final speech cancels progress and excludes new updates for its entire lifetime', async () => {
  const narration = new ProgressNarration();
  let started!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const done = new Promise<void>(resolve => { finish = resolve; });
  let aborted = false;
  const progress = narration.offer(async signal => {
    started(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
  });
  await ready;
  const priority = narration.exclusive(async () => {
    assert.equal(aborted, true);
    assert.equal(await narration.offer(async () => assert.fail('progress interrupted a source')), false);
    await done;
  });
  assert.equal(narration.hasPriority, true);
  finish(); await priority;
  assert.equal(await progress, false);
  assert.equal(narration.hasPriority, false);
  assert.equal(await narration.offer(async () => {}), true);
});

test('a failed optional update and user cancellation leave later speech usable', async () => {
  const narration = new ProgressNarration();
  await assert.rejects(narration.offer(async () => { throw new Error('TTS unavailable'); }));
  const cancelled = narration.offer(async () => assert.fail('cancelled speech started'));
  narration.cancel(); assert.equal(await cancelled, false);
  await narration.exclusive(async () => {});
  assert.equal(await narration.offer(async () => {}), true);
});
