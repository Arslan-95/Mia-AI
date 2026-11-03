import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Engine } from '../src/audio/engine';
import type { PlaybackProgress } from '../src/audio/types';
import { pcmWav } from '../src/audio/wav';

const root = fileURLToPath(new URL('../', import.meta.url).toString()).replaceAll('\\', '/');
const bundle = build({
  stdin: { contents: `export { Engine } from './src/audio/engine'; export { MicrophoneCuePlayer } from './src/audio/microphoneCuePlayer'; export { LocalCuePlayer } from './src/audio/localCuePlayer';`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'audio-device', setup(build) {
    build.onResolve({ filter: /^(expo-audio|expo-file-system)$/ }, args => ({ path: args.path, namespace: 'audio-device' }));
    build.onLoad({ filter: /.*/, namespace: 'audio-device' }, args => ({ contents: args.path === 'expo-audio' ? `
      const n = globalThis.__miaAudio;
      export const AudioQuality = { MAX: 1 }, IOSOutputFormat = { LINEARPCM: 1 };
      export const setAudioModeAsync = async mode => { n.modes.push(mode); };
      export const AudioModule = {
        requestRecordingPermissionsAsync: async () => n.permission,
        AudioRecorder: class {
          constructor(options) { n.options = options; n.created++; this.uri = 'file:///command.wav'; }
          async prepareToRecordAsync() {}
          record() { this.active = true; n.files.add(this.uri); }
          async stop() { this.active = false; }
          release() { n.released++; }
          getStatus() { n.samples++; return { isRecording: this.active, metering: n.level(n.samples), durationMillis: n.nativeDuration }; }
        }
      };
      export function createAudioPlayer(source, options) {
        n.playerSources.push(source);
        n.playerOptions.push(options);
        return { addListener(_, callback) { n.status = callback; return { remove() { n.removed++; } }; },
          play() { if (n.failPlay) throw new Error('Native player failure'); }, pause() {}, release() { n.playersReleased++; } };
      }
    ` : `
      const n = globalThis.__miaAudio;
      export const Paths = { cache: 'file:///cache' };
      export class File {
        constructor(...parts) { this.uri = parts.join('/'); }
        get exists() { return n.files.has(this.uri); }
        write(bytes) { n.files.add(this.uri); n.fileData.set(this.uri, bytes); }
        async bytes() { return n.fileData.get(this.uri); }
        delete() { n.files.delete(this.uri); }
      }
    ` }));
  } }],
});

async function device() {
  const n = { permission: Promise.resolve({ granted: true }), options: {} as any, modes: [] as unknown[], created: 0, released: 0,
    samples: 0, files: new Set<string>(), fileData: new Map<string, Uint8Array>(), level: (_sample: number) => -80, nativeDuration: undefined as number | undefined,
    playerSources: [] as { uri: string; headers?: Record<string, string> }[], playerOptions: [] as { keepAudioSessionActive?: boolean }[], failPlay: false, removed: 0, playersReleased: 0, status: (_status: any) => {} };
  (globalThis as any).__miaAudio = n;
  const module = { exports: {} as { Engine: new () => Engine; MicrophoneCuePlayer: typeof import('../src/audio/microphoneCuePlayer').MicrophoneCuePlayer; LocalCuePlayer: typeof import('../src/audio/localCuePlayer').LocalCuePlayer } };
  new Function('require', 'module', 'exports', (await bundle).outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
  return { n, engine: new module.exports.Engine(), CuePlayer: module.exports.MicrophoneCuePlayer, LocalCuePlayer: module.exports.LocalCuePlayer };
}
async function flush() { for (let n = 0; n < 20; n++) await Promise.resolve(); }

test('message cues preserve the audio session, register actual playback for echo protection and clean up', async () => {
  const { n, LocalCuePlayer } = await device();
  const started: string[] = [], ended: string[] = [];
  const player = new LocalCuePlayer((_pcm, id) => started.push(id), id => ended.push(id));
  try {
    player.play(new Uint8Array(8640), 'message-soft-v1');
    assert.deepEqual(n.modes, []);
    assert.equal(n.created, 0);
    assert.equal(n.playerOptions[0]!.keepAudioSessionActive, true);
    assert.equal(started.length, 0);
    n.status({ playing: true });
    assert.equal(started.length, 1);
    player.stop();
    assert.deepEqual(ended, started);
    assert.equal(n.playersReleased, 1);
    n.status({ playing: true });
    assert.equal(started.length, 1, 'late callbacks cannot restart a stopped cue');
  } finally { player.stop(); delete (globalThis as any).__miaAudio; }
});

test('microphone feedback uses an independent local player without reconfiguring or deactivating capture', async () => {
  const { n, CuePlayer } = await device();
  const started: string[] = [], ended: string[] = [];
  const player = new CuePlayer((_pcm, id) => started.push(id), id => ended.push(id));
  player.play(true);
  assert.equal(n.created, 0, 'feedback never opens a recorder');
  assert.deepEqual(n.modes, [], 'feedback never changes the shared audio mode');
  assert.equal(n.playerOptions[0]!.keepAudioSessionActive, true);
  assert.match(n.playerSources[0]!.uri, /mia-microphone-on-v2\.wav$/);
  assert.equal(n.fileData.get(n.playerSources[0]!.uri)!.length, 44 + 162 * 48);
  n.status({ playing: true }); n.status({ playing: true });
  assert.equal(started.length, 1, 'echo reference begins at actual playback, once');
  n.status({ didJustFinish: true });
  assert.deepEqual(ended, started); assert.equal(n.playersReleased, 1);
  player.play(false); n.status({ playing: true }); player.stop();
  assert.equal(n.playersReleased, 2); assert.deepEqual(ended, started);
  assert.deepEqual(n.modes, []);
  delete (globalThis as any).__miaAudio;
});

test('authenticated voice messages download completely before local playback and clean up after completion', async () => {
  const { n, engine } = await device(); const realFetch = globalThis.fetch;
  const wav = pcmWav(new Uint8Array(48000));
  let downloaded = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://mia.test/v1/media/voice');
    assert.deepEqual(options?.headers, { Authorization: 'Bearer token' });
    downloaded = true; return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
  };
  try {
    const task = engine.play('https://mia.test/v1/media/voice', { Authorization: 'Bearer token' });
    for (let i = 0; i < 10 && !n.playerSources.length; i++) await flush();
    assert.equal(downloaded, true);
    const source = n.playerSources[0]!;
    assert.ok(source.uri.startsWith('file:')); assert.equal(source.headers, undefined);
    assert.deepEqual(n.fileData.get(source.uri), wav, 'play the exact original WAV bytes');
    n.status({ playing: true, currentTime: 0, duration: 1 });
    n.status({ playing: false, currentTime: 1, duration: 1, isLoaded: true, isBuffering: false });
    await flush(); assert.equal(n.playersReleased, 0, 'wait for the actual completion event, not a transient paused status');
    n.status({ didJustFinish: true }); await task;
    assert.equal(n.files.size, 0); assert.equal(n.playersReleased, 1);
  } finally { globalThis.fetch = realFetch; await engine.stop(); delete (globalThis as any).__miaAudio; }
});

test('stopping a pending media download aborts it before any native player starts', async () => {
  const { n, engine } = await device(); const realFetch = globalThis.fetch;
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, options) => {
    signal = options!.signal!;
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  };
  try {
    const task = engine.play('https://mia.test/v1/media/held');
    const rejected = assert.rejects(task, error => (error as Error).constructor.name === 'CancelledError');
    await flush(); assert.ok(signal);
    await engine.stop(); await rejected;
    assert.equal(signal.aborted, true); assert.equal(n.playerSources.length, 0); assert.equal(n.files.size, 0);
  } finally { globalThis.fetch = realFetch; await engine.stop(); delete (globalThis as any).__miaAudio; }
});

test('HTTP failures and invalid voice downloads fail before opening a player', async () => {
  const { n, engine } = await device(); const realFetch = globalThis.fetch;
  try {
    for (const response of [new Response('', { status: 403 }), new Response('not a voice recording')]) {
      globalThis.fetch = async () => response;
      await assert.rejects(engine.play('https://mia.test/v1/media/bad'), /voice message could not be/);
      assert.equal(n.playerSources.length, 0); assert.equal(n.files.size, 0);
    }
  } finally { globalThis.fetch = realFetch; await engine.stop(); delete (globalThis as any).__miaAudio; }
});

test('native playback failure reports immediately, releases resources and permits another playback', async () => {
  const { n, engine } = await device();
  try {
    const task = engine.play('file:///original.wav');
    const rejected = assert.rejects(task, /voice message could not be played/);
    await flush(); n.status({ playbackState: 'failed' }); await rejected;
    assert.equal(n.playersReleased, 1); assert.equal(n.removed, 1);
    n.failPlay = true;
    await assert.rejects(engine.play('file:///retry.wav'), /voice message could not be played/);
    assert.equal(n.playersReleased, 2); assert.equal(n.removed, 2);
    n.failPlay = false;
    const retry = engine.play('file:///retry.wav'); await flush(); n.status({ didJustFinish: true }); await retry;
    assert.equal(n.playersReleased, 3);
  } finally { await engine.stop(); delete (globalThis as any).__miaAudio; }
});

test('native playback that never starts or unexpectedly stops fails without stranding its player', async t => {
  const { n, engine } = await device();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  try {
    const loading = engine.play('file:///held.wav');
    const neverStarted = assert.rejects(loading, /could not start/);
    await flush(); t.mock.timers.tick(16000); await neverStarted;
    const next = engine.play('file:///interrupted.wav');
    const interrupted = assert.rejects(next, /Playback was interrupted/);
    await flush(); n.status({ playing: true, currentTime: 1, duration: 20 });
    n.status({ playing: false, currentTime: 1, duration: 20, isLoaded: true, isBuffering: false });
    t.mock.timers.tick(4000); await interrupted;
    assert.equal(n.playersReleased, 2); assert.equal(n.removed, 2);
  } finally { t.mock.timers.reset(); await engine.stop(); delete (globalThis as any).__miaAudio; }
});

test('recorded duration comes from the native recorder rather than elapsed permission or JS time', async () => {
  const { n, engine } = await device();
  try {
    await engine.start(); n.nativeDuration = 1250;
    const note = await engine.finish(); assert.equal(note.durationMs, 1250);
    await engine.disposeRecording(note); assert.equal(n.files.size, 0);
  } finally { await engine.stop(); delete (globalThis as any).__miaAudio; }
});

test('shared-graph voice-note file IO never changes the audio session or acquires an Expo recorder', async () => {
  const { n, engine } = await device();
  try {
    const pcm = new Uint8Array([0, 0, 255, 127, 0, 128, 1, 2]);
    const note = await engine.savePcm(pcm);
    assert.deepEqual(await engine.readPcm(note.uri), pcm);
    assert.deepEqual(n.modes, []); assert.equal(n.created, 0); assert.equal(n.playersReleased, 0);
    await engine.disposeRecording(note); assert.equal(n.files.size, 0);
  } finally { delete (globalThis as any).__miaAudio; }
});

test('the real audio engine automatically finishes an utterance and preserves its original WAV for recognition', async t => {
  const { n, engine } = await device(); n.level = sample => sample <= 4 ? -30 : -80;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const capture = engine.captureCommand(new AbortController().signal);
    await flush();
    for (let sample = 0; sample < 30; sample++) { t.mock.timers.tick(50); await flush(); }
    const recording = await capture;
    assert.equal(recording?.uri, 'file:///command.wav'); assert.equal(n.options.isMeteringEnabled, true);
    assert.equal(n.released, 1); assert.equal(n.files.has(recording!.uri), true);
    await engine.disposeRecording(recording!); assert.equal(n.files.size, 0);
  } finally { t.mock.timers.reset(); delete (globalThis as any).__miaAudio; }
});

test('an idle listening window is disposed locally and never returned for upload', async t => {
  const { n, engine } = await device();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const capture = engine.captureCommand(new AbortController().signal); await flush();
    for (let sample = 0; sample < 162; sample++) { t.mock.timers.tick(50); await flush(); }
    assert.equal(await capture, null); assert.equal(n.files.size, 0); assert.equal(n.released, 1);
  } finally { t.mock.timers.reset(); delete (globalThis as any).__miaAudio; }
});

test('releasing a held voice note while permissions are pending cannot start a late recorder', async () => {
  const { n, engine } = await device();
  let grant!: (permission: { granted: boolean }) => void;
  n.permission = new Promise(resolve => { grant = resolve; });
  const controller = new AbortController();
  const starting = engine.start(controller.signal);
  const rejected = assert.rejects(starting);
  await flush(); controller.abort(); grant({ granted: true });
  await rejected;
  assert.equal(n.created, 0); assert.equal(n.files.size, 0);
  await engine.stop(); delete (globalThis as any).__miaAudio;
});

test('turning off while the microphone permission dialog is open cannot start a late recorder', async () => {
  const { n, engine } = await device(); let grant!: (value: { granted: boolean }) => void;
  n.permission = new Promise(resolve => { grant = resolve; });
  const controller = new AbortController(); const capture = engine.captureCommand(controller.signal);
  const rejected = assert.rejects(capture);
  await flush(); controller.abort(); grant({ granted: true }); await rejected;
  assert.equal(n.created, 0); assert.equal(n.files.size, 0); delete (globalThis as any).__miaAudio;
});

test('spoken playback resolves only at device completion and cancellation removes player listeners and files', async () => {
  const { n, engine } = await device(); let completed = false;
  const playback = engine.playPcm(new Uint8Array([0, 0])).then(() => { completed = true; });
  await flush(); assert.equal(completed, false);
  n.status({ playing: true }); await flush(); assert.equal(completed, false);
  n.status({ didJustFinish: true }); await playback;
  assert.equal(completed, true); assert.equal(n.playersReleased, 1); assert.equal(n.removed, 1); assert.equal(n.files.size, 0);
  const next = engine.playPcm(new Uint8Array([0, 0])); const rejected = assert.rejects(next);
  await flush(); await engine.stop(); await rejected;
  assert.equal(n.playersReleased, 2); assert.equal(n.removed, 2); assert.equal(n.files.size, 0);
  delete (globalThis as any).__miaAudio;
});

test('classic message pause keeps the player and completion alive until the resumed audio finishes', async t => {
  const { n, engine } = await device(); let completed = false;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  try {
    const task = engine.play('file:///original.wav').then(() => { completed = true; }); await flush();
    n.status({ playing: true, currentTime: 2, duration: 10 });
    await engine.pausePlayback(); n.status({ playing: false, isLoaded: true, currentTime: 2, duration: 10, isBuffering: false }); await flush();
    t.mock.timers.tick(180000); await flush();
    assert.equal(completed, false); assert.equal(n.playersReleased, 0);
    engine.resumePlayback(); n.status({ playing: true, currentTime: 2, duration: 10 });
    n.status({ playing: false, currentTime: 10, duration: 10, didJustFinish: true }); await task;
    assert.equal(completed, true); assert.equal(n.playersReleased, 1);
  } finally { await engine.stop(); t.mock.timers.reset(); delete (globalThis as any).__miaAudio; }
});

test('original playback progress comes from device status and late callbacks cannot update stopped audio', async () => {
  const { n, engine } = await device(); const positions: PlaybackProgress[] = []; let starts = 0;
  try {
    const playback = engine.play('file:///original.wav', undefined, () => { starts++; }, progress => positions.push(progress));
    await flush();
    n.status({ playing: true, currentTime: 2.5, duration: 10, isBuffering: false });
    n.status({ playing: false, currentTime: 2.5, duration: 10, isBuffering: true });
    n.status({ playing: false, currentTime: 10, duration: 10, didJustFinish: true, isBuffering: false });
    await playback;
    assert.equal(starts, 1); assert.deepEqual(positions.map(p => p.positionMs), [2500, 2500, 10000]);
    assert.equal(positions[1]!.buffering, true); assert.ok(positions.every(p => p.durationMs === 10000));
    n.status({ playing: true, currentTime: 12, duration: 10 }); assert.equal(positions.length, 3);
  } finally { await engine.stop(); delete (globalThis as any).__miaAudio; }
});
