import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { DuplexAudio } from '../src/audio/duplex';
const root = fileURLToPath(new URL('../', import.meta.url).toString());
const bundle = build({ stdin: { contents: `export { DuplexAudio } from './src/audio/duplex';`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'native-voice', setup(build) {
    build.onResolve({ filter: /modules\/mia-voice$/ }, () => ({ path: 'voice', namespace: 'native-voice' }));
    build.onLoad({ filter: /.*/, namespace: 'native-voice' }, () => ({ contents: 'export default globalThis.__miaDuplexModule;' }));
  } }],
});
async function device() {
  const listeners = new Map<string, (value: any) => void>();
  let completeStart: (() => void) | undefined; let completeStop: (() => void) | undefined; let rejectPlayback: ((error: unknown) => void) | undefined;
  const native = {
    apiVersion: 3,
    waitForPermission: false, waitForStop: false, failStop: false, startFailure: '', starts: 0, stopped: 0, encoded: '',
    addListener(name: string, listener: (value: any) => void) { listeners.set(name, listener); return { remove() { listeners.delete(name); } }; },
    async start() { native.starts++; if (native.waitForPermission) await new Promise<void>(resolve => { completeStart = resolve; }); if (native.startFailure) throw { code: native.startFailure }; },
    async stop() { native.stopped++; if (native.waitForStop) await new Promise<void>(resolve => { completeStop = resolve; }); if (native.failStop) throw new Error('Native teardown failed'); },
    async stopPlayback() { rejectPlayback?.({ code: 'CANCELLED' }); rejectPlayback = undefined; },
    async play(audio: string) { native.encoded = audio; await new Promise((_resolve, reject) => { rejectPlayback = reject; }); },
  };
  (globalThis as any).__miaDuplexModule = native;
  const module = { exports: {} as { DuplexAudio: new (prepare?: () => Promise<void>) => DuplexAudio } };
  new Function('require', 'module', 'exports', (await bundle).outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
  return { native, audio: new module.exports.DuplexAudio(), createAudio: (prepare?: () => Promise<void>) => new module.exports.DuplexAudio(prepare), listeners, grant: () => completeStart?.(), finishStop: () => completeStop?.() };
}
test('duplex capture forwards original PCM and stops callbacks immediately when disabled', async () => {
  const { audio, listeners } = await device(); const heard: number[][] = [];
  await audio.start(bytes => heard.push([...bytes]), () => {}, () => {});
  listeners.get('pcm')!({ audio: 'AAECAw==' }); assert.deepEqual(heard, [[0, 1, 2, 3]]);
  await audio.stop(); assert.equal(audio.active, false); assert.equal(listeners.size, 0);
  delete (globalThis as any).__miaDuplexModule;
});
test('cancelling pending permission cannot activate a late capture graph', async () => {
  const { audio, native, grant, listeners } = await device(); native.waitForPermission = true;
  const starting = audio.start(() => {}, () => {}, () => {}); const rejected = assert.rejects(starting, error => (error as Error).constructor.name === 'CancelledError');
  await Promise.resolve();
  await audio.stop(); grant(); await rejected;
  assert.equal(audio.active, false); assert.equal(listeners.size, 0); delete (globalThis as any).__miaDuplexModule;
});

test('audio-session ownership survives asynchronous native shutdown and excludes an older unsafe binary', async () => {
  const { audio, native, finishStop, createAudio } = await device();
  await audio.start(() => {}, () => {}, () => {}); native.waitForStop = true;
  const stopped = audio.stop();
  assert.equal(audio.active, false); assert.equal(audio.ownsSession, true, 'another engine must not change the session while native teardown is pending');
  finishStop(); await stopped; assert.equal(audio.ownsSession, false);
  for (const version of [1, 2]) {
    native.apiVersion = version; const legacy = createAudio(); assert.equal(legacy.available, false);
    await assert.rejects(legacy.start(() => {}, () => {}, () => {}), /Update Mia/);
  }
  delete (globalThis as any).__miaDuplexModule;
});
test('interruption cancels PCM playback without closing the input graph', async () => {
  const { audio, native, listeners } = await device(); await audio.start(() => {}, () => {}, () => {});
  const playback = audio.playPcm(new Uint8Array([0, 128, 255, 127]), 'reply');
  const rejected = assert.rejects(playback, error => (error as Error).constructor.name === 'CancelledError');
  assert.equal(native.encoded, 'AID/fw=='); await audio.stopPlayback(); await rejected;
  assert.equal(audio.active, true); assert.ok(listeners.has('pcm')); assert.equal(native.stopped, 0);
  await audio.stop(); delete (globalThis as any).__miaDuplexModule;
});

test('input mute drops every microphone packet while leaving native playback and the graph alive', async () => {
  const { audio, native, listeners } = await device(); const heard: Uint8Array[] = [];
  await audio.start(bytes => heard.push(bytes), () => {}, () => {});
  const playback = audio.playPcm(new Uint8Array(48000), 'reply');
  const rejected = assert.rejects(playback, error => (error as Error).constructor.name === 'CancelledError');
  audio.setInputMuted(true);
  for (let i = 0; i < 5; i++) listeners.get('pcm')!({ audio: 'AAECAw==' });
  assert.equal(heard.length, 0); assert.equal(native.stopped, 0); assert.equal(audio.active, true); assert.equal(audio.hasInput, true);
  audio.setInputMuted(false);
  await audio.stopPlayback(); await rejected; await audio.stop();
});

test('voice-note capture receives original PCM while agent input is muted without restarting the graph', async () => {
  const { audio, native, listeners } = await device(); const heard: Uint8Array[] = [];
  await audio.start(bytes => heard.push(bytes), () => {}, () => {});
  audio.setInputMuted(true); audio.startRecording();
  listeners.get('pcm')!({ audio: 'AAECAw==' }); listeners.get('pcm')!({ audio: 'BAUGBw==' });
  assert.equal(heard.length, 0);
  assert.deepEqual([...audio.finishRecording()], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(audio.inputMuted, true); assert.equal(audio.active, true); assert.equal(native.starts, 1); assert.equal(native.stopped, 0);
  audio.startRecording(); listeners.get('pcm')!({ audio: 'AAECAw==' }); audio.cancelRecording();
  assert.throws(() => audio.finishRecording());
  audio.setInputMuted(false); listeners.get('pcm')!({ audio: 'CAkKCw==' }); assert.deepEqual([...heard[0]!], [8, 9, 10, 11]);
  await audio.stop(); delete (globalThis as any).__miaDuplexModule;
});

test('speaker PCM is gated on the real capture path and input resumes unchanged after playback', async t => {
  const { audio, listeners } = await device(); const heard: Uint8Array[] = [];
  await audio.start(bytes => heard.push(bytes), () => {}, () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const source = new Uint8Array(48000), view = new DataView(source.buffer);
    for (let i = 0; i < source.length / 2; i++) view.setInt16(i * 2, Math.round(4000 * Math.sin(i * .1)), true);
    const playback = audio.playPcm(source, 'reply'); const cancelled = assert.rejects(playback, error => (error as Error).constructor.name === 'CancelledError');
    const echo = new Uint8Array(3840), echoView = new DataView(echo.buffer);
    for (let i = 0; i < echo.length / 2; i++) echoView.setInt16(i * 2, Math.round(400 * Math.sin(i * .1)), true);
    for (let packet = 0; packet < 10; packet++) { t.mock.timers.tick(80); listeners.get('pcm')!({ audio: Buffer.from(echo).toString('base64') }); }
    assert.equal(Buffer.concat(heard).length, 10 * 3840 - 10 * 960, 'all but the decision lookahead is forwarded, as silence');
    assert.equal(heard.every(part => part.every(byte => byte === 0)), true);
    await audio.stopPlayback(); await cancelled;
    t.mock.timers.tick(600); heard.length = 0;
    const user = new Uint8Array(3840), humanView = new DataView(user.buffer);
    for (let i = 0; i < user.length / 2; i++) humanView.setInt16(i * 2, Math.round(4000 * Math.sin(i * .247)), true);
    listeners.get('pcm')!({ audio: Buffer.from(user).toString('base64') });
    const flushed = Buffer.concat(heard);
    assert.equal(flushed.subarray(0, 10 * 960).every(byte => byte === 0), true, 'held echo is released as silence');
    assert.equal(flushed.subarray(10 * 960).equals(Buffer.from(user)), true, 'speech after playback is forwarded unchanged');
    heard.length = 0; listeners.get('pcm')!({ audio: Buffer.from(user).toString('base64') });
    assert.equal(Buffer.from(heard[0]!).equals(Buffer.from(user)), true);
    assert.equal(audio.active, true);
  } finally { await audio.stop(); t.mock.timers.reset(); delete (globalThis as any).__miaDuplexModule; }
});

test('native start waits for the previous graph and Expo cleanup, and cancellation during handoff never starts it', async () => {
  const { native, createAudio, finishStop } = await device();
  let release!: () => void; let preparing = false;
  const audio = createAudio(async () => { preparing = true; await new Promise<void>(resolve => { release = resolve; }); });
  const first = audio.start(() => {}, () => {}, () => {});
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(preparing, true); assert.equal(native.starts, 0); assert.equal(audio.ownsSession, true);
  release(); await first;
  native.waitForStop = true; preparing = false;
  const second = audio.start(() => {}, () => {}, () => {});
  const rejected = assert.rejects(second, error => (error as Error).constructor.name === 'CancelledError');
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(preparing, false, 'Expo cleanup must wait until the previous native graph is gone');
  native.waitForStop = false; finishStop();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(preparing, true);
  await audio.stop(); release(); await rejected;
  assert.equal(native.starts, 1); assert.equal(audio.active, false);
  delete (globalThis as any).__miaDuplexModule;
});

test('a failed native teardown never releases the session to Expo during a retry', async () => {
  const { audio, native } = await device();
  await audio.start(() => {}, () => {}, () => {}); native.failStop = true;
  await assert.rejects(audio.stop());
  assert.equal(audio.ownsSession, true);
  await assert.rejects(audio.start(() => {}, () => {}, () => {}));
  assert.equal(audio.ownsSession, true, 'failed shutdown remains exclusive until a successful stop');
  native.failStop = false; await audio.stop(); assert.equal(audio.ownsSession, false);
  delete (globalThis as any).__miaDuplexModule;
});

test('a running graph with no input frames reports a recoverable capture failure, but permission waiting has no watchdog', async t => {
  const { audio, native, grant, listeners } = await device(); native.waitForPermission = true;
  const failures: unknown[] = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const starting = audio.start(() => {}, () => {}, error => failures.push(error));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    t.mock.timers.tick(60000); assert.equal(failures.length, 0, 'the user may still be reading the permission dialog');
    grant(); await starting;
    assert.equal(audio.hasInput, false);
    listeners.get('pcm')!({ audio: 'AAA=' }); assert.equal(audio.hasInput, true);
    t.mock.timers.tick(8000);
    assert.equal(failures.length, 1, 'a live graph must not silently stop delivering input forever');
    assert.equal((failures[0] as Error).constructor.name, 'VoiceCaptureUnavailable');
    await audio.stop(); t.mock.timers.tick(60000); assert.equal(failures.length, 1);
  } finally { await audio.stop(); t.mock.timers.reset(); delete (globalThis as any).__miaDuplexModule; }
});

test('captured silence keeps native input healthy and an old watchdog cannot affect a restarted graph', async t => {
  const { audio, listeners } = await device(); let failures = 0;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await audio.start(() => {}, () => {}, () => { failures++; });
    for (let i = 0; i < 10; i++) { t.mock.timers.tick(7000); listeners.get('pcm')!({ audio: 'AAA=' }); }
    assert.equal(failures, 0);
    await audio.stop(); await audio.start(() => {}, () => {}, () => { failures++; });
    assert.equal(audio.hasInput, false); t.mock.timers.tick(7999); assert.equal(failures, 0);
    await audio.stop(); t.mock.timers.tick(60000); assert.equal(failures, 0);
  } finally { await audio.stop(); t.mock.timers.reset(); delete (globalThis as any).__miaDuplexModule; }
});

test('an OS cancellation without a JS stop is recoverable instead of silently stranding startup', async () => {
  const { audio, native, listeners } = await device(); native.startFailure = 'CANCELLED';
  await assert.rejects(audio.start(() => {}, () => {}, () => {}), error => (error as Error).constructor.name === 'VoiceCaptureUnavailable');
  assert.equal(audio.active, false); assert.equal(audio.ownsSession, false); assert.equal(listeners.size, 0);
  native.startFailure = ''; await audio.start(() => {}, () => {}, () => {});
  assert.equal(audio.active, true); await audio.stop();
  delete (globalThis as any).__miaDuplexModule;
});
