import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AssistantState } from '../src/agents/state.js';
import { toolsFor, type ToolContext } from '../src/agents/tools.js';
import { listEvents } from '../src/events.js';
import { MessagingService } from '../src/messaging.js';
import { testDatabase } from './helpers.js';
import { clientContextSchema, sameContext } from '../src/agents/context.js';
import { AppError } from '../src/errors.js';

test('current contact form context survives request storage, permits older clients, and rejects foreign form ownership', async t => {
  const db = await testDatabase(); t.after(() => db.close());
  const owner = randomUUID(), other = randomUUID();
  for (const [id, name] of [[owner, 'form_owner'], [other, 'form_other']]) await db.query(
    `INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,$3,$3,'unused')`, [id, `${id}@test.local`, name]);
  const state = new AssistantState(db), session = await state.session(owner), foreign = await state.session(other);
  const original = await state.accept(owner, session.id, randomUUID(), 'Rename David.');
  const foreignTurn = await state.accept(other, foreign.id, randomUUID(), 'Save a contact.');
  const screen = { route: '/chats', revision: 0, navigationSessionId: randomUUID() };
  const form = { turnId: original.turn.id, operation: 'rename', name: 'David Demo', identifier: '+12025550102', status: 'editing' };
  const context = clientContextSchema.parse({ ...screen, contactForm: form });
  const next = await state.accept(owner, session.id, randomUUID(), 'Hello Mia.', undefined, context);
  assert.deepEqual((await state.turn(owner, session.id, next.turn.id)).context?.contactForm, context.contactForm);
  assert.equal(sameContext(context, { ...context, contactForm: null }), true, 'form observations do not invalidate same-turn navigation');
  assert.deepEqual(clientContextSchema.parse(screen), screen, 'old clients can omit form context');
  assert.equal(clientContextSchema.parse({ ...screen, contactForm: null }).contactForm, null);
  await assert.rejects(state.accept(owner, session.id, randomUUID(), 'Hello.', undefined,
    clientContextSchema.parse({ ...screen, contactForm: { ...form, turnId: foreignTurn.turn.id } })));
  assert.equal(clientContextSchema.safeParse({ ...screen, contactForm: { ...form, identifier: 'x'.repeat(101) } }).success, false);
});

test('contact forms show partial data, track committed saves, report rejected changes, and fence superseded turns', async t => {
  const db = await testDatabase(); t.after(() => db.close());
  const owner = randomUUID(), person = randomUUID();
  for (const [id, name] of [[owner, 'owner'], [person, 'anna']]) {
    await db.query(`INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,$3,$3,'unused')`, [id, `${id}@test.local`, name]);
  }
  await db.query('UPDATE users SET phone_number=$2 WHERE id=$1', [person, '+12025550101']);
  const state = new AssistantState(db);
  const session = await state.session(owner);
  await state.accept(owner, session.id, randomUUID(), 'Save Anna.');
  const turn = (await state.claim(randomUUID()))!;
  const context: ToolContext = { db, state, turn, signal: new AbortController().signal, delegate: async () => '' };
  const tools = toolsFor('contacts', context);
  const execute = (name: string, args: unknown) => tools.get(name)!.execute(args);
  const forms = async () => (await listEvents(db, owner)).filter(event => event.type === 'agent.contact_form').map(event => event.payload as Record<string, unknown>);
  const messaging = new MessagingService(db);

  await execute('show_contact_form', { operation: 'create', name: 'Anna', identifier: null });
  assert.equal((await messaging.contacts(owner)).length, 0, 'displaying the form never saves a contact');
  await execute('show_contact_form', { operation: 'create', name: 'Anna', identifier: '+1 202 555 0101' });
  const saved = await execute('add_contact', { userId: person, name: 'Anna' }) as { contactId: string };
  assert.deepEqual((await forms()).map(form => form.status), ['editing', 'editing', 'saving', 'saved']);
  assert.equal((await forms()).at(-1)!.identifier, '+12025550101', 'saving preserves the verified phone number');
  assert.equal((await messaging.contacts(owner))[0]!.contactId, saved.contactId);

  await assert.rejects(execute('add_contact', { userId: person, name: 'Wrong replacement' }));
  assert.equal((await forms()).at(-1)!.status, 'failed');
  assert.equal((await messaging.contacts(owner))[0]!.name, 'Anna');
  context.reviewMemory = async () => { throw new Error('Rejected rename'); };
  await assert.rejects(execute('rename_contact', { contactId: saved.contactId, name: 'Rejected' }));
  assert.equal((await forms()).at(-1)!.status, 'failed');
  assert.equal((await messaging.contacts(owner))[0]!.name, 'Anna');
  const beforeClarification = (await forms()).length;
  context.reviewMemory = async () => { throw new AppError(409, 'MEMORY_CHANGE_UNSUPPORTED', 'Which Anna?'); };
  await assert.rejects(execute('rename_contact', { contactId: saved.contactId, name: 'Ambiguous' }),
    (error: unknown) => error instanceof AppError && error.code === 'MEMORY_CHANGE_UNSUPPORTED');
  assert.deepEqual((await forms()).slice(beforeClarification).map(form => form.status), ['clarification'],
    'a request for clarification never shows saving or a technical failure');
  assert.equal((await forms()).at(-1)!.code, 'MEMORY_CHANGE_UNSUPPORTED');
  assert.equal((await messaging.contacts(owner))[0]!.name, 'Anna');
  assert.equal(clientContextSchema.parse({ route: '/chats', revision: 0, contactForm: {
    turnId: turn.id, operation: 'rename', name: 'Ambiguous', identifier: '+12025550101', status: 'clarification',
  } }).contactForm?.status, 'clarification');
  context.reviewMemory = async () => ({ explicit: true });
  await execute('rename_contact', { contactId: saved.contactId, name: 'Studio Anna' });
  assert.equal((await forms()).at(-1)!.operation, 'rename');
  assert.equal((await forms()).at(-1)!.status, 'saved');
  assert.equal((await forms()).at(-1)!.identifier, '+12025550101', 'rename preserves the same phone number');
  assert.equal((await messaging.contact(owner, saved.contactId)).phoneNumber, '+12025550101');
  await assert.rejects(execute('show_contact_form', { operation: 'rename', name: 'Anna', identifier: '@anna' }));
  assert.equal((await messaging.contacts(owner))[0]!.name, 'Studio Anna');

  await execute('dismiss_contact_form', {});
  assert.equal((await forms()).at(-1)!.status, 'dismissed');
  await state.accept(owner, session.id, randomUUID(), 'A different request.');
  const eventCount = (await forms()).length;
  await assert.rejects(execute('show_contact_form', { operation: 'create', name: null, identifier: '+12025550101' }));
  await assert.rejects(execute('add_contact', { userId: person, name: 'Stale name' }));
  assert.equal((await forms()).length, eventCount);
  assert.equal((await messaging.contacts(owner))[0]!.name, 'Studio Anna');
  assert.equal(toolsFor('messaging', context).has('show_contact_form'), false);
});
