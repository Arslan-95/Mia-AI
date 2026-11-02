import assert from 'node:assert/strict';
import test from 'node:test';
import { PhoneSignIn, type PhoneAuthDriver } from '../src/phoneAuth';
import { ApiError } from '../src/api';
import { CancelledError } from '../src/errors';

function setup() {
  let now = 1_800_000_000_000, sends = 0, confirmations = 0, refreshes = 0, signOuts = 0;
  const phoneNumber = '+12025550101';
  const driver: PhoneAuthDriver = {
    signOut: async () => { signOuts++; },
    sendCode: async () => {
      sends++;
      return { verificationId: `verification-${sends}`, confirm: async code => {
        confirmations++;
        if (code !== '654321') throw { code: 'auth/invalid-verification-code', message: 'Private provider details' };
        return { phoneNumber, getIdToken: async refresh => { assert.equal(refresh, true); return `token-${++refreshes}`; } };
      } };
    },
  };
  const flow = new PhoneSignIn(async () => driver, () => now);
  return { flow, driver, phoneNumber, advance: (ms: number) => { now += ms; },
    counts: () => ({ sends, confirmations, refreshes, signOuts }) };
}

test('phone confirmation exchanges the verified token and cleans up Firebase identity', async () => {
  const context = setup();
  const challenge = await context.flow.request(context.phoneNumber);
  assert.equal(challenge.delivery, 'firebase');
  assert.equal(Date.parse(challenge.expiresAt) - Date.parse(challenge.resendAt!), 240_000);
  const session = await context.flow.verify(challenge.challengeId, '654321', async token => {
    assert.equal(token, 'token-1'); return { token: 'mia-session' };
  });
  assert.deepEqual(session, { token: 'mia-session' });
  assert.deepEqual(context.counts(), { sends: 1, confirmations: 1, refreshes: 1, signOuts: 2 });
  await assert.rejects(context.flow.verify(challenge.challengeId, '654321', async () => {}), { code: 'INVALID_OTP' });
});

test('incorrect codes stay retryable and never reach the backend', async () => {
  const context = setup();
  const challenge = await context.flow.request(context.phoneNumber);
  let exchanges = 0;
  await assert.rejects(context.flow.verify(challenge.challengeId, '000000', async () => { exchanges++; }),
    error => error instanceof ApiError && error.code === 'INVALID_OTP' && !error.message.includes('Private'));
  assert.equal(exchanges, 0);
  await context.flow.verify(challenge.challengeId, '654321', async () => { exchanges++; });
  assert.equal(exchanges, 1);
});

test('backend failure retries a fresh token without reconfirming the SMS', async () => {
  const context = setup();
  const challenge = await context.flow.request(context.phoneNumber);
  await assert.rejects(context.flow.verify(challenge.challengeId, '654321', async () => {
    throw new ApiError(0, 'OFFLINE', 'Offline');
  }), { code: 'OFFLINE' });
  await context.flow.verify(challenge.challengeId, '654321', async token => assert.equal(token, 'token-2'));
  assert.equal(context.counts().confirmations, 1);
});

test('cooldown survives cancellation and changing numbers; expired or replaced challenges cannot sign in', async () => {
  const context = setup();
  const old = await context.flow.request(context.phoneNumber);
  context.flow.cancel();
  await assert.rejects(context.flow.request('+995555123456'), { code: 'OTP_RATE_LIMIT' });
  context.advance(60_000);
  const next = await context.flow.request(context.phoneNumber);
  await assert.rejects(context.flow.verify(old.challengeId, '654321', async () => {}), { code: 'INVALID_OTP' });
  context.advance(300_000);
  await assert.rejects(context.flow.verify(next.challengeId, '654321', async () => {}), { code: 'INVALID_OTP' });
  assert.equal(context.counts().confirmations, 0);
});

test('a cancelled pending verification cannot exchange or sign in as another number', async () => {
  const context = setup();
  let resolve!: (value: Awaited<ReturnType<Awaited<ReturnType<PhoneAuthDriver['sendCode']>>['confirm']>>) => void;
  context.driver.sendCode = async () => ({ verificationId: 'pending', confirm: () => new Promise(done => { resolve = done; }) });
  const challenge = await context.flow.request(context.phoneNumber);
  let exchanges = 0;
  const verification = context.flow.verify(challenge.challengeId, '654321', async () => { exchanges++; });
  context.flow.cancel();
  resolve({ phoneNumber: context.phoneNumber, getIdToken: async () => 'token' });
  await assert.rejects(verification, error => error instanceof CancelledError);
  assert.equal(exchanges, 0);
  assert.equal(context.counts().signOuts, 2, 'cancelled native confirmation is signed out before the next attempt');
  context.advance(60_000);
  context.driver.sendCode = async () => ({ verificationId: 'wrong-phone', confirm: async () => ({
    phoneNumber: '+995555123456', getIdToken: async () => 'token' }) });
  const wrong = await context.flow.request(context.phoneNumber);
  await assert.rejects(context.flow.verify(wrong.challengeId, '654321', async () => { exchanges++; }), { code: 'INVALID_OTP' });
  assert.equal(exchanges, 0);
});

test('a provider-side SMS denial is shown as a rate limit without exposing internal details', async () => {
  const context = setup();
  context.driver.sendCode = async () => { throw { code: 'auth/internal-error', message: 'Cloud Function error: OTP_RATE_LIMIT; private diagnostic' }; };
  await assert.rejects(context.flow.request(context.phoneNumber), error => error instanceof ApiError &&
    error.status === 429 && error.code === 'OTP_RATE_LIMIT' && !error.message.includes('private'));
});

test('cancelling after failed exchange clears the idle native identity before a new request', async () => {
  const context = setup();
  const challenge = await context.flow.request(context.phoneNumber);
  await assert.rejects(context.flow.verify(challenge.challengeId, '654321', async () => {
    throw new ApiError(0, 'OFFLINE', 'Offline');
  }), { code: 'OFFLINE' });
  let finishCleanup!: () => void;
  let cleanups = 0;
  context.driver.signOut = async () => {
    if (++cleanups === 1) await new Promise<void>(resolve => { finishCleanup = resolve; });
  };
  context.flow.cancel();
  context.advance(60_000);
  const next = context.flow.request(context.phoneNumber);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(context.counts().sends, 1, 'next SMS waits for cancellation cleanup');
  assert.equal(cleanups, 1);
  finishCleanup();
  await next;
  assert.equal(cleanups, 2);
  assert.equal(context.counts().sends, 2);
});

test('cancelling while successful sign-in cleans up cannot publish the stale Mia session', async () => {
  const context = setup();
  const challenge = await context.flow.request(context.phoneNumber);
  let release!: () => void;
  let cleanups = 0;
  context.driver.signOut = async () => {
    if (++cleanups === 1) await new Promise<void>(resolve => { release = resolve; });
  };
  const verification = context.flow.verify(challenge.challengeId, '654321', async () => 'stale-session');
  await new Promise<void>(resolve => setImmediate(resolve));
  context.flow.cancel();
  release();
  await assert.rejects(verification, error => error instanceof CancelledError);
  assert.equal(cleanups, 2);
});
