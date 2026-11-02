import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { AuthService } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { firebasePhoneVerifier, phoneIdentity } from '../src/firebase-auth.js';
import { testApp } from './helpers.js';

const projectId = 'mia-auth-test';
const phoneNumber = '+12025550101';
const credential = (suffix = 'a') => `test-verified-credential-${suffix}`.padEnd(150, suffix);
const identity = { uid: 'firebase-phone-user', phoneNumber, expiresAt: new Date(Date.now() + 3_600_000) };

test('Firebase registration, interrupted onboarding, logout and repeat login keep one account', async t => {
  const context = await testApp({ firebaseVerifier: async () => identity }, { FIREBASE_PROJECT_ID: projectId });
  t.after(() => context.close());
  const signIn = async (suffix: string) => {
    const result = await context.app.inject({ method: 'POST', url: '/v1/auth/firebase', payload: { idToken: credential(suffix) } });
    assert.equal(result.statusCode, 200, result.body);
    return result.json();
  };
  const logout = async (token: string) => {
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await context.app.inject({ method: 'POST', url: '/v1/auth/logout', headers })).statusCode, 204);
    assert.equal((await context.app.inject({ url: '/v1/me', headers })).statusCode, 401);
  };
  const first = await signIn('registration');
  assert.equal(first.user.phoneNumber, phoneNumber);
  assert.equal(first.user.profileComplete, false);
  await logout(first.token);
  const unfinished = await signIn('unfinished');
  assert.equal(unfinished.user.id, first.user.id);
  assert.equal(unfinished.user.profileComplete, false);
  const profile = await context.app.inject({ method: 'PATCH', url: '/v1/me',
    headers: { authorization: `Bearer ${unfinished.token}` }, payload: { displayName: 'Anna' } });
  assert.equal(profile.statusCode, 200, profile.body);
  assert.equal(profile.json().profileComplete, true);
  await logout(unfinished.token);
  const again = await signIn('returning');
  assert.equal(again.user.id, first.user.id);
  assert.equal(again.user.displayName, 'Anna');
  assert.equal(again.user.profileComplete, true);
  assert.notEqual(again.token, unfinished.token);
  assert.equal((await context.db.query('SELECT id FROM users')).length, 1);
  assert.equal((await context.db.query('SELECT token_hash FROM auth_sessions')).length, 1);
});

test('Firebase exchange retains the existing account and profile, issues a Mia session and rejects replay', async t => {
  const context = await testApp({ firebaseVerifier: async () => identity }, { FIREBASE_PROJECT_ID: projectId });
  t.after(() => context.close());
  const legacy = new AuthService(context.db, readConfig({ NODE_ENV: 'test', DEV_OTP_CODE: '123456' }));
  const challenge = await legacy.requestCode(phoneNumber);
  const previous = await legacy.verifyCode(challenge.challengeId, '123456');
  await legacy.updateProfile(previous.user.id, 'Existing person');
  const login = await context.app.inject({ method: 'POST', url: '/v1/auth/firebase', payload: { idToken: credential() } });
  assert.equal(login.statusCode, 200, login.body);
  const session = login.json();
  assert.equal(session.user.id, previous.user.id);
  assert.equal(session.user.phoneNumber, phoneNumber);
  assert.equal(session.user.displayName, 'Existing person');
  assert.equal(session.user.profileComplete, true);
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  const headers = { authorization: `Bearer ${session.token}` };
  assert.equal((await context.app.inject({ url: '/v1/me', headers })).statusCode, 200);
  assert.equal((await context.app.inject({ method: 'POST', url: '/v1/auth/logout', headers })).statusCode, 204);
  assert.equal((await context.app.inject({ url: '/v1/me', headers })).statusCode, 401);
  const replay = await context.app.inject({ method: 'POST', url: '/v1/auth/firebase', payload: { idToken: credential() } });
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error.code, 'INVALID_PHONE_CREDENTIAL');
  const stored = await context.db.query<{ token_hash: string }>('SELECT token_hash FROM firebase_sign_ins');
  assert.match(stored[0]!.token_hash, /^[a-f0-9]{64}$/);
  assert.equal((await context.db.query('SELECT id FROM users')).length, 1);
});

test('Firebase mode disables both fixed-code routes even when test codes remain configured', async t => {
  const context = await testApp({ firebaseVerifier: async () => identity }, { FIREBASE_PROJECT_ID: projectId,
    TEST_PHONE_NUMBERS: JSON.stringify([phoneNumber]), TEST_OTP_CODES: '["012345"]' });
  t.after(() => context.close());
  const request = await context.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phoneNumber } });
  assert.equal(request.statusCode, 503);
  const verify = await context.app.inject({ method: 'POST', url: '/v1/auth/otp/verify',
    payload: { challengeId: '00000000-0000-4000-8000-000000000000', code: '012345' } });
  assert.equal(verify.statusCode, 503);
  assert.equal((await context.app.inject('/health/ready')).json().capabilities.phoneAuthentication, true);
});

test('unverified credentials and caller-supplied phone numbers never create accounts', async t => {
  let calls = 0;
  const context = await testApp({ firebaseVerifier: async () => {
    calls++; throw new AppError(401, 'INVALID_PHONE_CREDENTIAL', 'Invalid credential.');
  } }, { FIREBASE_PROJECT_ID: projectId });
  t.after(() => context.close());
  const invalid = await context.app.inject({ method: 'POST', url: '/v1/auth/firebase', payload: { idToken: credential() } });
  assert.equal(invalid.statusCode, 401);
  const extra = await context.app.inject({ method: 'POST', url: '/v1/auth/firebase', payload: { idToken: credential(), phoneNumber } });
  assert.equal(extra.statusCode, 400);
  const short = await context.app.inject({ method: 'POST', url: '/v1/auth/firebase', payload: { idToken: 'fake' } });
  assert.equal(short.statusCode, 400);
  assert.equal(calls, 1);
  assert.equal((await context.db.query('SELECT id FROM users')).length, 0);
  assert.equal((await context.db.query('SELECT token_hash FROM auth_sessions')).length, 0);
});

test('concurrent Firebase credential replay produces exactly one session', async t => {
  const context = await testApp({ firebaseVerifier: async () => identity }, { FIREBASE_PROJECT_ID: projectId });
  t.after(() => context.close());
  const results = await Promise.all([1, 2].map(() => context.app.inject({ method: 'POST', url: '/v1/auth/firebase', payload: { idToken: credential('b') } })));
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 401]);
  assert.equal((await context.db.query('SELECT token_hash FROM auth_sessions')).length, 1);
});

test('Firebase phone identity requires the configured project, phone provider and recent sign-in', () => {
  const now = 1_800_000_000_000;
  const valid = { uid: 'phone-user', sub: 'phone-user', aud: projectId, iss: `https://securetoken.google.com/${projectId}`,
    phone_number: phoneNumber, auth_time: now / 1000, exp: now / 1000 + 3600,
    firebase: { sign_in_provider: 'phone', identities: {} } } as DecodedIdToken;
  assert.equal(phoneIdentity(valid, projectId, now).phoneNumber, phoneNumber);
  for (const patch of [{ aud: 'another-project' }, { iss: 'https://example.com' }, { sub: 'another-user' },
    { phone_number: undefined }, { phone_number: '2025550101' }, { auth_time: now / 1000 - 301 },
    { auth_time: now / 1000 + 60 }, { auth_time: undefined }, { exp: now / 1000 },
    { firebase: { sign_in_provider: 'google.com', identities: {} } }]) {
    assert.throws(() => phoneIdentity({ ...valid, ...patch } as DecodedIdToken, projectId, now), { status: 401 });
  }
});

test('real Admin SDK rejects unsigned or foreign-project tokens; emulator is never accepted', async () => {
  const verify = firebasePhoneVerifier(projectId);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { aud: 'foreign-project', iss: 'https://securetoken.google.com/foreign-project',
    sub: 'user', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  for (const header of [{ alg: 'none' }, { alg: 'RS256', kid: 'test-key' }]) {
    await assert.rejects(verify(`${encode(header)}.${encode(claims)}.invalid-signature`), { status: 401 });
  }
  const previous = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  try {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
    await assert.rejects(verify('emulator-token'), { status: 503 });
  } finally {
    if (previous === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    else process.env.FIREBASE_AUTH_EMULATOR_HOST = previous;
  }
});
