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
  assert.equal('username' in first.user, false);
  const headers = { authorization: `Bearer ${first.token}` };
  const profile = await app.inject({ method: 'PATCH', url: '/v1/me', headers, payload: { displayName: 'Anna' } });
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
    payload: { displayName: 'Anna' } });
  assert.equal(duplicate.statusCode, 200, 'display names are not unique identities');
  assert.equal(duplicate.json().phoneNumber, '+15550100002');
  assert.equal('username' in duplicate.json(), false);
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

test('production HTTP sign-in only accepts each configured number with its own test OTP', async (t) => {
  const numbers = ['+12025550101', '+12025550102', '+12025550103'];
  const codes = ['012345', '654321', '000003'];
  const context = await testApp({}, { NODE_ENV: 'production',
    TEST_PHONE_NUMBERS: JSON.stringify(numbers), TEST_OTP_CODES: JSON.stringify(codes) });
  t.after(() => context.close());
  const { app, db } = context;
  const health = await app.inject('/health/ready');
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().capabilities.phoneAuthentication, true);
  const unknown = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phoneNumber: '+12025550999' } });
  assert.equal(unknown.statusCode, 503);
  assert.equal(unknown.json().error.code, 'PHONE_AUTH_UNAVAILABLE');
  const verify = (challengeId: string, code: string) => app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { challengeId, code } });
  for (const [index, phoneNumber] of numbers.entries()) {
    const requested = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phoneNumber } });
    assert.equal(requested.statusCode, 202, requested.body);
    const challenge = requested.json();
    assert.deepEqual(Object.keys(challenge).sort(), ['challengeId', 'delivery', 'expiresAt']);
    assert.equal(challenge.delivery, 'test');
    assert.equal((await verify(challenge.challengeId, '123456')).statusCode, 401, 'DEV_OTP_CODE is never a production fallback');
    assert.equal((await verify(challenge.challengeId, codes[(index + 1) % codes.length]!)).statusCode, 401, 'another number has a different code');
    const signedIn = await verify(challenge.challengeId, codes[index]!);
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    const session = signedIn.json();
    assert.equal(session.user.phoneNumber, phoneNumber);
    const headers = { authorization: `Bearer ${session.token}` };
    assert.equal((await app.inject({ url: '/v1/me', headers })).json().id, session.user.id);
    assert.equal((await verify(challenge.challengeId, codes[index]!)).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers })).statusCode, 204);
    assert.equal((await app.inject({ url: '/v1/me', headers })).statusCode, 401);
  }
  assert.equal((await db.query('SELECT id FROM users')).length, 3);
  assert.equal((await db.query('SELECT id FROM otp_challenges')).length, 3, 'unknown numbers create no challenge');
});

test('production test OTPs retain request limits, lockouts, expiry and single-use challenges', async (t) => {
  const context = await testApp(); t.after(() => context.close());
  const number = '+12025550101';
  const auth = new AuthService(context.db, readConfig({ NODE_ENV: 'production',
    TEST_PHONE_NUMBERS: JSON.stringify([number]), TEST_OTP_CODES: '["012345"]' }));
  const locked = await auth.requestCode(number);
  for (let attempt = 1; attempt <= 5; attempt++) {
    await assert.rejects(auth.verifyCode(locked.challengeId, '000000'), { status: attempt === 5 ? 429 : 401 });
  }
  await assert.rejects(auth.verifyCode(locked.challengeId, '012345'), { status: 429, code: 'OTP_LOCKED' });
  const expired = await auth.requestCode(number);
  await context.db.query("UPDATE otp_challenges SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.challengeId]);
  await assert.rejects(auth.verifyCode(expired.challengeId, '012345'), { status: 401 });
  const old = await auth.requestCode(number);
  const fresh = await auth.requestCode(number);
  await assert.rejects(auth.verifyCode(old.challengeId, '012345'), { status: 401 });
  const results = await Promise.allSettled([auth.verifyCode(fresh.challengeId, '012345'), auth.verifyCode(fresh.challengeId, '012345')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected?.reason.status, 401);
  await auth.requestCode(number);
  await assert.rejects(auth.requestCode(number), { status: 429, code: 'OTP_RATE_LIMIT' });
});

test('test OTP takes precedence in development and old challenges cannot survive code rotation or number removal', async (t) => {
  const context = await testApp(); t.after(() => context.close());
  const number = '+12025550101', other = '+12025550102';
  const config = readConfig({ NODE_ENV: 'test', DEV_OTP_CODE: '123456',
    TEST_PHONE_NUMBERS: JSON.stringify([number, other]), TEST_OTP_CODES: '["012345","654321"]' });
  const auth = new AuthService(context.db, config);
  const testChallenge = await auth.requestCode(number);
  assert.equal(testChallenge.delivery, 'test');
  await assert.rejects(auth.verifyCode(testChallenge.challengeId, '123456'), { status: 401 });
  assert.equal((await auth.verifyCode(testChallenge.challengeId, '012345')).user.phoneNumber, number);
  const development = await auth.requestCode('+12025550999');
  assert.equal(development.delivery, 'development');
  const old = await auth.requestCode(number);
  const production = new AuthService(context.db, readConfig({ NODE_ENV: 'production',
    TEST_PHONE_NUMBERS: JSON.stringify([number]), TEST_OTP_CODES: '["111111"]' }));
  await assert.rejects(production.verifyCode(old.challengeId, '012345'), { status: 401 });
  await assert.rejects(production.verifyCode(old.challengeId, '111111'), { status: 401 });
  const fresh = await production.requestCode(number);
  assert.equal((await production.verifyCode(fresh.challengeId, '111111')).user.phoneNumber, number);
  const removed = await auth.requestCode(other);
  await assert.rejects(production.verifyCode(removed.challengeId, '654321'), { status: 503 });
  const promoted = new AuthService(context.db, readConfig({ NODE_ENV: 'production',
    TEST_PHONE_NUMBERS: '["+12025550999"]', TEST_OTP_CODES: '["111111"]' }));
  await assert.rejects(promoted.verifyCode(development.challengeId, '123456'), { status: 401 });
});

test('production without test accounts stays unavailable even with DEV_OTP_CODE set', async (t) => {
  const context = await testApp({}, { NODE_ENV: 'production' }); t.after(() => context.close());
  const health = await context.app.inject('/health/ready');
  assert.equal(health.json().capabilities.phoneAuthentication, false);
  const request = await context.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phoneNumber: '+12025550101' } });
  assert.equal(request.statusCode, 503);
  const verify = await context.app.inject({ method: 'POST', url: '/v1/auth/otp/verify',
    payload: { challengeId: '00000000-0000-4000-8000-000000000000', code: '123456' } });
  assert.equal(verify.statusCode, 503);
});
