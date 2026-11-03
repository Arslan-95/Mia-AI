import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { testDatabase } from './helpers.js';
import { AssistantState } from '../src/agents/state.js';
import { toolsFor } from '../src/agents/tools.js';
import { MessagingService } from '../src/messaging.js';
import { assertContextAccess, clientContextSchema, sameContext } from '../src/agents/context.js';

test('local recordings remain authorized read-only context; agent requests only open the recipient chat', async t => {
  const db = await testDatabase(); t.after(() => db.close());
  const owner = randomUUID(), friend = randomUUID(), stranger = randomUUID();
  for (const [index, id] of [owner, friend, stranger].entries()) await db.query("INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,$3,'Voice Owner','unused')", [id, id + '@test.local', `voice_note_${index}`]);
  const messaging = new MessagingService(db), state = new AssistantState(db), session = await state.session(owner);
  const chat = await messaging.createDirectChat(owner, friend);
  const context = clientContextSchema.parse({ route: `/chat/${chat.id}`, revision: 1, voice: { enabled: true, microphoneMuted: true, revision: 7 },
    voiceNote: { id: randomUUID(), recipientId: friend, durationMs: 3000 } });
  await assertContextAccess(db, owner, context);
  await assert.rejects(assertContextAccess(db, stranger, context), { code: 'NOT_FOUND' });
  assert.equal(sameContext(context, { ...context, voiceNote: { ...context.voiceNote!, id: randomUUID() } }), false);
  assert.equal(sameContext(context, { ...context, voiceNote: { ...context.voiceNote!, recipientId: stranger } }), false);
  await assert.rejects(assertContextAccess(db, owner, { ...context, voiceNote: { ...context.voiceNote!, recipientId: stranger } }), { code: 'NOT_FOUND' });
  const turn = (await state.accept(owner, session.id, randomUUID(), 'I want to record a voice note for my friend.', undefined, context)).turn;
  await db.query("UPDATE assistant_turns SET status='running' WHERE id=$1", [turn.id]);
  const signal = new AbortController().signal;
  for (const agent of ['mia', 'messaging', 'contacts'] as const) {
    const tools = toolsFor(agent, { db, state, turn, signal, delegate: async () => '' });
    assert.equal(tools.has('control_voice_note'), false);
  }
  for (const kind of ['control_voice_note', 'record_voice'])
    await assert.rejects(state.action(turn, signal, kind, {}), { code: 'CLIENT_CONTROLLED_RECORDING' });
  const tools = toolsFor('mia', { db, state, turn, signal, delegate: async () => '' });
  const action = await tools.get('request_voice_recording')!.execute({ recipientId: friend }) as { id: string; kind: string; payload: unknown };
  assert.equal(action.kind, 'open_chat');
  assert.deepEqual(action.payload, { chatId: chat.id });
  assert.equal((await db.query('SELECT id FROM device_actions')).length, 1);
  const feedback = { context, message: 'Recipient chat opened. Recording has not started.' };
  await assert.rejects(state.acknowledgeAction(owner, action.id, true, { ...feedback, mediaId: randomUUID() }), { code: 'CONFLICT' });
  await state.acknowledgeAction(owner, action.id, true, feedback);
  assert.equal((await db.query('SELECT id FROM messages')).length, 0);
  assert.equal((await db.query('SELECT id FROM media')).length, 0);
});
