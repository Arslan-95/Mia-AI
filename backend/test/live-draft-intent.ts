// Real configured model, isolated fictional users. Never sends to real users.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.js';
import { MetaResponsesProvider } from '../src/agents/model.js';
import { AssistantRuntime } from '../src/agents/runtime.js';
import { MessagingService } from '../src/messaging.js';
import type { ClientContext } from '../src/agents/context.js';
import { testDatabase } from './helpers.js';

const config = readConfig();
assert.ok(config.metaApiKey);
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(config.databaseUrl).hostname));
process.env.TEST_DATABASE_URL = config.databaseUrl;
const db = await testDatabase(), runtime = new AssistantRuntime(db, new MetaResponsesProvider(config)), messaging = new MessagingService(db);
const results = [];
const scenarios = [
  { name: 'fresh-immediate-approval', text: 'Yes, send it.', send: true },
  { name: 'actual-old-draft-after-open', text: 'So send a message, please.', old: true, opened: true, send: false },
  { name: 'old-draft-same-screen', text: 'Send a message, please.', old: true, send: false },
  { name: 'leave-and-return-same-chat', text: 'Send it.', reentered: true, send: false },
  { name: 'app-restarted', text: 'Send it.', restarted: true, send: false },
  { name: 'recipient-without-content', text: 'Send a message to Ben.', old: true, send: false },
  { name: 'unrelated-later-yes', text: 'Yes.', unrelated: true, send: false },
  { name: 'explicit-saved-draft', text: 'Send the saved blue notebook draft to Ben.', old: true, reentered: true, send: true },
  { name: 'natural-reference-back', text: 'Remember that note we worked on about the blue notebook? Go ahead and send that one to Ben.', old: true, restarted: true, send: true },
  { name: 'asks-about-drafts', text: 'Do I have a saved draft for Ben?', old: true, send: false, mentionsDraft: true },
];
try {
  const fixtures = [];
  for (const [index, scenario] of scenarios.entries()) {
    const owner = randomUUID(), ben = randomUUID();
    for (const [id, name] of [[owner, 'Owner'], [ben, 'Ben']]) await db.query(
      "INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,$3,$4,'unused')",
      [id, `${id}@example.test`, `draft_intent_${index}_${name}`, name]);
    await messaging.addContact(owner, ben, 'Ben');
    const chat = await messaging.createDirectChat(owner, ben), session = await runtime.state.session(owner);
    const context: ClientContext = { route: `/chat/${chat.id}`, revision: 2, navigationSessionId: randomUUID(), previousRoute: '/mia' };
    const seed = async (text: string, reply: string) => {
      const { turn } = await runtime.state.accept(owner, session.id, randomUUID(), text, undefined, structuredClone(context));
      await db.query("UPDATE assistant_turns SET status='completed',assistant_text=$2 WHERE id=$1", [turn.id, reply]);
      return turn;
    };
    const reviewed = await seed('Prepare a message to Ben asking him to bring the blue notebook tomorrow.', 'For Ben: Please bring the blue notebook tomorrow. Should I send it?');
    const draft = await messaging.createDraft(owner, ben, { kind: 'text', text: 'Please bring the blue notebook tomorrow.' });
    await messaging.reviewDraft(owner, draft.id, draft.version);
    await db.query('INSERT INTO draft_reviews(draft_id,version,turn_id) VALUES ($1,$2,$3)', [draft.id, draft.version, reviewed.id]);
    if (scenario.old) await db.query("UPDATE assistant_turns SET created_at=now()-interval '27 hours' WHERE id=$1", [reviewed.id]);
    if (scenario.reentered) { context.revision += 2; context.previousRoute = '/settings'; }
    if (scenario.restarted) context.navigationSessionId = randomUUID();
    if (scenario.opened) { context.route = '/mia'; context.revision++; await seed('Open chat with Ben, please.', "Ben's chat is open now."); context.route = `/chat/${chat.id}`; context.revision++; context.previousRoute = '/mia'; }
    if (scenario.unrelated) await seed('Can you help me choose a greeting?', 'Would you like some examples of friendly greetings?');
    fixtures.push({ scenario, owner, chat, session, context });
  }
  runtime.start();
  for (const f of fixtures) {
    const { turn } = await runtime.submit(f.owner, f.session.id, randomUUID(), f.scenario.text, undefined, f.context);
    let current;
    const deadline = Date.now() + 120000;
    do { current = await runtime.state.turn(f.owner, f.session.id, turn.id); if (!['queued', 'running'].includes(current.status)) break; await delay(100); } while (Date.now() < deadline);
    const messages = await db.query<{ chatId: string; text: string }>('SELECT chat_id AS "chatId",text FROM messages WHERE sender_id=$1', [f.owner]);
    const unexpectedDraftOffer = !f.scenario.send && !f.scenario.mentionsDraft && /draft|saved|notebook|previous message|earlier message/i.test(current.assistantText ?? '');
    const passed = current.status === 'completed' && messages.length === (f.scenario.send ? 1 : 0) && !unexpectedDraftOffer
      && messages.every(message => message.chatId === f.chat.id && message.text === 'Please bring the blue notebook tomorrow.');
    const result = { scenario: f.scenario.name, passed, sent: messages.length, status: current.status, reply: current.assistantText };
    results.push(result); console.info(JSON.stringify(result));
  }
  await writeFile('.data/draft-intent-live.json', JSON.stringify({ observedAt: new Date().toISOString(), scope: 'Real model and isolated fictional PostgreSQL users; no real sends.', results }, null, 2));
  assert.ok(results.every(result => result.passed), 'Draft intent scenarios failed; inspect .data/draft-intent-live.json');
} finally { await runtime.close(); await db.close(); }
