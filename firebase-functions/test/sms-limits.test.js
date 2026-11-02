import assert from 'node:assert/strict';
import test from 'node:test';
import { digest, guardSms, ipBucket, reserveSms, SMS_LIMITS } from '../src/sms-limits.js';

const secret = 'test-only-hmac-key-that-is-not-used-in-production';
const base = 1_800_000_000_000;
const event = (id, ip = '192.0.2.1', phone = '+12025550101') => ({ id, ipAddress: ip, additionalUserInfo: { phoneNumber: phone } });

function memoryStore() {
  const records = new Map();
  let queue = Promise.resolve();
  return { records, transaction: operation => {
    const result = queue.then(async () => {
      const staged = new Map(records);
      const value = await operation({
        read: async keys => Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, structuredClone(staged.get(key))])),
        write: (keys, states, expiresAt) => {
          for (const name of ['ip', 'phone', 'global']) staged.set(keys[name], { attempts: states[name], expiresAt });
          staged.set(keys.event, { expiresAt });
        },
      });
      records.clear(); for (const [key, record] of staged) records.set(key, record);
      return value;
    });
    queue = result.catch(() => {});
    return result;
  } };
}

test('canonical IP buckets defeat alternative spellings and IPv6 interface rotation', () => {
  assert.equal(ipBucket('192.0.2.1'), '192.0.2.1');
  assert.equal(ipBucket('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(ipBucket('::FFFF:C000:0201'), '192.0.2.1');
  assert.equal(ipBucket('2001:0db8:ABCD:0012::1'), ipBucket('2001:db8:abcd:12:abcd:1111:2222:3333'));
  assert.notEqual(ipBucket('2001:db8:abcd:12::1'), ipBucket('2001:db8:abcd:13::1'));
  for (const invalid of ['', undefined, '192.0.2.1, 192.0.2.2', 'not-an-ip', 'fe80::1%eth0']) assert.throws(() => ipBucket(invalid));
});

test('one IP cannot send repeatedly by changing the destination phone', async () => {
  const store = memoryStore();
  assert.equal(await guardSms(store, secret, event('first'), base), true);
  assert.equal(await guardSms(store, secret, event('blocked', '192.0.2.1', '+995555123456'), base + 59_999), false);
  assert.equal(await guardSms(store, secret, event('next', '192.0.2.1', '+995555123456'), base + 60_000), true);
});

test('one phone cannot bypass its cooldown by changing IPs', async () => {
  const store = memoryStore();
  assert.equal(await guardSms(store, secret, event('first'), base), true);
  assert.equal(await guardSms(store, secret, event('blocked', '198.51.100.1'), base + 59_999), false);
  assert.equal(await guardSms(store, secret, event('next', '198.51.100.1'), base + 60_000), true);
});

test('five sends per fifteen minutes and ten per rolling day have precise reset boundaries', () => {
  let states = { ip: [], phone: [], global: [] };
  for (let index = 0; index < 5; index++) states = reserveSms(states, base + index * 60_000);
  assert.equal(reserveSms(states, base + 5 * 60_000), null);
  states = reserveSms(states, base + 15 * 60_000);
  assert.ok(states);
  for (let index = 1; index < 5; index++) states = reserveSms(states, base + (15 + index) * 60_000);
  assert.equal(states.global.length, 10);
  assert.equal(reserveSms(states, base + 60 * 60_000), null);
  assert.ok(reserveSms(states, base + SMS_LIMITS.dayMs));
});

test('a global atomic budget caps distributed simultaneous requests at ten', async () => {
  const store = memoryStore();
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => guardSms(store, secret,
    event(`parallel-${index}`, `192.0.2.${index + 1}`, `+1202555${String(1000 + index)}`), base)));
  assert.equal(results.filter(Boolean).length, 10);
  assert.equal(store.records.get(digest(secret, 'global', 'sms')).attempts.length, 10);
});

test('provider retries are idempotent and blocked requests never consume other counters', async () => {
  const store = memoryStore();
  const request = event('same-delivery');
  assert.equal(await guardSms(store, secret, request, base), true);
  assert.equal(await guardSms(store, secret, request, base + 100), true);
  const before = structuredClone([...store.records]);
  assert.equal(await guardSms(store, secret, event('blocked'), base + 1_000), false);
  assert.deepEqual([...store.records], before);
});

test('missing identity, missing secret, corrupt state and unavailable storage fail closed', async () => {
  const store = memoryStore();
  for (const invalid of [{}, { ...event('id'), id: '' }, { ...event('id'), ipAddress: undefined },
    { ...event('id'), additionalUserInfo: { phoneNumber: '5551234' } }]) await assert.rejects(guardSms(store, secret, invalid, base));
  await assert.rejects(guardSms(store, '', event('id'), base));
  store.records.set(digest(secret, 'ip', '192.0.2.1'), { attempts: ['corrupt'] });
  await assert.rejects(guardSms(store, secret, event('id'), base));
  assert.equal(store.records.has(digest(secret, 'global', 'sms')), false);
  await assert.rejects(guardSms({ transaction: async () => { throw new Error('Database unavailable'); } }, secret, event('id'), base));
});

test('stored keys and values do not contain raw IPs, phone numbers or event identifiers', async () => {
  const store = memoryStore();
  await guardSms(store, secret, event('private-event-id'), base);
  const serialized = JSON.stringify([...store.records]);
  for (const value of ['192.0.2.1', '+12025550101', 'private-event-id', secret]) assert.equal(serialized.includes(value), false);
  assert.equal([...store.records.keys()].every(key => /^[a-f0-9]{64}$/.test(key)), true);
});
