import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioOwnership } from '../src/audio/ownership';
test('a stop revokes pending microphone permission before capture can start', async () => {
  const owner = new AudioOwnership(); let grant!: () => void; const permission = new Promise<void>(resolve => { grant = resolve; });
  const steps: string[] = [];
  const start = owner.transition(async current => { steps.push('permission'); await permission; if (current()) steps.push('microphone'); });
  await Promise.resolve();
  const stop = owner.transition(async () => { steps.push('stop'); });
  grant(); await Promise.all([start, stop]); assert.deepEqual(steps, ['permission', 'stop']);
});
test('audio acquisition is serial and a superseded acquire never starts playback', async () => {
  const owner = new AudioOwnership(); let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve; });
  const steps: string[] = [];
  const first = owner.transition(async current => { await held; if (current()) steps.push('first'); });
  const second = owner.transition(async current => { if (current()) steps.push('second'); });
  finish(); await Promise.all([first, second]); assert.deepEqual(steps, ['second']);
  await owner.transition(async () => { steps.push('stop'); }); assert.equal(steps.at(-1), 'stop');
});
