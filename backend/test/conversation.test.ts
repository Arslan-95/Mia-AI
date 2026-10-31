import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { conversationInput } from '../src/agents/conversation.js';
import { AssistantState, type Turn } from '../src/agents/state.js';
import type { ClientContext } from '../src/agents/context.js';
import { MessagingService } from '../src/messaging.js';
import { testDatabase } from './helpers.js';

test('conversation replays confirmed speech chronologically, preserves interrupted user fragments and does not repeat a passive card', async t => {
  const db = await testDatabase(); t.after(() => db.close());
  const owner = randomUUID(), friend = randomUUID();
  for (const [id, name] of [[owner, 'owner'], [friend, 'friend']]) await db.query(
    "INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,$3,$3,'unused')", [id, `${id}@example.test`, name]);
  const state = new AssistantState(db), session = await state.session(owner);
  const messaging = new MessagingService(db), chat = await messaging.createDirectChat(owner, friend);
  const source = await messaging.send(friend, chat.id, { kind: 'text', text: 'An unrelated old Sharingan message.' }, randomUUID());
  const screen: ClientContext = { route: `/chat/${chat.id}`, revision: 1,
    reference: { chatId: chat.id, messageId: source.id, revision: 1 } };
  async function add(text: string, reply: string | null, status: Turn['status'] = 'completed', context = screen) {
    const { turn } = await state.accept(owner, session.id, randomUUID(), text, undefined, context);
    await db.query('UPDATE assistant_turns SET status=$2,assistant_text=$3 WHERE id=$1', [turn.id, status, reply]);
    return turn;
  }
  async function narration(turn: Turn, text: string, status: string, userId = owner, kind = 'show_message') {
    await db.query(`INSERT INTO device_actions(id,user_id,session_id,turn_id,generation,kind,payload,state,expires_at)
      VALUES ($1,$2,$3,$4,$5,$8,$6::jsonb,$7,now()+interval '1 minute')`,
    [randomUUID(), userId, session.id, turn.id, turn.generation, JSON.stringify({ chatId: chat.id, messageId: source.id, narration: text }), status, kind]);
  }
  const read = await add('Read the first two messages.', 'Want the third one?');
  await narration(read, 'The first message asks about a blue notebook.', 'completed');
  await narration(read, 'The second message explains Sharingan.', 'completed');
  await narration(read, 'This narration never completed.', 'failed');
  await narration(read, 'One message could not be read; I will continue.', 'completed', owner, 'announce_message_skip');
  await narration(read, 'This skip warning never played.', 'failed', owner, 'announce_message_skip');
  await narration(read, 'This narration is pending.', 'pending');
  await narration(read, 'Another account must not appear.', 'completed', friend);
  await add('Let us ask about that notebook.', 'How about: Are you bringing the blue notebook on Friday?');
  const interrupted = await add('Make something like that question', null, 'interrupted');
  await narration(interrupted, 'I can suggest a shorter question.', 'completed');
  await narration(interrupted, 'This speech was cancelled.', 'cancelled');
  await add('but another one', 'Will you bring the notebook this Friday?', 'completed', {
    ...screen, revision: 4, reference: { ...screen.reference!, revision: 8 },
    voice: { enabled: true, microphoneMuted: false, revision: 9 },
  });
  const { turn } = await state.accept(owner, session.id, randomUUID(), 'Repeat what you just said.', undefined, screen);
  const input = await conversationInput(db, state, turn);
  const serialized = JSON.stringify(input);
  const speech = input.filter(item => item.role === 'assistant').map(item =>
    (item.content as { text: string }[]).map(part => part.text));
  assert.deepEqual(speech, [
    ['The first message asks about a blue notebook.', 'The second message explains Sharingan.', 'One message could not be read; I will continue.', 'Want the third one?'],
    ['How about: Are you bringing the blue notebook on Friday?'],
    ['I can suggest a shorter question.'],
    ['Will you bring the notebook this Friday?'],
  ]);
  for (const text of ['never completed', 'never played', 'is pending', 'Another account', 'was cancelled', 'That turn was interrupted or did not complete']) assert.equal(serialized.includes(text), false);
  assert.equal(serialized.split('screenAtRequest').length - 1, 1, 'unchanged source must not be reintroduced after every utterance');
  assert.ok(serialized.includes('Make something like that question'));
  assert.ok(serialized.includes('but another one'));
  assert.ok(serialized.includes('"status":"interrupted"') || serialized.includes('\\"status\\":\\"interrupted\\"'));
  assert.deepEqual(input.at(-1), { role: 'user', content: [{ type: 'input_text', text: 'Repeat what you just said.' }] });
  await db.query("UPDATE assistant_turns SET status='completed',assistant_text='Will you bring the notebook this Friday?' WHERE id=$1", [turn.id]);
  await add('Would you please make something like that question', null, 'interrupted');
  const fragment = await state.accept(owner, session.id, randomUUID(), 'but another one', undefined, screen);
  const joined = await conversationInput(db, state, fragment.turn);
  const last = joined.at(-1)!;
  assert.equal(last.role, 'user');
  assert.equal((last.content as { text: string }[])[0]!.text, 'Would you please make something like that question\nbut another one');
});
