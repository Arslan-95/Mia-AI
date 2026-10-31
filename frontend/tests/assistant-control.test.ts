import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api } from '../src/api';
import { AssistantControl } from '../src/assistantControl';
import type { Session } from '../src/types';

const identity: Session = { token: 'test-session', expiresAt: '2099-01-01T00:00:00Z',
  user: { id: 'owner', username: 'owner', displayName: 'Owner', phoneNumber: '+15550000000', profileComplete: true } };

test('Stop Mia uses authenticated HTTP without any WebSocket and validates the server acknowledgement', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://mia.example.com/v1/assistant/sessions/session-id/stop');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-session');
    return Response.json({ sessionId: 'session-id', generation: 4, stopped: true });
  };
  try {
    const control = new AssistantControl();
    assert.deepEqual(await control.stop(new Api('https://mia.example.com', identity), 'session-id'),
      { sessionId: 'session-id', generation: 4, stopped: true });
  } finally { globalThis.fetch = original; }
});

test('a new turn waits for a pending stop and repeated Stop taps share the request', async () => {
  const original = globalThis.fetch;
  let finish!: (response: Response) => void;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Promise<Response>(resolve => { finish = resolve; }); };
  try {
    const control = new AssistantControl();
    const api = new Api('https://mia.example.com', identity);
    const first = control.stop(api, 'session-id');
    const second = control.stop(api, 'session-id');
    assert.equal(first, second);
    let maySubmit = false;
    const nextTurn = control.beforeTurn(api, 'session-id').then(() => { maySubmit = true; });
    await Promise.resolve();
    assert.equal(maySubmit, false); assert.equal(requests, 1);
    finish(Response.json({ sessionId: 'session-id', generation: 5, stopped: true }));
    await Promise.all([first, second, nextTurn]);
    assert.equal(maySubmit, true);
  } finally { globalThis.fetch = original; }
});

test('an undelivered stop is explicit, retryable and does not prevent a later superseding turn', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Offline'); };
  try {
    const control = new AssistantControl();
    const api = new Api('https://mia.example.com', identity);
    const stop = control.stop(api, 'session-id');
    const beforeTurn = control.beforeTurn(api, 'session-id');
    await assert.rejects(stop, /Mia may still be working/);
    await beforeTurn;
    globalThis.fetch = async () => Response.json({ sessionId: 'session-id', generation: 6, stopped: true });
    assert.equal((await control.stop(api, 'session-id')).generation, 6);
  } finally { globalThis.fetch = original; }
});

test('a successful HTTP status alone does not count as a confirmed stop', async () => {
  const original = globalThis.fetch;
  try {
    for (const acknowledgement of [{}, { sessionId: 'other-session', generation: 4, stopped: true },
      { sessionId: 'session-id', generation: '4', stopped: true }]) {
      globalThis.fetch = async () => Response.json(acknowledgement);
      await assert.rejects(new AssistantControl().stop(new Api('https://mia.example.com', identity), 'session-id'),
        /Mia may still be working/);
    }
  } finally { globalThis.fetch = original; }
});

test('a full stop queued after a recording stop still closes voice and remains a turn barrier', async () => {
  const original = globalThis.fetch;
  const bodies: unknown[] = [];
  let finish!: (response: Response) => void;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Promise<Response>(resolve => { finish = resolve; });
  };
  try {
    const control = new AssistantControl(), api = new Api('https://mia.example.com', identity);
    const recording = control.stop(api, 'session-id', true);
    const full = control.stop(api, 'session-id');
    let ready = false;
    const barrier = control.beforeTurn(api, 'session-id').then(() => { ready = true; });
    assert.deepEqual(bodies, [{ preserveVoice: true }]);
    finish(Response.json({ sessionId: 'session-id', generation: 4, stopped: true })); await recording;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.deepEqual(bodies, [{ preserveVoice: true }, {}]); assert.equal(ready, false);
    finish(Response.json({ sessionId: 'session-id', generation: 5, stopped: true }));
    await Promise.all([full, barrier]); assert.equal(ready, true);
  } finally { globalThis.fetch = original; }
});
