import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { phoneSignIn, testApp, wav } from './helpers.js';
import { MediaService } from '../src/media.js';

test('authenticated messaging, isolation, drafts and retry-safe delivery', async (t) => {
  const context = await testApp();
  t.after(() => context.close());
  const { app } = context;
  const alice = await phoneSignIn(app, '+15550000001', 'alice');
  const anna = await phoneSignIn(app, '+15550000002', 'anna');
  const david = await phoneSignIn(app, '+15550000003', 'david');
  const headers = { authorization: `Bearer ${alice.token}` };
  const annaHeaders = { authorization: `Bearer ${anna.token}` };
  const davidHeaders = { authorization: `Bearer ${david.token}` };
  assert.equal((await app.inject('/v1/me')).statusCode, 401);
  const health = await app.inject('/health/ready');
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().capabilities.agent, false);

  const contact = await app.inject({ method: 'POST', url: '/v1/contacts', headers, payload: { userId: anna.user.id, name: 'Anna' } });
  assert.equal(contact.statusCode, 201, contact.body);
  assert.equal((await app.inject({ url: '/v1/contacts?query=ann', headers })).json().length, 1);
  const chat = await app.inject({ method: 'POST', url: '/v1/chats', headers, payload: { recipientId: anna.user.id } });
  assert.equal(chat.statusCode, 201, chat.body);
  const chatId = chat.json().id as string;
  assert.equal((await app.inject({ url: `/v1/chats/${chatId}/messages`, headers: davidHeaders })).statusCode, 404);

  const payload = { clientMessageId: randomUUID(), content: { kind: 'text', text: 'See you at seven.' } };
  const sent = await app.inject({ method: 'POST', url: `/v1/chats/${chatId}/messages`, headers, payload });
  assert.equal(sent.statusCode, 201, sent.body);
  const retry = await app.inject({ method: 'POST', url: `/v1/chats/${chatId}/messages`, headers, payload });
  assert.equal(retry.json().id, sent.json().id);
  const changed = await app.inject({ method: 'POST', url: `/v1/chats/${chatId}/messages`, headers,
    payload: { ...payload, content: { kind: 'text', text: 'Different content' } } });
  assert.equal(changed.statusCode, 409);
  const chats = await app.inject({ url: '/v1/chats', headers: annaHeaders });
  assert.equal(chats.statusCode, 200, chats.body);
  assert.equal(chats.json()[0].unreadCount, 1);
  const read = await app.inject({ method: 'POST', url: `/v1/chats/${chatId}/read`, headers: annaHeaders, payload: { messageId: sent.json().id } });
  assert.equal(read.statusCode, 204, read.body);
  assert.equal((await app.inject({ url: '/v1/chats', headers: annaHeaders })).json()[0].unreadCount, 0);

  const draft = await app.inject({ method: 'POST', url: '/v1/drafts', headers,
    payload: { recipientId: anna.user.id, content: { kind: 'text', text: 'First draft' } } });
  assert.equal(draft.statusCode, 201, draft.body);
  assert.deepEqual(draft.json().recipient, { id: anna.user.id, username: 'anna', displayName: 'Anna' });
  const savedDrafts = await app.inject({ url: '/v1/drafts', headers });
  assert.deepEqual(savedDrafts.json()[0].recipient, { id: anna.user.id, username: 'anna', displayName: 'Anna' });
  assert.equal((await app.inject({ url: '/v1/drafts', headers: davidHeaders })).json().length, 0);
  const draftId = draft.json().id as string;
  assert.equal((await app.inject({ method: 'POST', url: `/v1/drafts/${draftId}/confirm`, headers, payload: { version: 1 } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/drafts/${draftId}/review`, headers, payload: { version: 1 } })).statusCode, 200);
  const edited = await app.inject({ method: 'PATCH', url: `/v1/drafts/${draftId}`, headers,
    payload: { version: 1, content: { kind: 'text', text: 'Corrected draft' } } });
  assert.equal(edited.json().version, 2);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/drafts/${draftId}/confirm`, headers, payload: { version: 1 } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/drafts/${draftId}/confirm`, headers, payload: { version: 2 } })).statusCode, 409);
  await app.inject({ method: 'POST', url: `/v1/drafts/${draftId}/review`, headers, payload: { version: 2 } });
  const confirmed = await app.inject({ method: 'POST', url: `/v1/drafts/${draftId}/confirm`, headers, payload: { version: 2 } });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const again = await app.inject({ method: 'POST', url: `/v1/drafts/${draftId}/confirm`, headers, payload: { version: 2 } });
  assert.equal(again.json().id, confirmed.json().id);
  assert.equal((await app.inject({ url: `/v1/chats/${chatId}/messages`, headers: annaHeaders })).json().length, 2);
  assert.equal((await app.inject({ url: '/v1/events', headers: davidHeaders })).json().length, 0);
  const events = (await app.inject({ url: '/v1/events', headers: annaHeaders })).json() as { type: string }[];
  assert.equal(events.filter((event) => event.type === 'message.created').length, 2);

  const media = new MediaService(context.db, context.config.mediaDirectory);
  const uploaded = await media.upload(alice.user.id, wav());
  assert.equal((await app.inject({ url: `/v1/media/${uploaded.id}`, headers: annaHeaders })).statusCode, 404);
  const voice = await app.inject({ method: 'POST', url: `/v1/chats/${chatId}/messages`, headers,
    payload: { clientMessageId: randomUUID(), content: { kind: 'voice', mediaId: uploaded.id } } });
  assert.equal(voice.statusCode, 201, voice.body);
  const playable = await app.inject({ url: `/v1/media/${uploaded.id}`, headers: annaHeaders });
  assert.equal(playable.statusCode, 200);
  assert.deepEqual(playable.rawPayload, wav());
  assert.equal((await app.inject({ url: `/v1/media/${uploaded.id}`, headers: davidHeaders })).statusCode, 404);

  await app.inject({ method: 'POST', url: '/v1/auth/logout', headers });
  assert.equal((await app.inject({ url: '/v1/me', headers })).statusCode, 401);
  const login = await phoneSignIn(app, '+15550000001');
  assert.equal(login.user.id, alice.user.id);
  assert.notEqual(login.token, alice.token);
});
