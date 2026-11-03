import { AppError } from './errors.js';

export function isPhoneSearch(query: string) {
  return /^[+\d(]/.test(query.trim());
}

// The account store uses international numbers. Do not guess a country from
// the device language or match a private phone number by a partial prefix.
export function normalizePhoneSearch(query: string) {
  const value = query.trim();
  const compact = value.replace(/[\s().-]/g, '').replace(/^00/, '+');
  if (!/^[+\d\s().-]+$/.test(value) || !/^\+[1-9]\d{6,14}$/.test(compact)) {
    throw new AppError(400, 'INVALID_PHONE_NUMBER', 'Enter the full phone number with country code, for example +1 202 555 0101.');
  }
  return compact;
}
