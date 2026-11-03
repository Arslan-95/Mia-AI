import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../src/config.js';

test('test phone OTP arrays pair by index and preserve leading zeros for any number of accounts', () => {
  const numbers = Array.from({ length: 25 }, (_, index) => `+1202555${String(index).padStart(4, '0')}`);
  const codes = numbers.map((_, index) => String(index).padStart(6, '0'));
  const config = readConfig({ NODE_ENV: 'production', TEST_PHONE_NUMBERS: JSON.stringify(numbers), TEST_OTP_CODES: JSON.stringify(codes) });
  assert.deepEqual([...config.testPhoneOtps], numbers.map((number, index) => [number, codes[index]]));
});

test('test phone OTP arrays are disabled when absent, empty or blank', () => {
  for (const env of [{}, { TEST_PHONE_NUMBERS: '', TEST_OTP_CODES: ' ' }, { TEST_PHONE_NUMBERS: '[]', TEST_OTP_CODES: '[]' }]) {
    assert.equal(readConfig(env).testPhoneOtps.size, 0);
  }
});

test('test phone OTP arrays reject mismatched lengths and duplicate numbers', () => {
  for (const env of [
    { TEST_PHONE_NUMBERS: '["+12025550101"]' },
    { TEST_OTP_CODES: '["123456"]' },
    { TEST_PHONE_NUMBERS: '["+12025550101","+12025550102"]', TEST_OTP_CODES: '["123456"]' },
  ]) assert.throws(() => readConfig(env), /same number of entries/);
  assert.throws(() => readConfig({
    TEST_PHONE_NUMBERS: '["+12025550101"," +12025550101 "]', TEST_OTP_CODES: '["123456","654321"]',
  }), /duplicate phone numbers/);
});

test('test phone OTP arrays reject malformed JSON, non-string items, invalid numbers and invalid codes', () => {
  const valid = { TEST_PHONE_NUMBERS: '["+12025550101"]', TEST_OTP_CODES: '["012345"]' };
  for (const value of ['[', '+12025550101', 'null', '{}', '"+12025550101"', '[12025550101]', '["2025550101"]', '["+01234567"]', '["+1 202 555 0101"]', '[""]']) {
    assert.throws(() => readConfig({ ...valid, TEST_PHONE_NUMBERS: value }), value);
  }
  for (const value of ['[', '012345', 'null', '{}', '"012345"', '[123456]', '["12345"]', '["1234567"]', '["abcdef"]', '[""]']) {
    assert.throws(() => readConfig({ ...valid, TEST_OTP_CODES: value }), value);
  }
});
