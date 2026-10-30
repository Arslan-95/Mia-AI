import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Engine } from '../src/audio/engine';
import type { PlaybackProgress } from '../src/audio/types';

const root = fileURLToPath(new URL('../', import.meta.url).toString()).replaceAll('\\', '/');
const bundle = build({
  stdin: { contents: `export { Engine } from './src/audio/engine';`, resolveDir: root },
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
          getStatus() { n.samples++; return { isRecording: this.active, metering: n.level(n.samples) }; }
        }
      };
      export function createAudioPlayer() {
        return { addListener(_, callback) { n.status = callback; return { remove() { n.removed++; } }; },
          play() {}, pause() {}, release() { n.playersReleased++; } };
      }
    ` : `
      const n = globalThis.__miaAudio;
      export const Paths = { cache: 'file:///cache' };
      export class File {
        constructor(...parts) { this.uri = parts.join('/'); }
        get exists() { return n.files.has(this.uri); }
        write() { n.files.add(this.uri); }
        delete() { n.files.delete(this.uri); }
      }
    ` }));
  } }],
});

async function device() {
  const n = { permission: Promise.resolve({ granted: true }), options: {} as any, modes: [] as unknown[], created: 0, released: 0,
    samples: 0, files: new Set<string>(), level: (_sample: number) => -80, removed: 0, playersReleased: 0, status: (_status: any) => {} };
  (globalThis as any).__miaAudio = n;
  const module = { exports: {} as { Engine: new () => Engine } };
  new Function('require', 'module', 'exports', (await bundle).outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
  return { n, engine: new module.exports.Engine() };
}
async function flush() { for (let n = 0; n < 20; n++) await Promise.resolve(); }

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
