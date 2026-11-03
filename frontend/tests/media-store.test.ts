import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { FileVoiceMediaStore } from '../src/audio/mediaStore';
import { pcmWav } from '../src/audio/wav';

const root = fileURLToPath(new URL('../', import.meta.url).toString()).replaceAll('\\', '/');
const bundle = build({
  stdin: { contents: `export { FileVoiceMediaStore } from './src/audio/mediaStore';`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'disk', setup(build) {
    build.onResolve({ filter: /^expo-file-system$/ }, () => ({ path: 'disk', namespace: 'disk' }));
    build.onLoad({ filter: /.*/, namespace: 'disk' }, () => ({ contents: `
      const n = globalThis.__voiceDisk;
      const path = parts => parts.map(part => typeof part === 'string' ? part : part.uri).join('/');
      export const Paths = { cache: 'file:///cache' };
      export class Directory {
        constructor(...parts) { this.uri = path(parts); }
        create() {}
        list() { return [...n.files.keys()].filter(uri => uri.startsWith(this.uri + '/') && !uri.slice(this.uri.length + 1).includes('/')).map(uri => new File(uri)); }
      }
      export class File {
        constructor(...parts) { this.uri = path(parts); }
        get name() { return this.uri.split('/').at(-1); }
        get exists() { return n.files.has(this.uri); }
        get size() { return n.files.get(this.uri)?.length ?? 0; }
        get modificationTime() { return 1; }
        write(bytes) { n.files.set(this.uri, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes.slice()); }
        textSync() { return new TextDecoder().decode(n.files.get(this.uri)); }
        async bytes() { return n.files.get(this.uri).slice(); }
        delete() { n.files.delete(this.uri); }
        copy(to) { n.files.set(to.uri, n.files.get(this.uri).slice()); }
        move(to) { if (n.failMove) throw new Error('Interrupted write'); n.files.set(to.uri, n.files.get(this.uri)); n.files.delete(this.uri); this.uri = to.uri; }
      }
    ` }));
  } }],
});

async function disk() {
  const n = { files: new Map<string, Uint8Array>(), failMove: false };
  (globalThis as any).__voiceDisk = n;
  const module = { exports: {} as { FileVoiceMediaStore: typeof FileVoiceMediaStore } };
  new Function('require', 'module', 'exports', (await bundle).outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
  return { n, Store: module.exports.FileVoiceMediaStore };
}

test('voice files and LRU access times survive recreating the native store, isolated by account and server', async () => {
  const { n, Store } = await disk();
  try {
    const store = new Store('https://mia.test', 'user-a');
    const entry = store.write('voice_a/b', pcmWav(new Uint8Array(48)), 20);
    store.touch('voice_a/b', 50);
    const restarted = new Store('https://mia.test', 'user-a');
    assert.equal(restarted.lookup('voice_a/b')?.uri, entry.uri);
    assert.equal(restarted.lookup('voice_a/b')?.usedAt, 50);
    assert.deepEqual(await restarted.read('voice_a/b'), pcmWav(new Uint8Array(48)));
    assert.equal(new Store('https://mia.test', 'user-b').lookup('voice_a/b'), null);
    assert.equal(new Store('https://other.test', 'user-a').lookup('voice_a/b'), null);
    n.files.delete(entry.uri); assert.equal(restarted.lookup('voice_a/b'), null, 'recover when the OS purges an individual cached file');
  } finally { delete (globalThis as any).__voiceDisk; }
});

test('failed atomic writes never expose a partial voice file and sent recordings keep an independent copy', async () => {
  const { n, Store } = await disk();
  try {
    const store = new Store('https://mia.test', 'user'); const wav = pcmWav(new Uint8Array(48));
    n.failMove = true; assert.throws(() => store.write('broken', wav, 1));
    assert.equal(store.lookup('broken'), null);
    assert.equal([...n.files.keys()].filter(uri => uri.endsWith('.part')).length, 0);
    n.failMove = false; n.files.set('file:///draft.wav', wav);
    const saved = store.copy('sent', 'file:///draft.wav', 2); n.files.delete('file:///draft.wav');
    assert.equal(store.lookup('sent')?.uri, saved.uri); assert.deepEqual(await store.read('sent'), wav);
    const folder = saved.uri.slice(0, saved.uri.lastIndexOf('/'));
    n.files.set(folder + '/access.json', new TextEncoder().encode('corrupt index'));
    n.files.set(folder + '/write-interrupted.part', new Uint8Array([1]));
    const recovered = new Store('https://mia.test', 'user');
    assert.ok(recovered.lookup('sent')); assert.equal(n.files.has(folder + '/write-interrupted.part'), false);
  } finally { delete (globalThis as any).__voiceDisk; }
});
