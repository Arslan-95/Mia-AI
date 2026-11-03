// Real model, isolated PostgreSQL schema, fictional contacts. No production mutations.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { readConfig } from '../src/config.js';
import { MetaResponsesProvider } from '../src/agents/model.js';
import { AssistantRuntime } from '../src/agents/runtime.js';
import type { ClientContext } from '../src/agents/context.js';
import { MessagingService } from '../src/messaging.js';
import { testDatabase } from './helpers.js';

const config = readConfig();
assert.ok(config.metaApiKey);
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(config.databaseUrl).hostname));
process.env.TEST_DATABASE_URL = config.databaseUrl;
const db = await testDatabase(), runtime = new AssistantRuntime(db, new MetaResponsesProvider(config));
try {
  const owner = randomUUID(), demo = randomUUID(), miller = randomUUID();
  for (const [id, name, phone] of [[owner, 'Owner', '+12025550999'], [demo, 'Anna Demo', '+12025550101'], [miller, 'Anna Miller', '+12025550109']]) {
    await db.query(`INSERT INTO users(id,email,username,display_name,password_hash,phone_number)
      VALUES ($1,$2,$5,$3,'unused',$4)`, [id, `${id}@test.local`, name, phone, id]);
  }
  const messaging = new MessagingService(db), session = await runtime.state.session(owner);
  const selected = await messaging.addContact(owner, demo, 'Anna');
  const other = await messaging.addContact(owner, miller, 'Anna');
  const screen: ClientContext = { route: '/chats', revision: 3, navigationSessionId: randomUUID(), contactForm: null };
  async function history(text: string, reply: string | null) {
    const { turn } = await runtime.state.accept(owner, session.id, randomUUID(), text, undefined, screen);
    await db.query('UPDATE assistant_turns SET status=$2,assistant_text=$3,completed_at=now() WHERE id=$1',
      [turn.id, reply ? 'completed' : 'interrupted', reply]);
    return turn;
  }
  await history('Why I have two contacts as Anna?',
    "You have two different people both saved as Anna. One is Anna Miller on +1 202 555 0109, and the other is Anna Demo on +1 202 555 0101. Want me to rename one?");
  await history("Could you please delete in a demo's contact?",
    "I can't delete contacts for you. I can rename Anna Demo to something clearer.");
  const interrupted = await history('Anna Dimo, so could you please rename it as Anna Dimo,', null);
  await db.query(`INSERT INTO device_actions(id,user_id,session_id,turn_id,generation,kind,payload,state,expires_at)
    VALUES ($1,$2,$3,$4,$5,'speak_progress',$6,'completed',now())`, [randomUUID(), owner, session.id, interrupted.id,
    interrupted.generation, JSON.stringify({ narration: "I'll find your Anna contacts to rename the right one." })]);
  screen.contactForm = { turnId: interrupted.id, operation: 'rename', name: 'Anna Dimo', identifier: '+12025550101', status: 'interrupted' };
  await runtime.start();
  const { turn } = await runtime.submit(owner, session.id, randomUUID(), 'Can you please rename', undefined, screen);
  const deadline = Date.now() + 120000;
  let current;
  while (Date.now() < deadline) {
    current = await runtime.state.turn(owner, session.id, turn.id);
    if (current.status === 'completed' || current.status === 'failed') break;
    await delay(100);
  }
  const events = await db.query<{ type: string; payload: Record<string, unknown> }>(
    "SELECT type,payload FROM events WHERE user_id=$1 AND payload->>'turnId'=$2 ORDER BY id", [owner, turn.id]);
  const result = { scope: 'Real model; isolated fictional contacts; interrupted request replay',
    observedAt: new Date().toISOString(), turnStatus: current?.status, reply: current?.assistantText,
    selectedName: (await messaging.contact(owner, selected.contactId)).name,
    otherName: (await messaging.contact(owner, other.contactId)).name,
    forms: events.filter(e => e.type === 'agent.contact_form').map(e => e.payload.status),
    reviews: events.filter(e => e.type === 'agent.change_reviewed').map(e => e.payload),
  };
  await writeFile('.data/contact-rename-live.json', JSON.stringify(result, null, 2));
  console.info(JSON.stringify(result));
  assert.equal(current?.status, 'completed');
  assert.equal(result.selectedName, 'Anna Dimo', 'the interrupted request must resume without another confirmation');
  assert.equal(result.otherName, 'Anna', 'the other Anna must remain unchanged');
  assert.ok(result.forms.includes('saved'));
  assert.ok(!result.forms.includes('failed') && !result.forms.includes('clarification'));
  assert.ok(result.reviews.some(review => review.action === 'rename_contact' && review.allowed === true));
} finally { await runtime.close(); await db.close(); }
