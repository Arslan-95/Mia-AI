import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api, ApiError } from '../src/api';
import { createRequire } from 'node:module';
test('API preserves structured errors and invalidates expired authenticated sessions', async () => {
  const original = globalThis.fetch; let expired = false;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Session expired.' } }), { status: 401 });
  try { const api = new Api('http://localhost:8082', { token: 'test' } as never, () => { expired = true; }); await assert.rejects(api.request('/v1/me'), error => error instanceof ApiError && error.code === 'UNAUTHORIZED' && error.message === 'Session expired.'); assert.equal(expired, true); }
  finally { globalThis.fetch = original; }
});

test('API requests work with React Native AbortController without AbortSignal.timeout', async () => {
  const nativeAbort = createRequire(import.meta.url)('abort-controller/dist/abort-controller') as {
    AbortController: typeof globalThis.AbortController; AbortSignal: typeof globalThis.AbortSignal;
  };
  const original = { fetch: globalThis.fetch, controller: globalThis.AbortController, signal: globalThis.AbortSignal };
  let sent = false;
  globalThis.AbortController = nativeAbort.AbortController; globalThis.AbortSignal = nativeAbort.AbortSignal;
  globalThis.fetch = async (_url, init) => {
    sent = true;
    assert.ok(init?.signal instanceof nativeAbort.AbortSignal);
    return Response.json({ status: 'ready' });
  };
  try {
    assert.equal(typeof globalThis.AbortSignal.timeout, 'undefined');
    assert.deepEqual(await new Api('http://192.168.1.20:8082', null).request('/health/ready'), { status: 'ready' });
    assert.equal(sent, true);
  } finally {
    globalThis.fetch = original.fetch; globalThis.AbortController = original.controller; globalThis.AbortSignal = original.signal;
  }
});

test('request timeouts abort pending fetches and are cleared after a completed response', async (t) => {
  const original = globalThis.fetch;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, init) => { signal = init?.signal; return Response.json({ ok: true }); };
  try {
    const api = new Api('http://localhost:8082', null);
    await api.request('/health');
    t.mock.timers.tick(20_000);
    assert.equal(signal?.aborted, false);
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      signal = init?.signal;
      signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
    const failure = assert.rejects(api.request('/health'), error => error instanceof ApiError && error.code === 'OFFLINE');
    t.mock.timers.tick(20_000);
    await failure;
    assert.equal(signal?.aborted, true);
  } finally { globalThis.fetch = original; t.mock.timers.reset(); }
});
