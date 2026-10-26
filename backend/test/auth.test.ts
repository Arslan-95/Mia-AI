import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthService } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import { phoneSignIn, testApp } from './helpers.js';

test('phone OTP creates one account, onboards the profile and returns to it on later login', async (t) => {
  const context = await testApp(); t.after(() => context.close());
  const { app } = context;
  const invalid = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phoneNumber: 'not-a-phone' } });
  assert.equal(invalid.statusCode, 400);
  const first = await phoneSignIn(app, '+15550100001');
  assert.equal(first.user.phoneNumber, '+15550100001');
  assert.equal(first.user.profileComplete, false);
  assert.equal('email' in first.user, false);
  const headers = { authorization: `Bearer ${first.token}` };
  const profile = await app.inject({ method: 'PATCH', url: '/v1/me', headers, payload: { username: 'anna', displayName: 'Anna' } });
  assert.equal(profile.statusCode, 200, profile.body);
  assert.equal(profile.json().profileComplete, true);
  await app.inject({ method: 'POST', url: '/v1/auth/logout', headers });
  assert.equal((await app.inject({ url: '/v1/me', headers })).statusCode, 401);
  const again = await phoneSignIn(app, '+15550100001');
  assert.equal(again.user.id, first.user.id);
  assert.equal(again.user.displayName, 'Anna');
  assert.equal(again.user.profileComplete, true);
  assert.notEqual(again.token, first.token);
  const oldRoute = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { authorization: `Bearer ${again.token}` }, payload: {} });
  assert.equal(oldRoute.statusCode, 404);
  const other = await phoneSignIn(app, '+15550100002');
  const duplicate = await app.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${other.token}` },
    payload: { username: 'anna', displayName: 'Other Anna' } });
  assert.equal(duplicate.statusCode, 409);
});

test('OTP failures persist, lock the challenge, expire, and cannot replay after success or resend', async (t) => {
  const context = await testApp(); t.after(() => context.close());
  const { app, db } = context;
  async function request(phoneNumber: string) {
    const result = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phoneNumber } });
    assert.equal(result.statusCode, 202, result.body);
    const challenge = result.json() as { challengeId: string; expiresAt: string; delivery: string };
    assert.equal(challenge.delivery, 'development');
    assert.equal('code' in challenge, false);
    return challenge.challengeId;
  }
  const verify = (challengeId: string, code: string) => app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { challengeId, code } });
  const locked = await request('+15550100011');
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await verify(locked, '000000');
    assert.equal(result.statusCode, attempt === 5 ? 429 : 401, result.body);
  }
  const [record] = await db.query<{ attempts: number }>('SELECT attempts FROM otp_challenges WHERE id = $1', [locked]);
  assert.equal(record?.attempts, 5);
  assert.equal((await verify(locked, '123456')).statusCode, 429);
  const expired = await request('+15550100012');
  await db.query("UPDATE otp_challenges SET expires_at = now() - interval '1 second' WHERE id = $1", [expired]);
  assert.equal((await verify(expired, '123456')).statusCode, 401);
  const old = await request('+15550100013');
  const fresh = await request('+15550100013');
  assert.equal((await verify(old, '123456')).statusCode, 401);
  const concurrent = await Promise.all([verify(fresh, '123456'), verify(fresh, '123456')]);
  assert.deepEqual(concurrent.map((result) => result.statusCode).sort(), [200, 401]);
  assert.equal((await verify(fresh, '123456')).statusCode, 401);
  assert.equal((await db.query('SELECT token_hash FROM auth_sessions')).length, 1);
  const production = new AuthService(db, readConfig({ NODE_ENV: 'production', DEV_OTP_CODE: '654321' }));
  await assert.rejects(production.requestCode('+15550100015'), { status: 503, code: 'PHONE_AUTH_UNAVAILABLE' });
  await assert.rejects(production.verifyCode(fresh, '654321'), { status: 503 });
});

test('development OTP is configurable and phone code requests are bounded', async (t) => {
  const context = await testApp(); t.after(() => context.close());
  const auth = new AuthService(context.db, readConfig({ NODE_ENV: 'test', DEV_OTP_CODE: '654321' }));
  const challenge = await auth.requestCode('+15550100021');
  await assert.rejects(auth.verifyCode(challenge.challengeId, '123456'), { status: 401 });
  assert.equal((await auth.verifyCode(challenge.challengeId, '654321')).user.phoneNumber, '+15550100021');
  for (let count = 0; count < 5; count++) await auth.requestCode('+15550100022');
  await assert.rejects(auth.requestCode('+15550100022'), { status: 429, code: 'OTP_RATE_LIMIT' });
});

test('phone verification has no fallback code when DEV_OTP_CODE is missing or empty', async (t) => {
  const context = await testApp(); t.after(() => context.close());
  for (const env of [{ NODE_ENV: 'test' }, { NODE_ENV: 'test', DEV_OTP_CODE: '' }]) {
    const config = readConfig(env);
    assert.equal(config.developmentOtpCode, undefined);
    const auth = new AuthService(context.db, config);
    await assert.rejects(auth.requestCode('+15550100031'), { status: 503, code: 'PHONE_AUTH_UNAVAILABLE' });
    await assert.rejects(auth.verifyCode('00000000-0000-4000-8000-000000000000', '123456'), { status: 503 });
  }
  assert.throws(() => readConfig({ DEV_OTP_CODE: '12345' }));
  assert.throws(() => readConfig({ DEV_OTP_CODE: 'abcdef' }));
});
