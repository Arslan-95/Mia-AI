import assert from 'node:assert/strict';
import test from 'node:test';
import { phoneSignIn, testApp } from './helpers.js';

test('phone discovery matches only a full normalized international number and returns public profiles', async t => {
  const context = await testApp(); t.after(() => context.close());
  const { app } = context;
  const owner = await phoneSignIn(app, '+12025550100', 'lookup_owner');
  const anna = await phoneSignIn(app, '+12025550101', 'lookup_anna');
  await phoneSignIn(app, '+12025550102', 'lookup_ben');
  // A verified account whose profile has not been completed is not discoverable.
  const challenge = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phoneNumber: '+12025550103' } });
  await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { challengeId: challenge.json().challengeId, code: '123456' } });
  const headers = { authorization: `Bearer ${owner.token}` };
  const lookup = (query: string) => app.inject({ url: `/v1/users?query=${encodeURIComponent(query)}`, headers });
  assert.equal((await app.inject(`/v1/users?query=${encodeURIComponent('+12025550101')}`)).statusCode, 401);
  for (const query of ['+12025550101', '+1 (202) 555-0101', '001 202 555 0101']) {
    const response = await lookup(query); assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), [{ id: anna.user.id, username: 'lookup_anna', displayName: anna.user.displayName }]);
    assert.ok(!response.body.includes('phoneNumber')); assert.ok(!response.body.includes('+12025550101'));
  }
  for (const query of ['2025550101', '+1202', '+1202555%', '+12025550101 OR 1=1', '+012025550101', '+1202555010111111']) {
    const response = await lookup(query); assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().error.code, 'INVALID_PHONE_NUMBER');
  }
  for (const query of ['+12025550100', '+12025550103', '+12025550199']) assert.deepEqual((await lookup(query)).json(), []);
  assert.deepEqual((await lookup('@LOOKUP_AN')).json().map((value: { id: string }) => value.id), [anna.user.id]);
  assert.deepEqual((await lookup('lookup_%')).json(), [], 'SQL wildcards stay literal');
  await app.inject({ method: 'POST', url: '/v1/contacts', headers, payload: { userId: anna.user.id, name: 'Anna' } });
  const saved = await app.inject({ url: `/v1/contacts?query=${encodeURIComponent('+1 (202) 555-0101')}`, headers });
  assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json()[0].id, anna.user.id);
  assert.deepEqual((await app.inject({ url: `/v1/contacts?query=${encodeURIComponent('+12025550102')}`, headers })).json(), []);
});
