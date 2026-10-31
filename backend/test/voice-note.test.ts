import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { testDatabase } from './helpers.js';
import { AssistantState } from '../src/agents/state.js';
import { toolsFor } from '../src/agents/tools.js';
import { MessagingService } from '../src/messaging.js';
import { assertContextAccess, clientContextSchema, sameContext } from '../src/agents/context.js';

test('local original recordings are authorized, immutable request context and require later approval before sending', async t => {
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
  const first = (await state.accept(owner, session.id, randomUUID(), 'I finished recording. Ask whether to send.', undefined, context)).turn;
  await db.query("UPDATE assistant_turns SET status='running' WHERE id=$1", [first.id]);
  const signal = new AbortController().signal;
  const tools = (turn: typeof first) => toolsFor('mia', { db, state, turn, signal, delegate: async () => '' });
  await assert.rejects(tools(first).get('control_voice_note')!.execute({ recordingId: context.voiceNote!.id, action: 'send' }), { code: 'CONFLICT' });
  assert.equal((await db.query('SELECT id FROM device_actions')).length, 0);
  await state.finish(first, signal, 'Send your voice note to your friend?');
  const elsewhere = { ...context, route: '/contacts', revision: 2 };
  const second = (await state.accept(owner, session.id, randomUUID(), 'Send that voice note to my friend.', undefined, elsewhere)).turn;
  await db.query("UPDATE assistant_turns SET status='running' WHERE id=$1", [second.id]);
  await assert.rejects(tools(second).get('control_voice_note')!.execute({ recordingId: randomUUID(), action: 'send' }), { code: 'CONFLICT' });
  const requested = tools(second).get('control_voice_note')!.execute({ recordingId: context.voiceNote!.id, action: 'send' });
  let action: { id: string; payload: unknown; seconds: number } | undefined;
  for (let i = 0; i < 100 && !action; i++) {
    [action] = await db.query<typeof action & {}>("SELECT id,payload,extract(epoch FROM expires_at-created_at)::integer AS seconds FROM device_actions WHERE kind='control_voice_note'");
    if (!action) await delay(10);
  }
  assert.ok(action);
  assert.deepEqual(action.payload, { recordingId: context.voiceNote!.id, recipientId: friend, action: 'send' });
  assert.ok(action.seconds >= 175, 'original playback can last two minutes');
  await state.acknowledgeAction(owner, action.id, false, { code: 'OFFLINE', message: 'Upload failed.', context });
  assert.equal((await requested as { state: string }).state, 'failed', 'a requested send is never reported as completed without phone confirmation');
});
