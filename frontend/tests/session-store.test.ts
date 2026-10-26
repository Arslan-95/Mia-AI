import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../src/sessionStore';
import type { Session } from '../src/types';

function fixture(initial: string | null = null) {
  let value = initial;
  const store = createSessionStore({
    get: async () => value,
    set: async (_, next) => { value = next; },
    remove: async () => { value = null; },
  });
  return { store, persisted: () => value };
}

test('session persistence restores a valid session and removes credentials on sign-out', async () => {
  const { store, persisted } = fixture();
  const session = { token: 'opaque-session-token', user: { id: 'user' }, expiresAt: new Date(Date.now() + 60000).toISOString() } as Session;
  await store.write(session);
  assert.deepEqual(await store.read(), session);
  await store.write(null);
  assert.equal(persisted(), null);
  assert.equal(await store.read(), null);
});

test('expired or malformed persisted credentials are removed rather than restored', async () => {
  const cases = ['{damaged', JSON.stringify({ token: 'token', user: { id: 'user' }, expiresAt: 'invalid' }), JSON.stringify({ token: 'token', user: { id: 'user' }, expiresAt: new Date(0).toISOString() })];
  for (const serialized of cases) {
    const { store, persisted } = fixture(serialized);
    assert.equal(await store.read(), null);
    assert.equal(persisted(), null);
  }
});
