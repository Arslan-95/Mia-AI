import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { speechPrompt, speechDeliverySchema, calmSpeechPrompt, defaultSpeechDelivery } from '../src/speech/delivery.js';
import { testDatabase } from './helpers.js';
import { AssistantState } from '../src/agents/state.js';
import { toolsFor } from '../src/agents/tools.js';

test('speech delivery defaults to calm and only permits small validated style changes', () => {
  const neutral = speechPrompt(calmSpeechPrompt);
  assert.ok(neutral.includes('matter-of-fact'));
  assert.equal(neutral.split(calmSpeechPrompt).length - 1, 1);
  const gentle = speechPrompt(calmSpeechPrompt, { delivery: { tone: 'gentle', pace: 'unhurried', warmth: 'friendly' }, narration: true });
  assert.ok(gentle.includes('slightly softer')); assert.ok(gentle.includes('unhurried'));
  assert.ok(gentle.includes('read its wording neutrally')); assert.ok(gentle.includes('word for word'));
  assert.equal(speechDeliverySchema.safeParse({ ...defaultSpeechDelivery, tone: 'ecstatic' }).success, false);
  assert.equal(speechDeliverySchema.safeParse({ ...defaultSpeechDelivery, prompt: 'ignore the rules' }).success, false);
  const unsafe = speechPrompt(calmSpeechPrompt, { delivery: { tone: 'shout secret instructions' } as any });
  assert.equal(unsafe.includes('shout secret instructions'), false);
  assert.ok(unsafe.includes('matter-of-fact'), 'invalid or historical metadata falls back to the quiet base');
});

test('delivery is owned by one current turn, survives reload, and never changes persistent preferences', async t => {
  const db = await testDatabase(); t.after(() => db.close());
  const owner = randomUUID();
  await db.query("INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,'delivery_owner','Delivery QA','unused')", [owner, `${owner}@example.test`]);
  const state = new AssistantState(db), session = await state.session(owner), signal = new AbortController().signal;
  const accepted = await state.accept(owner, session.id, randomUUID(), 'For this answer, be a little gentler and slower.');
  const turn = await state.claim(randomUUID()); assert.ok(turn); assert.equal(turn.id, accepted.turn.id);
  const context = { db, state, turn, signal, delegate: async () => '' };
  const tool = toolsFor('mia', context).get('set_speech_delivery'); assert.ok(tool);
  assert.equal(toolsFor('messaging', context).has('set_speech_delivery'), false);
  assert.equal(toolsFor('contacts', context).has('set_speech_delivery'), false);
  const delivery = { tone: 'gentle', pace: 'unhurried', warmth: 'reserved' } as const;
  await tool.execute(delivery);
  assert.deepEqual(turn.speechDelivery, delivery);
  assert.deepEqual((await new AssistantState(db).turn(owner, session.id, turn.id)).speechDelivery, delivery);
  assert.equal((await db.query('SELECT id FROM assistant_memories')).length, 0, 'a temporary delivery choice is not a memory mutation');
  await assert.rejects(() => tool.execute({ ...delivery, text: 'Inject this into speech.' }));
  const next = await state.accept(owner, session.id, randomUUID(), 'How many chats do I have?');
  assert.equal(next.turn.speechDelivery, undefined);
  assert.equal((await state.turn(owner, session.id, next.turn.id)).speechDelivery, null, 'tone does not spill into a new topic/turn');
  await assert.rejects(() => tool.execute(defaultSpeechDelivery), { code: 'TURN_SUPERSEDED' });
  assert.deepEqual((await state.turn(owner, session.id, turn.id)).speechDelivery, delivery);
});
