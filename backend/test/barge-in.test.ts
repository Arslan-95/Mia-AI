import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlaybackEcho, WordBargeInGate, meaningfulSpeech } from '../src/speech/barge-in.js';

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
  assert.equal(gate.userText(2, 'the meeting starts at six'), '');
  assert.equal(gate.observe(2, 'the meeting starts at six', true, 2100, true), true);
  assert.equal(gate.userText(2, 'the meeting starts at six'), 'the meeting starts at six');
  assert.equal(meaningfulSpeech('No, open another chat'), true);
  assert.equal(meaningfulSpeech('2'), true);
  gate.start(3);
  assert.equal(gate.observe(3, 'Open', false, 1000), false);
  assert.equal(gate.observe(3, '[noise]', false, 1500), false);
  assert.equal(gate.observe(3, 'Open', false, 1600), false);
  assert.equal(gate.observe(3, 'Open', false, 1800), true);
});
test('Mia’s own words heard during playback neither interrupt her nor become a turn', () => {
  const playback = new PlaybackEcho();
  playback.remember('a', 'Anna wrote that the meeting starts at six. Should I reply?');
  playback.start('a', 1000);
  const gate = new WordBargeInGate(); gate.start(1, true, true); gate.hear(1, playback.at(1200));
  for (const text of ['Anna', 'Anna wrote', 'Anna wrote that the meet', 'Anna wrote that the meeting starts at six'])
    assert.equal(gate.observe(1, text, false, 1400), false);
  assert.equal(gate.due(1), undefined);
  assert.equal(gate.observe(1, 'Anna wrote that the meeting start at six.', true, 3000), false, 'recognition errors on the echo are tolerated');
  assert.equal(gate.userText(1, 'Anna wrote that the meeting start at six.'), '');
});
test('during playback a person needs two words of their own, and echo before them is dropped', () => {
  const playback = new PlaybackEcho();
  playback.remember('a', 'Anna said the meeting starts at six. Should I reply?');
  playback.start('a', 1000);
  const gate = new WordBargeInGate(); gate.start(1, true, true); gate.hear(1, playback.at(1500));
  assert.equal(gate.observe(1, 'the meeting starts ok', true, 1600), false, 'one stray word over Mia does not interrupt');
  assert.equal(gate.userText(1, 'the meeting starts ok'), '');
  gate.start(2, true, true); gate.hear(2, playback.at(1700));
  assert.equal(gate.observe(2, 'the meeting starts no open', false, 1700), false);
  assert.equal(gate.observe(2, 'the meeting starts no open Boris', false, 1880), true);
  assert.equal(gate.userText(2, 'The meeting starts. No, open Boris.'), 'No, open Boris.');
});
test('after playback, a quick answer repeating one offered option is the person’s, and the tail expires', () => {
  const playback = new PlaybackEcho();
  playback.remember('a', 'Send it to Anna or Boris?');
  playback.start('a', 1000); playback.stop('a', 3000);
  const gate = new WordBargeInGate(); gate.start(1, true, true);
  const tail = playback.at(3400);
  assert.equal(tail.playing, false); assert.equal(tail.references.length, 1);
  gate.hear(1, tail);
  assert.equal(gate.observe(1, 'Boris', true, 3600), true);
  assert.equal(gate.userText(1, 'Boris'), 'Boris');
  gate.start(2, true, true); gate.hear(2, playback.at(3500));
  assert.equal(gate.observe(2, 'Anna or Boris', true, 3600), false, 'trailing echo is still filtered');
  assert.deepEqual(playback.at(4600).references, []);
  playback.start('unknown', 5000);
  assert.deepEqual(playback.at(5100), { playing: false, references: [] }, 'only responses synthesized on this socket are references');
});
test('a playback that is never reported finished expires', () => {
  const playback = new PlaybackEcho();
  playback.remember('a', 'Hello there'); playback.start('a', 0);
  assert.equal(playback.at(299_000).playing, true);
  assert.equal(playback.at(302_000).playing, false);
});
test('numbers Mia reads out in words are still her echo', () => {
  const playback = new PlaybackEcho();
  playback.remember('a', 'Your meeting is at 3:30 on Oct 5.');
  playback.start('a', 0);
  const gate = new WordBargeInGate(); gate.start(1, true, true); gate.hear(1, playback.at(500));
  assert.equal(gate.observe(1, 'your meeting is at three thirty', true, 900), false);
  assert.equal(gate.userText(1, 'your meeting is at three thirty'), '');
});
test('an utterance that began over Mia and ends after her is the person’s, and the tail compares only her last words', () => {
  const playback = new PlaybackEcho();
  playback.remember('a', 'Anna wrote that the meeting moved. Should I send the reply to Anna or to Maria?');
  playback.start('a', 0);
  const gate = new WordBargeInGate(); gate.start(1, true, true); gate.hear(1, playback.at(4000));
  assert.equal(gate.observe(1, 'Yes', false, 4000), false);
  playback.stop('a', 4100); gate.hear(1, playback.at(4300));
  assert.equal(gate.observe(1, 'Yes', true, 4300), true);
  assert.equal(gate.userText(1, 'Yes'), 'Yes');
  gate.start(2, true, true); gate.hear(2, playback.at(4400));
  assert.equal(gate.observe(2, 'Anna wrote', true, 4500), true, 'the start of her reply is not in flight any more');
});
test('digits the person says are never matched against different digits or words of Mia', () => {
  const playback = new PlaybackEcho();
  playback.remember('a', 'What time should I set the alarm for?');
  playback.remember('b', 'Free at 3 and at 5. Which time works?');
  playback.start('a', 0); playback.stop('a', 2000);
  const gate = new WordBargeInGate(); gate.start(1, true, true); gate.hear(1, playback.at(2300));
  assert.equal(gate.observe(1, 'at 7 30', true, 2500), true);
  assert.equal(gate.userText(1, 'at 7 30'), 'at 7 30');
  playback.start('b', 5000);
  gate.start(2, true, true); gate.hear(2, playback.at(5500));
  assert.equal(gate.observe(2, 'no make it 8 tonight', false, 5500), false);
  assert.equal(gate.observe(2, 'no make it 8 tonight', true, 5700), true);
  assert.equal(gate.userText(2, 'no make it 8 tonight'), 'no make it 8 tonight');
});
test('recognition merging or splitting Mia’s words is still her echo, and trailing echo is cut', () => {
  const playback = new PlaybackEcho();
  playback.remember('a', 'The note book reminder is set. Anything else?');
  playback.start('a', 0);
  const gate = new WordBargeInGate(); gate.start(1, true, true); gate.hear(1, playback.at(500));
  assert.equal(gate.observe(1, 'the notebook reminder is set any thing else', true, 900), false);
  assert.equal(gate.userText(1, 'the notebook reminder is set any thing else'), '');
  playback.remember('b', 'Anna said the meeting starts at six. Should I reply?');
  playback.start('b', 3000);
  gate.start(2, true, true); gate.hear(2, playback.at(3500));
  assert.equal(gate.observe(2, 'no open Boris the meeting starts at six', true, 3700), true);
  assert.equal(gate.userText(2, 'No, open Boris. The meeting starts at six.'), 'No, open Boris.');
});
test('common short pairs are not echo on their own', () => {
  const playback = new PlaybackEcho();
  playback.remember('a', 'I do not see that contact, and I do not know whether the number is right.');
  playback.start('a', 0);
  const gate = new WordBargeInGate(); gate.start(1, true, true); gate.hear(1, playback.at(500));
  assert.equal(gate.observe(1, 'I do prefer another', true, 900), true);
  assert.equal(gate.userText(1, 'I do prefer another'), 'I do prefer another');
});
