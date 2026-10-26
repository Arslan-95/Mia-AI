import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api, ApiError, normalizeAddress } from '../src/api';
test('server origin validation rejects embedded credentials, paths, and insecure public servers', () => {
  assert.equal(normalizeAddress(' http://192.168.1.20:8080/ '), 'http://192.168.1.20:8080');
  assert.equal(normalizeAddress('https://mia.example.com'), 'https://mia.example.com');
  for (const value of ['http://example.com', 'https://me:secret@example.com', 'https://example.com/api', 'file:///test']) assert.throws(() => normalizeAddress(value));
});
test('API preserves structured errors and invalidates expired authenticated sessions', async () => {
  const original = globalThis.fetch; let expired = false;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Session expired.' } }), { status: 401 });
  try { const api = new Api('http://localhost:8082', { token: 'test' } as never, () => { expired = true; }); await assert.rejects(api.request('/v1/me'), error => error instanceof ApiError && error.code === 'UNAUTHORIZED' && error.message === 'Session expired.'); assert.equal(expired, true); }
  finally { globalThis.fetch = original; }
});
