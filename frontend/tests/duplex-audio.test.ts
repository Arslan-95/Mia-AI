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
    apiVersion: 2,
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
  native.apiVersion = 1; const legacy = createAudio(); assert.equal(legacy.available, false);
  await assert.rejects(legacy.start(() => {}, () => {}, () => {}), /Update Mia/);
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
