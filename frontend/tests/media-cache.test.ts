import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceMediaCache, type CachedVoice, type VoiceMediaStore } from '../src/shared/audio/mediaCache';
import { pcmWav } from '../src/shared/audio/wav';

const wav = pcmWav(new Uint8Array(4800));
class Store implements VoiceMediaStore {
  data = new Map<string, CachedVoice & { bytes: Uint8Array }>();
  entries() { return [...this.data.values()]; }
  lookup(id: string) { return this.data.get(id) ?? null; }
  async read(id: string) { return this.data.get(id)!.bytes; }
  write(id: string, bytes: Uint8Array, usedAt: number) {
    const item = { id, uri: `file:///cache/${id}.wav`, size: bytes.length, usedAt, bytes };
    this.data.set(id, item); return item;
  }
  copy(id: string, _sourceUri: string, usedAt: number) { return this.write(id, wav.slice(), usedAt); }
  touch(id: string, usedAt: number) { const item = this.data.get(id); if (item) item.usedAt = usedAt; }
  remove(id: string) { this.data.delete(id); }
}
const createCache = (store = new Store(), maxBytes?: number) => new VoiceMediaCache(store, { baseUrl: 'https://mia.test', token: 'token', maxBytes });
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('prefetch, classic playback and agent playback share one download that survives a new cache instance', async () => {
  const realFetch = globalThis.fetch, store = new Store(), cache = createCache(store);
  let downloads = 0;
  globalThis.fetch = async (_uri, options) => {
    downloads++; assert.deepEqual(options?.headers, { Authorization: 'Bearer token' });
    return new Response(wav);
  };
  try {
    cache.prefetch(['voice', 'voice']);
    const [classic, agent] = await Promise.all([cache.acquire('voice'), cache.acquire('voice')]);
    assert.equal(downloads, 1); assert.equal(classic.uri, agent.uri);
    classic.release(); agent.release(); cache.dispose();
    globalThis.fetch = async () => { throw new Error('Offline'); };
    const restarted = createCache(store);
    const offline = await restarted.acquire('voice'); assert.equal(offline.uri, classic.uri);
    offline.release(); restarted.dispose();
  } finally { cache.dispose(); globalThis.fetch = realFetch; }
});

test('a missing or corrupt local file is repaired and a failed download can be retried', async () => {
  const realFetch = globalThis.fetch, store = new Store(), cache = createCache(store);
  store.write('corrupt', new Uint8Array([1, 2, 3]), 0);
  let requests = 0;
  globalThis.fetch = async () => { requests++; return requests === 1 ? new Response('', { status: 503 }) : new Response(wav); };
  try {
    await assert.rejects(cache.acquire('corrupt'), /could not be loaded/);
    assert.equal(store.lookup('corrupt'), null, 'do not expose invalid or partially downloaded data');
    const repaired = await cache.acquire('corrupt'); repaired.release();
    store.remove('corrupt');
    const restored = await cache.acquire('corrupt'); restored.release();
    assert.equal(requests, 3);
  } finally { cache.dispose(); globalThis.fetch = realFetch; }
});

test('cancelling one consumer does not cancel another consumer of the same media ID', async () => {
  const realFetch = globalThis.fetch, cache = createCache();
  let complete!: (response: Response) => void, signal!: AbortSignal;
  globalThis.fetch = async (_uri, options) => {
    signal = options!.signal!; return new Promise(resolve => { complete = resolve; });
  };
  try {
    const controller = new AbortController();
    const first = cache.acquire('shared', controller.signal);
    const rejected = assert.rejects(first);
    const second = cache.acquire('shared');
    controller.abort(); await rejected; assert.equal(signal.aborted, false);
    complete(new Response(wav)); const lease = await second; lease.release();
  } finally { cache.dispose(); globalThis.fetch = realFetch; }
});

test('playback gets a reserved download slot and visible messages outrank queued history', async () => {
  const realFetch = globalThis.fetch, cache = createCache();
  const requests: { id: string; complete(response: Response): void }[] = [];
  globalThis.fetch = async uri => new Promise(resolve => { requests.push({ id: String(uri).split('/').at(-1)!, complete: resolve }); });
  try {
    cache.prefetch(['history-a', 'history-b', 'history-c']);
    assert.deepEqual(requests.map(item => item.id), ['history-a', 'history-b']);
    const playing = cache.acquire('play-now');
    assert.deepEqual(requests.map(item => item.id), ['history-a', 'history-b', 'play-now']);
    cache.prefetch(['visible'], true);
    requests[2]!.complete(new Response(wav)); (await playing).release(); await tick();
    requests[0]!.complete(new Response(wav)); await tick();
    assert.equal(requests[3]!.id, 'visible');
    for (const request of requests) request.complete(new Response(wav));
  } finally { cache.dispose(); globalThis.fetch = realFetch; }
});

test('eviction keeps files pinned by playback, then removes the oldest unused media', async () => {
  const store = new Store(), cache = createCache(store, wav.length * 2);
  store.write('playing', wav, 1); store.write('old', wav, 2);
  const realFetch = globalThis.fetch; globalThis.fetch = async () => new Response(wav);
  try {
    const pinned = await cache.acquire('playing');
    const next = await cache.acquire('new'); next.release();
    assert.ok(store.lookup('playing')); assert.ok(store.lookup('new')); assert.equal(store.lookup('old'), null);
    pinned.release();
    assert.ok(store.entries().reduce((size, item) => size + item.size, 0) <= wav.length * 2);
  } finally { cache.dispose(); globalThis.fetch = realFetch; }
});

test('cache eviction does not trigger a background redownload loop on every chat refresh', async () => {
  const realFetch = globalThis.fetch, store = new Store(), cache = createCache(store, wav.length);
  let downloads = 0; globalThis.fetch = async () => { downloads++; return new Response(wav); };
  try {
    cache.prefetch(['a', 'b']); await tick();
    assert.equal(downloads, 2); assert.equal(store.entries().length, 1);
    cache.prefetch(['a', 'b']); await tick(); assert.equal(downloads, 2);
    const lease = await cache.acquire(store.lookup('a') ? 'b' : 'a'); lease.release();
    assert.equal(downloads, 3, 'an explicit Play can still restore an evicted file');
  } finally { cache.dispose(); globalThis.fetch = realFetch; }
});

test('uploaded recordings are reused locally and an in-flight prefetch adopts the original file', async () => {
  const store = new Store(), cache = createCache(store), realFetch = globalThis.fetch;
  let complete!: (response: Response) => void;
  globalThis.fetch = async () => new Promise(resolve => { complete = resolve; });
  try {
    cache.prefetch(['sent']); const pending = cache.acquire('sent');
    cache.remember('sent', 'file:///recording.wav');
    const lease = await pending; assert.equal(lease.uri, 'file:///cache/sent.wav'); lease.release();
    complete(new Response(wav)); await tick();
    globalThis.fetch = async () => { throw new Error('Must not download an outgoing recording'); };
    const again = await cache.acquire('sent'); again.release();
  } finally { cache.dispose(); globalThis.fetch = realFetch; }
});

test('backgrounding cancels speculative work; disposal prevents a late response from writing into a closed account', async () => {
  const realFetch = globalThis.fetch, store = new Store(), cache = createCache(store);
  const requests: { signal: AbortSignal; complete(response: Response): void }[] = [];
  globalThis.fetch = async (_uri, options) => new Promise(resolve => { requests.push({ signal: options!.signal!, complete: resolve }); });
  try {
    cache.prefetch(['old']); cache.setPrefetchEnabled(false);
    assert.equal(requests[0]!.signal.aborted, true);
    const controller = new AbortController();
    const demand = cache.acquire('demand', controller.signal), rejected = assert.rejects(demand);
    controller.abort(); await rejected;
    cache.dispose();
    for (const request of requests) request.complete(new Response(wav));
    await tick(); assert.equal(store.entries().length, 0);
    await assert.rejects(cache.acquire('closed'));
  } finally { cache.dispose(); globalThis.fetch = realFetch; }
});
