import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CancelledError } from '../src/errors';
import { UtteranceDetector } from '../src/audio/utterance';
import { VoiceConversation, voiceDelay, type VoiceRuntime } from '../src/voiceConversation';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const recording = { uri: 'file:///command.wav', durationMs: 2500 };
const tick = () => new Promise(resolve => setImmediate(resolve));
function runtime(overrides: Partial<VoiceRuntime> = {}): VoiceRuntime {
  return {
    ready: () => true, phase: () => {}, capture: async signal => { await voiceDelay(10000, signal); return null; },
    transcribe: async () => 'Open Anna’s conversation', discard: async () => {}, respond: async () => {}, ...overrides,
  };
}

test('silence and a short bump never become commands; quiet speech ends after a pause', () => {
  const quiet = new UtteranceDetector(0);
  assert.equal(quiet.update(100, -80), 'continue');
  assert.equal(quiet.update(7900, -80), 'continue');
  assert.equal(quiet.update(8000, -80), 'silence');
  const bump = new UtteranceDetector(0);
  bump.update(100, -20); bump.update(200, -80);
  assert.equal(bump.update(8000, -80), 'silence');
  const speech = new UtteranceDetector(0);
  for (let now = 100; now <= 700; now += 100) assert.equal(speech.update(now, -40), 'continue');
  assert.equal(speech.update(1700, -80), 'continue');
  assert.equal(speech.update(1800, -80), 'speech');
});

test('continuous speech is bounded and a brief pause does not split a sentence', () => {
  const detector = new UtteranceDetector(0);
  for (let now = 100; now <= 600; now += 100) detector.update(now, -30);
  assert.equal(detector.update(1400, -75), 'continue');
  assert.equal(detector.update(1500, -30), 'continue');
  assert.equal(detector.update(25000, -30), 'speech');
});

test('a short spoken confirmation is recognized as speech', () => {
  const detector = new UtteranceDetector(0);
  detector.update(50, -35); detector.update(100, -35); detector.update(150, -35);
  assert.equal(detector.update(1250, -80), 'speech');
});

test('one activation automatically transcribes, runs the command, waits for spoken playback, then listens again', async () => {
  const conversation = new VoiceConversation();
  const speaking = deferred(); const playbackFinished = deferred(); const listeningAgain = deferred();
  const steps: string[] = []; let captures = 0;
  const task = conversation.start(runtime({
    phase: phase => { steps.push(phase); },
    async capture(signal) {
      if (++captures === 1) return recording;
      listeningAgain.resolve(); await voiceDelay(10000, signal); return null;
    },
    async transcribe(value) { assert.equal(value, recording); steps.push('asr'); return 'Open Anna'; },
    async discard(value) { assert.equal(value, recording); steps.push('deleted'); },
    async respond(text) { assert.equal(text, 'Open Anna'); steps.push('command'); speaking.resolve(); await playbackFinished.promise; },
  }));
  await speaking.promise;
  assert.equal(captures, 1);
  await tick(); assert.equal(captures, 1, 'no capture while the assistant is speaking');
  playbackFinished.resolve(); await listeningAgain.promise;
  await conversation.stop(); await task.catch(() => {});
  assert.deepEqual(steps.slice(0, 7), ['listening', 'transcribing', 'asr', 'deleted', 'thinking', 'command', 'listening']);
});

test('turning the mode off during recognition deletes its recording and never submits the late transcript', async () => {
  const conversation = new VoiceConversation(); const recognizing = deferred(); const transcript = deferred<string>();
  let submitted = 0; let deleted = 0;
  const task = conversation.start(runtime({
    capture: async () => recording,
    transcribe: async () => { recognizing.resolve(); return transcript.promise; },
    discard: async () => { deleted++; }, respond: async () => { submitted++; },
  }));
  await recognizing.promise;
  const stop = conversation.stop(); transcript.resolve('Send that message');
  await stop; await assert.rejects(task, CancelledError);
  assert.equal(deleted, 1); assert.equal(submitted, 0);
});

test('empty recognition and idle microphone windows do not create assistant turns', async () => {
  const conversation = new VoiceConversation(); const reached = deferred(); let captures = 0; let submitted = 0; let deleted = 0;
  const task = conversation.start(runtime({
    async capture(signal) {
      if (++captures === 1) return null;
      if (captures === 2) return recording;
      reached.resolve(); await voiceDelay(10000, signal); return null;
    },
    transcribe: async () => '  ', discard: async () => { deleted++; }, respond: async () => { submitted++; },
  }));
  await reached.promise; await conversation.stop(); await task.catch(() => {});
  assert.equal(deleted, 1); assert.equal(submitted, 0);
});

test('rapid restarts serialize microphone cleanup and abandon superseded activations', async () => {
  const conversation = new VoiceConversation(); const capturing = deferred(); const cleaned = deferred(); const resumed = deferred();
  const steps: string[] = [];
  const first = conversation.start(runtime({ capture: async signal => {
    steps.push('first capture'); capturing.resolve();
    try { await voiceDelay(10000, signal); } finally { await cleaned.promise; steps.push('cleanup'); }
    return null;
  } }));
  await capturing.promise;
  const second = conversation.start(runtime({ capture: async () => { steps.push('stale capture'); return null; } }));
  const third = conversation.start(runtime({ capture: async signal => { steps.push('new capture'); resumed.resolve(); await voiceDelay(10000, signal); return null; } }));
  await tick(); assert.deepEqual(steps, ['first capture']);
  cleaned.resolve(); await resumed.promise;
  await conversation.stop(); await Promise.all([first, second, third].map(task => task.catch(() => {})));
  assert.deepEqual(steps, ['first capture', 'cleanup', 'new capture']);
});

test('recognition failures clean up and stop instead of repeatedly uploading recordings', async () => {
  const conversation = new VoiceConversation(); let captures = 0; let deleted = 0;
  await assert.rejects(conversation.start(runtime({
    capture: async () => { captures++; return recording; },
    transcribe: async () => { throw new Error('offline'); }, discard: async () => { deleted++; },
  })), /offline/);
  assert.equal(captures, 1); assert.equal(deleted, 1); await conversation.stop();
});

test('manual audio pauses command capture until the microphone is available again', async () => {
  const conversation = new VoiceConversation(); const resumed = deferred(); let ready = false; let captures = 0;
  const task = conversation.start(runtime({
    ready: () => ready,
    capture: async signal => { captures++; resumed.resolve(); await voiceDelay(10000, signal); return null; },
  }));
  await tick(); assert.equal(captures, 0); ready = true; await resumed.promise;
  await conversation.stop(); await task.catch(() => {}); assert.equal(captures, 1);
});
