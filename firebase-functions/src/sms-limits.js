import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

export const SMS_LIMITS = Object.freeze({
  cooldownMs: 60_000,
  windowMs: 15 * 60_000,
  windowMax: 5,
  dayMs: 24 * 60 * 60_000,
  identityDayMax: 10,
  globalDayMax: 10,
});

// Group IPv6 addresses by /64 so rotating an interface identifier does not
// reset a computer's budget. A shared public address also shares its budget.
export function ipBucket(input) {
  if (typeof input !== 'string') throw new Error('Invalid IP address');
  const ip = input.trim();
  const kind = isIP(ip);
  if (kind === 4) return ip;
  if (kind !== 6 || ip.includes('%')) throw new Error('Invalid IP address');
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const sides = canonical.split('::');
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides[1] ? sides[1].split(':') : [];
  const groups = sides.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const words = groups.map(value => Number.parseInt(value, 16));
  if (words.slice(0, 5).every(value => value === 0) && words[5] === 0xffff) {
    return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.');
  }
  return words.slice(0, 4).map(value => value.toString(16)).join(':') + '::/64';
}

export function digest(secret, scope, value) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('SMS guard secret is missing');
  return createHmac('sha256', secret).update(`${scope}:${value}`).digest('hex');
}

function recent(value, now) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some(time => !Number.isSafeInteger(time) || time < 0 || time > now + 30_000)) {
    throw new Error('SMS guard state is invalid');
  }
  return value.filter(time => time > now - SMS_LIMITS.dayMs);
}

export function reserveSms(states, now) {
  const ip = recent(states.ip, now), phone = recent(states.phone, now), global = recent(states.global, now);
  const identities = [ip, phone];
  const blocked = global.length >= SMS_LIMITS.globalDayMax || identities.some(attempts =>
    attempts.some(time => time > now - SMS_LIMITS.cooldownMs) ||
    attempts.filter(time => time > now - SMS_LIMITS.windowMs).length >= SMS_LIMITS.windowMax ||
    attempts.length >= SMS_LIMITS.identityDayMax);
  if (blocked) return null;
  return { ip: [...ip, now], phone: [...phone, now], global: [...global, now] };
}

// All counters and the delivery-event marker are committed in one transaction.
// The store is Firestore in production; it must serialize conflicting writes.
export async function guardSms(store, secret, event, now = Date.now()) {
  const phone = event.additionalUserInfo?.phoneNumber;
  if (typeof phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(phone) ||
      typeof event.id !== 'string' || !event.id || event.id.length > 512) throw new Error('SMS event is incomplete');
  const keys = {
    ip: digest(secret, 'ip', ipBucket(event.ipAddress)),
    phone: digest(secret, 'phone', phone),
    global: digest(secret, 'global', 'sms'),
    event: digest(secret, 'event', event.id),
  };
  return store.transaction(async transaction => {
    const records = await transaction.read(keys);
    if (records.event?.expiresAt > now) return true;
    const reserved = reserveSms({ ip: records.ip?.attempts, phone: records.phone?.attempts, global: records.global?.attempts }, now);
    if (!reserved) return false;
    const expiresAt = now + SMS_LIMITS.dayMs + 60 * 60_000;
    transaction.write(keys, reserved, expiresAt);
    return true;
  });
}
