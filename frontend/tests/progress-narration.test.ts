import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgressNarration } from '../src/shared/audio/progressNarration';

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

test('source or final speech waits for the current phrase and excludes new updates while waiting and speaking', async () => {
  const narration = new ProgressNarration();
  let started!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const done = new Promise<void>(resolve => { finish = resolve; });
  let aborted = false, finishProgress!: () => void, priorityStarted = false;
  const progress = narration.offer(async (signal, onSpeaking) => {
    signal.addEventListener('abort', () => { aborted = true; });
    onSpeaking(); started(); await new Promise<void>(resolve => { finishProgress = resolve; });
  });
  await ready;
  const priority = narration.exclusive(async () => {
    priorityStarted = true;
    assert.equal(aborted, false);
    assert.equal(await narration.offer(async () => assert.fail('progress interrupted a source')), false);
    await done;
  });
  assert.equal(narration.hasPriority, true);
  assert.equal(await narration.offer(async () => assert.fail('queued a late update')), false);
  await Promise.resolve(); assert.equal(priorityStarted, false);
  finishProgress();
  finish(); await priority;
  assert.equal(await progress, true);
  assert.equal(narration.hasPriority, false);
  assert.equal(await narration.offer(async () => {}), true);
});

test('an explicit stop interrupts progress immediately even while the final reply is waiting', async () => {
  const narration = new ProgressNarration();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const progress = narration.offer(async (signal, onSpeaking) => {
    onSpeaking(); started(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  await ready;
  const final = narration.exclusive(async () => {});
  await narration.exclusive(async () => {}, { interruptProgress: true });
  await final;
  assert.equal(await progress, false);
});

test('a result does not wait for optional speech that has not started playing', async () => {
  const narration = new ProgressNarration();
  let requested!: () => void;
  const ready = new Promise<void>(resolve => { requested = resolve; });
  const progress = narration.offer(async signal => {
    requested(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  await ready;
  await narration.exclusive(async () => {});
  assert.equal(await progress, false);
});

test('a failed optional update and user cancellation leave later speech usable', async () => {
  const narration = new ProgressNarration();
  await assert.rejects(narration.offer(async () => { throw new Error('TTS unavailable'); }));
  const cancelled = narration.offer(async () => assert.fail('cancelled speech started'));
  narration.cancel(); assert.equal(await cancelled, false);
  await narration.exclusive(async () => {});
  assert.equal(await narration.offer(async () => {}), true);
});
