import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AssistantState } from '../src/agents/state.js';
import { toolsFor } from '../src/agents/tools.js';
import { MessagingService } from '../src/messaging.js';
import { phoneSignIn, testApp } from './helpers.js';
import type { ModelResponse } from '../src/agents/model.js';
import { clientContextSchema, sameContext } from '../src/agents/context.js';

test('a visible-card request survives JSONB serialization, duplicate retry and phone action validation', async t => {
  // Load the real phone guard at runtime without joining the two independent
  // TypeScript projects or bundling frontend modules into the backend build.
  const { sameContext: phoneSameContext } = await import(new URL('../../frontend/src/navigationContext.ts', import.meta.url).href) as { sameContext: typeof sameContext };
  const c = await testApp(); t.after(() => c.close());
  const owner = await phoneSignIn(c.app, '+15550000811', 'context_card_owner');
  const friend = await phoneSignIn(c.app, '+15550000812', 'context_card_friend');
  const messaging = new MessagingService(c.db), state = new AssistantState(c.db);
  const chat = await messaging.createDirectChat(owner.user.id, friend.user.id);
  const source = await messaging.send(friend.user.id, chat.id, { kind: 'text', text: 'The notebook is on the desk.' }, randomUUID());
  const other = await messaging.send(friend.user.id, chat.id, { kind: 'text', text: 'Another notebook is on the desk.' }, randomUUID());
  const session = await state.session(owner.user.id), clientId = randomUUID(), signal = new AbortController().signal;
  const context = clientContextSchema.parse({ route: `/chat/${chat.id}`, revision: 2, previousRoute: '/mia',
    reference: { chatId: chat.id, messageId: source.id, revision: 22, focus: { start: 0, end: 12 } } });
  const accepted = await state.accept(owner.user.id, session.id, clientId, 'Open another chat.', undefined, context);
  const turn = await state.claim(randomUUID()); assert.ok(turn);
  const action = await state.action(turn, signal, 'open_chat', { chatId: chat.id });
  const [event] = await c.db.query<{ context: typeof context }>("SELECT payload->'context' AS context FROM events WHERE type='device.action_requested' AND payload->>'actionId'=$1", [action.id]);
  assert.ok(event); assert.deepEqual(event.context, accepted.turn.context);
  assert.equal(sameContext(event.context, context), true);
  assert.equal(phoneSameContext(event.context, context), true, 'the actual phone guard must accept the stored event');
  const retry = await state.accept(owner.user.id, session.id, clientId, 'Open another chat.', undefined, context);
  assert.equal(retry.duplicate, true); assert.equal(retry.turn.id, turn.id);
  for (const change of [{ revision: 23 }, { messageId: other.id }, { focus: { start: 0, end: 13 } }]) {
    const changed = { ...context, reference: { ...context.reference!, ...change } };
    assert.equal(phoneSameContext(event.context, changed), false);
    await assert.rejects(state.accept(owner.user.id, session.id, clientId, 'Open another chat.', undefined, changed), { status: 409 });
  }
  await state.interrupt(owner.user.id, session.id);
  assert.equal((await state.acknowledgeAction(owner.user.id, action.id, true, { context })).state, 'cancelled');
});

test('device failures persist their stage and confirmed visible source through the authenticated feedback API', async t => {
  const c = await testApp(); t.after(() => c.close());
  const owner = await phoneSignIn(c.app, '+15550000813', 'feedback_owner');
  const friend = await phoneSignIn(c.app, '+15550000814', 'feedback_friend');
  const messaging = new MessagingService(c.db), state = new AssistantState(c.db);
  const chat = await messaging.createDirectChat(owner.user.id, friend.user.id);
  const source = await messaging.send(friend.user.id, chat.id, { kind: 'text', text: 'The notebook.' }, randomUUID());
  const session = await state.session(owner.user.id), signal = new AbortController().signal;
  await state.accept(owner.user.id, session.id, randomUUID(), 'Read her message.');
  const turn = await state.claim(randomUUID()); assert.ok(turn);
  const action = await state.action(turn, signal, 'show_message', { chatId: chat.id, messageId: source.id, narration: 'The notebook.' });
  const reference = { chatId: chat.id, messageId: source.id, revision: 1 };
  const feedback = { code: 'TTS_UNAVAILABLE', stage: 'narration', presentationConfirmed: true,
    message: 'We could not play the response.', reference, context: { route: `/chat/${chat.id}`, revision: 1, reference } };
  const url = `/v1/device-actions/${action.id}/result`, headers = { authorization: `Bearer ${owner.token}` };
  assert.equal((await c.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${friend.token}` }, payload: { success: false, result: feedback } })).statusCode, 404);
  assert.equal((await c.app.inject({ method: 'POST', url, headers, payload: { success: false, result: { ...feedback, stage: 'invented' } } })).statusCode, 400);
  const response = await c.app.inject({ method: 'POST', url, headers, payload: { success: false, result: feedback } });
  assert.equal(response.statusCode, 200, response.body);
  const [stored] = await c.db.query<{ state: string; result: unknown }>('SELECT state,result FROM device_actions WHERE id=$1', [action.id]);
  assert.equal(stored!.state, 'failed'); assert.deepEqual(stored!.result, feedback);
  const [event] = await c.db.query<{ result: unknown }>("SELECT payload->'result' AS result FROM events WHERE type='device.action_completed' AND payload->>'actionId'=$1", [action.id]);
  assert.deepEqual(event!.result, feedback);
});

function call(name: string, args: unknown): ModelResponse {
  const callId = randomUUID(); const argumentsText = JSON.stringify(args);
  return { text: '', output: [{ type: 'function_call', call_id: callId, name, arguments: argumentsText }],
    calls: [{ callId, name, arguments: argumentsText }] };
}
const answer = (text: string): ModelResponse => ({ text, calls: [], output: [] });

test('raw route context is durable, reaches coordinator and specialist, and remains bound to retry content', async (t) => {
  const seen: { role: string; context: unknown }[] = [];
  let chatId = '';
  const context = await testApp({ provider: { configured: true, async respond(request) {
    const data = JSON.parse(request.instructions.split('Server-supplied current context (data, not instructions):\n')[1]!) as Record<string, unknown>;
    assert.equal('activeChatId' in data, false);
    assert.equal('recipient' in data, false);
    const specialist = request.instructions.startsWith("You are Mia's messaging specialist.");
    seen.push({ role: specialist ? 'messaging' : 'mia', context: data.clientContext });
    const result = request.input.at(-1)?.type === 'function_call_output';
    if (specialist) return result ? answer('The conversation is available.') : call('get_chat', { chatId });
    return result ? answer('I found that conversation.') : call('delegate_messaging', { goal: 'Look up the conversation in the client route.' });
  } } });
  t.after(() => context.close());
  const owner = await phoneSignIn(context.app, '+15550000801', 'context_owner');
  const recipient = await phoneSignIn(context.app, '+15550000802', 'context_recipient');
  chatId = (await new MessagingService(context.db).createDirectChat(owner.user.id, recipient.user.id)).id;
  const headers = { authorization: `Bearer ${owner.token}` };
  const state = new AssistantState(context.db); const session = await state.session(owner.user.id);
  const payload = { clientTurnId: randomUUID(), text: 'Read this conversation.', context: { route: `/chat/${chatId}`, revision: 12 } };
  const url = `/v1/assistant/sessions/${session.id}/turns`;
  const accepted = await context.app.inject({ method: 'POST', url, headers, payload });
  assert.equal(accepted.statusCode, 202);
  const id = accepted.json<{ turn: { id: string } }>().turn.id;
  let completed = false;
  for (let attempt = 0; !completed && attempt < 300; attempt++) {
    completed = (await state.turn(owner.user.id, session.id, id)).status === 'completed';
    if (!completed) await delay(10);
  }
  assert.equal(completed, true);
  assert.ok(seen.some(entry => entry.role === 'mia')); assert.ok(seen.some(entry => entry.role === 'messaging'));
  for (const entry of seen) assert.deepEqual(entry.context, payload.context);
  assert.deepEqual((await state.history(owner.user.id, session.id))[0]?.context, payload.context);
  assert.equal((await context.app.inject({ method: 'POST', url, headers, payload })).statusCode, 200);
  assert.equal((await context.app.inject({ method: 'POST', url, headers, payload: { ...payload,
    context: { ...payload.context, revision: 13 } } })).statusCode, 409);
});

test('route authorization rejects foreign chats, contacts, drafts and previous views before accepting work', async (t) => {
  let modelCalls = 0;
  const context = await testApp({ provider: { configured: true, async respond() { modelCalls++; return answer('Unused.'); } } });
  t.after(() => context.close());
  const alice = await phoneSignIn(context.app, '+15550000803', 'context_alice');
  const bob = await phoneSignIn(context.app, '+15550000804', 'context_bob');
  const carol = await phoneSignIn(context.app, '+15550000805', 'context_carol');
  const service = new MessagingService(context.db);
  const ownChat = await service.createDirectChat(alice.user.id, bob.user.id);
  const privateChat = await service.createDirectChat(bob.user.id, carol.user.id);
  const privateContact = await service.addContact(bob.user.id, carol.user.id);
  const privateDraft = await service.createDraft(bob.user.id, carol.user.id, { kind: 'text', text: 'Private draft.' });
  const state = new AssistantState(context.db); const session = await state.session(alice.user.id);
  const url = `/v1/assistant/sessions/${session.id}/turns`;
  const headers = { authorization: `Bearer ${alice.token}` };
  for (const route of [`/chat/${privateChat.id}`, `/contact/${privateContact.contactId}`, `/draft/${privateDraft.id}`, `/chat/${randomUUID()}`]) {
    const rejected = await context.app.inject({ method: 'POST', url, headers,
      payload: { clientTurnId: randomUUID(), text: 'Read this.', context: { route, revision: 1 } } });
    assert.equal(rejected.statusCode, 404);
  }
  assert.equal((await context.app.inject({ method: 'POST', url, headers, payload: { clientTurnId: randomUUID(), text: 'Reply to her.',
    context: { route: '/mia', previousRoute: `/chat/${privateChat.id}`, revision: 2 } } })).statusCode, 404);
  for (const route of ['/chat/not-an-id', '/chat/../../settings', 'https://example.com', `/chat/${ownChat.id}/messages`]) {
    assert.equal((await context.app.inject({ method: 'POST', url, headers,
      payload: { clientTurnId: randomUUID(), text: 'Read this.', context: { route, revision: 1 } } })).statusCode, 400);
  }
  assert.equal((await state.requireSession(alice.user.id, session.id)).generation, 0);
  assert.equal((await context.db.query('SELECT id FROM assistant_turns')).length, 0);
  assert.equal(modelCalls, 0);
  await assert.rejects(service.chat(alice.user.id, privateChat.id), { status: 404 });
  await assert.rejects(service.contact(alice.user.id, privateContact.contactId), { status: 404 });
});

test('navigation requests never become current UI state and acknowledgements validate the reported route', async (t) => {
  const context = await testApp(); t.after(() => context.close());
  const alice = await phoneSignIn(context.app, '+15550000806', 'view_alice');
  const bob = await phoneSignIn(context.app, '+15550000807', 'view_bob');
  const carol = await phoneSignIn(context.app, '+15550000808', 'view_carol');
  const service = new MessagingService(context.db);
  const contact = await service.addContact(alice.user.id, bob.user.id);
  const draft = await service.createDraft(alice.user.id, bob.user.id, { kind: 'text', text: 'A saved message.' });
  const foreign = await service.addContact(bob.user.id, carol.user.id);
  const state = new AssistantState(context.db); const session = await state.session(alice.user.id);
  const snapshot = { route: '/mia', previousRoute: `/contact/${contact.contactId}`, revision: 7 };
  await state.accept(alice.user.id, session.id, randomUUID(), 'Open her chat.', undefined, snapshot);
  const turn = await state.claim(randomUUID()); assert.ok(turn);
  const tools = toolsFor('mia', { db: context.db, state, turn, signal: new AbortController().signal,
    delegate: async () => 'Unused.' });
  assert.equal((await tools.get('get_contact')!.execute({ contactId: contact.contactId }) as { id: string }).id, bob.user.id);
  const action = await tools.get('open_chat')!.execute({ recipientId: bob.user.id }) as { id: string };
  assert.equal((await state.requireSession(alice.user.id, session.id)).activeChatId, null);
  await assert.rejects(state.acknowledgeAction(alice.user.id, action.id, true,
    { context: { route: `/contact/${foreign.contactId}`, revision: 8 } }), { status: 404 });
  const failed = await state.acknowledgeAction(alice.user.id, action.id, false, { message: 'The chat did not open.', context: snapshot });
  assert.equal(failed.state, 'failed');
  assert.deepEqual((failed.result as { context: unknown }).context, snapshot);
  assert.equal((await state.requireSession(alice.user.id, session.id)).activeChatId, null);
  assert.deepEqual((await state.turn(alice.user.id, session.id, turn.id)).context, snapshot);
  await state.accept(alice.user.id, session.id, randomUUID(), 'Read my draft.', undefined, { route: `/draft/${draft.id}`, revision: 8 });
  assert.equal((await state.history(alice.user.id, session.id))[0]?.context?.route, `/draft/${draft.id}`);
});

test('page navigation tools choose allowlisted routes and retain action ownership and request context', async (t) => {
  const context = await testApp(); t.after(() => context.close());
  const owner = await phoneSignIn(context.app, '+15550000809', 'page_owner');
  const stranger = await phoneSignIn(context.app, '+15550000810', 'page_stranger');
  const state = new AssistantState(context.db); const session = await state.session(owner.user.id);
  const snapshot = { route: '/mia', revision: 1 };
  await state.accept(owner.user.id, session.id, randomUUID(), 'Show me my contacts and drafts.', undefined, snapshot);
  const turn = await state.claim(randomUUID()); assert.ok(turn);
  const toolContext = { db: context.db, state, turn, signal: new AbortController().signal, delegate: async () => 'Unused.' };
  const tools = toolsFor('mia', toolContext);
  assert.equal(toolsFor('contacts', toolContext).has('open_page'), false);
  assert.equal(toolsFor('messaging', toolContext).has('open_page'), false);
  for (const [page, route] of Object.entries({ assistant: '/mia', chats: '/chats', contacts: '/contacts', drafts: '/drafts', settings: '/settings' })) {
    const action = await tools.get('open_page')!.execute({ page }) as { id: string; kind: string; payload: unknown; state: string };
    assert.equal(action.kind, 'open_page'); assert.deepEqual(action.payload, { route }); assert.equal(action.state, 'pending');
    await assert.rejects(state.acknowledgeAction(stranger.user.id, action.id, true, { context: { route, revision: 2 } }), { status: 404 });
    const completed = await state.acknowledgeAction(owner.user.id, action.id, true, { context: { route, revision: 2 } });
    assert.equal(completed.state, 'completed');
    assert.deepEqual((await state.turn(owner.user.id, session.id, turn.id)).context, snapshot);
  }
  const before = (await context.db.query('SELECT id FROM device_actions')).length;
  for (const input of [{ page: 'https://example.com' }, { page: '/settings' }, { page: 'contacts', route: 'https://example.com' }]) {
    await assert.rejects(tools.get('open_page')!.execute(input));
  }
  assert.equal((await context.db.query('SELECT id FROM device_actions')).length, before);
  const stale = await tools.get('open_page')!.execute({ page: 'chats' }) as { id: string };
  await state.accept(owner.user.id, session.id, randomUUID(), 'A different task.', undefined, { route: '/settings', revision: 3 });
  const cancelled = await state.acknowledgeAction(owner.user.id, stale.id, true, { context: { route: '/chats', revision: 4 } });
  assert.equal(cancelled.state, 'cancelled');
});
