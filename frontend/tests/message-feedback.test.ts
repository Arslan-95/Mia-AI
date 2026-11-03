import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageFeedback, messageCuePcm } from '../src/shared/audio/messageFeedback';

const active = { userId: 'me', foreground: true, audioBusy: false };
const incoming = (id: string) => ({ id, senderId: 'friend' });

test('incoming feedback ignores own messages and duplicates and limits bursts without delayed alerts', () => {
  const played: string[] = [];
  const feedback = new MessageFeedback({ play: (_pcm, name) => played.push(name), stop() {} });
  feedback.receive({ id: 'own', senderId: 'me' }, active, 0);
  feedback.receive(incoming('first'), active, 0);
  feedback.receive(incoming('first'), active, 2000);
  feedback.receive(incoming('burst'), active, 100);
  feedback.receive(incoming('burst'), active, 2100);
  assert.equal(played.length, 1);
  feedback.receive(incoming('next'), active, 1500);
  assert.equal(played.length, 2);
});

test('background and busy audio stay silent on later retries; account reset clears feedback', () => {
  let played = 0, stopped = 0;
  const feedback = new MessageFeedback({ play: () => { played++; }, stop: () => { stopped++; } });
  feedback.receive(incoming('background'), { ...active, foreground: false }, 0);
  feedback.receive(incoming('recording'), { ...active, audioBusy: true }, 0);
  feedback.receive(incoming('background'), active, 3000);
  feedback.receive(incoming('recording'), active, 3000);
  assert.equal(played, 0);
  feedback.receive(incoming('new'), active, 3000);
  feedback.stop(); assert.equal(stopped, 1);
  feedback.reset(); assert.equal(stopped, 2);
  feedback.receive(incoming('new'), active, 3000);
  assert.equal(played, 2);
});

test('a feedback failure cannot interrupt incoming message handling', () => {
  const feedback = new MessageFeedback({ play() { throw new Error('Audio unavailable'); }, stop() {} });
  assert.doesNotThrow(() => feedback.receive(incoming('new'), active));
});

test('message chime is short, quiet and has silent edges without clipping', () => {
  const pcm = messageCuePcm(), view = new DataView(pcm.buffer);
  assert.equal(pcm.length / 48, 180);
  assert.equal(view.getInt16(0, true), 0);
  assert.equal(view.getInt16(pcm.length - 2, true), 0);
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
  assert.ok(peak > 2000 && peak < 4000);
});
