import assert from 'node:assert/strict';
import test from 'node:test';
import { Api, ApiError } from '../src/api';
import { CancelledError } from '../src/errors';
import { PhoneSignIn } from '../src/phoneAuth';
import type { Session } from '../src/types';

const phone = '+995555123456';
const challenge = { challengeId: 'test-challenge', expiresAt: '2099-01-01T00:00:00Z', delivery: 'test' };
const session: Session = { token: 'mia-session', expiresAt: '2099-01-01T00:00:00Z',
  user: { id: 'existing-user', phoneNumber: phone, displayName: 'Anna', profileComplete: true } };

test('fixed-code sign-in uses only the Mia OTP endpoints and preserves leading zeros', async t => {
  const calls: { path: string; body: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    const path = new URL(url).pathname;
    calls.push({ path, body });
    assert.equal(options.method, 'POST');
    if (path === '/v1/auth/otp/request') return Response.json(challenge, { status: 202 });
    assert.equal(path, '/v1/auth/otp/verify', 'no provider exchange or SMS API is called');
    return body.code === '012345' ? Response.json(session)
      : Response.json({ error: { code: 'INVALID_OTP' } }, { status: 401 });
  });
  const flow = new PhoneSignIn(new Api('http://mia.test', null));
  assert.equal((await flow.request(phone)).delivery, 'test');
  await assert.rejects(flow.verify(challenge.challengeId, '999999'), { code: 'INVALID_OTP' });
  assert.deepEqual(await flow.verify(challenge.challengeId, '012345'), session);
  assert.deepEqual(calls, [
    { path: '/v1/auth/otp/request', body: { phoneNumber: phone } },
    { path: '/v1/auth/otp/verify', body: { challengeId: challenge.challengeId, code: '999999' } },
    { path: '/v1/auth/otp/verify', body: { challengeId: challenge.challengeId, code: '012345' } },
  ]);
  await assert.rejects(flow.verify(challenge.challengeId, '012345'), { code: 'INVALID_OTP' });
});

test('unlisted numbers are rejected by the backend and never receive a local fallback code', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ error: { code: 'PHONE_AUTH_UNAVAILABLE' } }, { status: 503 });
  });
  const flow = new PhoneSignIn(new Api('http://mia.test', null));
  await assert.rejects(flow.request('555123456'), { code: 'INVALID_PHONE_NUMBER' });
  assert.equal(calls, 0);
  await assert.rejects(flow.request(phone), { code: 'PHONE_AUTH_UNAVAILABLE' });
  await assert.rejects(flow.verify(challenge.challengeId, '123456'), { code: 'INVALID_OTP' });
  assert.equal(calls, 1);
});

test('cancellation aborts the pending request and a late response cannot replace a newer number', async t => {
  let oldSignal!: AbortSignal;
  let resolveOld!: (value: Response) => void;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => {
    if (++calls === 1) {
      oldSignal = options.signal!;
      return new Promise<Response>(resolve => { resolveOld = resolve; });
    }
    return Promise.resolve(Response.json({ ...challenge, challengeId: 'new-challenge' }));
  });
  const flow = new PhoneSignIn(new Api('http://mia.test', null));
  const old = flow.request(phone);
  await assert.rejects(flow.request(phone), { code: 'OTP_RATE_LIMIT' });
  flow.cancel();
  assert.equal(oldSignal.aborted, true);
  const current = await flow.request('+12025550101');
  resolveOld(Response.json(challenge));
  await assert.rejects(old, CancelledError);
  assert.equal(current.challengeId, 'new-challenge');
  await assert.rejects(flow.verify(challenge.challengeId, '123456'), { code: 'INVALID_OTP' });
});

test('cancelled verification cannot publish its late session and network errors remain retryable', async t => {
  let finish!: (value: Response) => void;
  let verifying = false;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/request')) return Response.json(challenge);
    verifying = true;
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  const flow = new PhoneSignIn(new Api('http://mia.test', null));
  await flow.request(phone);
  const result = flow.verify(challenge.challengeId, '012345');
  assert.equal(verifying, true);
  flow.cancel();
  finish(Response.json(session));
  await assert.rejects(result, CancelledError);

  let offline = true;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/request')) return Response.json(challenge);
    if (offline) throw new Error('Network unavailable');
    return Response.json(session);
  });
  await flow.request(phone);
  await assert.rejects(flow.verify(challenge.challengeId, '012345'), error => error instanceof ApiError && error.code === 'OFFLINE');
  offline = false;
  assert.deepEqual(await flow.verify(challenge.challengeId, '012345'), session);
});
