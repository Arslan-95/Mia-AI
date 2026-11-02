import assert from 'node:assert/strict';
import test from 'node:test';
import { SmsAttemptBudget } from '../src/smsAttemptBudget';

const start = 1_800_000_000_000;

test('device cooldown persists across app instances and blocks changing numbers', async () => {
  let saved: string | null = null;
  const store = { get: async () => saved, set: async (value: string) => { saved = value; } };
  await new SmsAttemptBudget(store).reserve(start);
  await assert.rejects(new SmsAttemptBudget(store).reserve(start + 59_999), { code: 'OTP_RATE_LIMIT' });
  await new SmsAttemptBudget(store).reserve(start + 60_000);
  assert.equal(JSON.parse(saved!).length, 2);
});

test('device window and daily caps persist while old attempts expire', async () => {
  const budget = new SmsAttemptBudget();
  for (let index = 0; index < 5; index++) await budget.reserve(start + index * 60_000);
  await assert.rejects(budget.reserve(start + 5 * 60_000), { code: 'OTP_RATE_LIMIT' });
  for (let index = 0; index < 5; index++) await budget.reserve(start + (15 + index) * 60_000);
  await assert.rejects(budget.reserve(start + 60 * 60_000), { code: 'OTP_RATE_LIMIT' });
  await budget.reserve(start + 24 * 60 * 60_000);
});

test('corrupt or unwritable device state does not proceed to an SMS attempt', async () => {
  await assert.rejects(new SmsAttemptBudget({ get: async () => 'broken JSON', set: async () => {} }).reserve(start), { code: 'PHONE_AUTH_UNAVAILABLE' });
  await assert.rejects(new SmsAttemptBudget({ get: async () => null, set: async () => { throw new Error('Keychain unavailable'); } }).reserve(start), { code: 'PHONE_AUTH_UNAVAILABLE' });
});
