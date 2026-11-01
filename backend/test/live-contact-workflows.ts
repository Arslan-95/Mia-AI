// Real configured model and isolated fictional PostgreSQL users. Phone ACKs
// are simulated. No real contacts, chats or outgoing messages are changed.
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

const config = readConfig(); assert.ok(config.metaApiKey);
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(config.databaseUrl).hostname));
process.env.TEST_DATABASE_URL = config.databaseUrl;
const db = await testDatabase(), runtime = new AssistantRuntime(db, new MetaResponsesProvider(config));
const messaging = new MessagingService(db), screens = new Map<string, ClientContext>();
const results: { scenario: string; passed: boolean; reply: string | null; actions: string[]; issues: string[] }[] = [];
const failures: string[] = [];
let busy = false, polling = Promise.resolve();
const timer = setInterval(() => {
  if (busy) return; busy = true;
  polling = (async () => {
    const pending = await db.query<{ id: string; userId: string; kind: string; payload: { chatId?: string; route?: string } }>(
      "SELECT id,user_id AS \"userId\",kind,payload FROM device_actions WHERE state='pending' ORDER BY sequence");
    for (const action of pending) {
      const screen = screens.get(action.userId)!;
      assert.ok(['open_chat', 'open_page'].includes(action.kind), `Unexpected phone action ${action.kind}`);
      const next = action.payload.route ?? `/chat/${action.payload.chatId}`;
      if (next !== screen.route) { screen.previousRoute = screen.route; screen.route = next; screen.revision++; delete screen.reference; }
      await runtime.state.acknowledgeAction(action.userId, action.id, true, { context: structuredClone(screen), message: 'Synthetic phone completed navigation.' });
    }
  })().catch(error => { failures.push(String(error)); }).finally(() => { busy = false; });
}, 40);

type Scenario = { name: string; request: string; saved?: boolean; existingChat?: boolean; inChat?: boolean; ambiguous?: boolean;
  open?: boolean; compose?: boolean; label?: string; followUp?: string; phone?: boolean; approve?: boolean };
const scenarios: Scenario[] = [
  { name: 'actual-request-from-home', request: "So I'd like to send message to Ben Demo", saved: true, existingChat: true, open: true },
  { name: 'new-chat-with-supplied-content', request: "Could you let Ben Demo know I'll be ten minutes late?", saved: true, open: true, compose: true },
  { name: 'registered-unsaved-person', request: "Tell PHONE I'll be ten minutes late.", open: true, compose: true },
  { name: 'already-in-target-chat', request: 'I want to send Ben Demo a message.', saved: true, existingChat: true, inChat: true },
  { name: 'recipient-survives-content-followup', request: 'I need to say something to Ben Demo.', saved: true, open: true, followUp: "Tell him I'll be ten minutes late.", compose: true },
  { name: 'ambiguous-person', request: "Tell Ben Demo I'll be ten minutes late.", saved: true, ambiguous: true },
  { name: 'save-by-number', request: 'Please keep PHONE in my contacts as Studio Ben.', label: 'Studio Ben' },
  { name: 'rename-saved-contact', request: "Could you change Ben Demo's saved contact name to Rehearsal Ben?", saved: true, label: 'Rehearsal Ben' },
  { name: 'rename-person-in-current-chat', request: "I'd rather call this contact Studio.", saved: true, existingChat: true, inChat: true, label: 'Studio' },
  { name: 'ambiguous-rename', request: 'Rename Ben Demo to Work.', saved: true, ambiguous: true },
  { name: 'save-by-full-phone', request: 'Save the person at +1 202 555 0101 as Venue.', phone: true, label: 'Venue' },
  { name: 'unknown-person-needs-identity', request: 'Save someone named Priya in my contacts.' },
  { name: 'hypothetical-is-not-navigation', request: "If I wanted to tell Ben Demo I'm late, would you open his chat? Just explain the process; don't do anything.", saved: true },
  { name: 'save-and-compose', request: "Save PHONE as Studio Ben and tell him I'll be ten minutes late.", label: 'Studio Ben', open: true, compose: true },
  { name: 'approve-after-inferred-open', request: "Tell Ben Demo I'll be ten minutes late.", saved: true, open: true, compose: true, followUp: 'Yes, send it.', approve: true },
  { name: 'contact-lookup-only', request: 'Is Ben Demo in my saved contacts?', saved: true },
];
try {
  const fixtures = [];
  for (const [index, scenario] of scenarios.filter(item => !process.argv.includes('--approval-only') || item.approve).entries()) {
    const owner = randomUUID(), target = randomUUID(), other = randomUUID(), phoneNumber = `+1202555${String(index * 3 + 101).padStart(4, '0')}`;
    for (const [id, number, name] of [[owner, `+1202555${String(index * 3 + 100).padStart(4, '0')}`, 'Owner'], [target, phoneNumber, 'Ben Demo'], [other, `+1202555${String(index * 3 + 102).padStart(4, '0')}`, 'Ben Demo']]) await db.query(
      "INSERT INTO users(id,phone_number,display_name,profile_complete) VALUES ($1,$2,$3,true)", [id, number, name]);
    if (scenario.saved) await messaging.addContact(owner, target, 'Ben Demo');
    if (scenario.ambiguous) await messaging.addContact(owner, other, 'Ben Demo');
    const initial = await messaging.contacts(owner);
    const chat = scenario.existingChat ? await messaging.createDirectChat(owner, target) : null;
    const context: ClientContext = { route: scenario.inChat ? `/chat/${chat!.id}` : '/mia', revision: 1, navigationSessionId: randomUUID() };
    screens.set(owner, context);
    fixtures.push({ scenario, owner, target, phoneNumber, initial, context, session: await runtime.state.session(owner) });
  }
  runtime.start();
  for (const f of fixtures) {
    const issues: string[] = [], turns = [];
    const run = async (text: string) => {
      const { turn } = await runtime.submit(f.owner, f.session.id, randomUUID(), text, undefined, structuredClone(f.context));
      const deadline = Date.now() + 120000;
      let current;
      do { current = await runtime.state.turn(f.owner, f.session.id, turn.id); if (!['queued', 'running'].includes(current.status)) break; await delay(100); } while (Date.now() < deadline);
      if (current.status !== 'completed') issues.push(`turn ${current.status}`);
      turns.push(current); return current;
    };
    let current = await run(f.scenario.request.replaceAll('PHONE', f.phoneNumber).replace('+1 202 555 0101', f.phoneNumber));
    if (f.scenario.followUp) current = await run(f.scenario.followUp);
    const contacts = await messaging.contacts(f.owner), drafts = await messaging.drafts(f.owner), chats = await messaging.chats(f.owner);
    const actions = await db.query<{ kind: string; state: string; payload: { chatId?: string } }>('SELECT kind,state,payload FROM device_actions WHERE user_id=$1 ORDER BY sequence', [f.owner]);
    const open = actions.filter(action => action.kind === 'open_chat');
    if (open.length !== (f.scenario.open ? 1 : 0) || open.some(action => action.state !== 'completed')) issues.push(`open_chat count/state ${open.length}`);
    if (f.scenario.open || f.scenario.inChat) {
      const targetChat = chats.find(chat => chat.recipient.id === f.target);
      if (!targetChat || f.context.route !== `/chat/${targetChat.id}`) issues.push('wrong visible recipient');
      if (open.some(action => action.payload.chatId !== targetChat?.id)) issues.push('opened wrong chat');
      if (chats.filter(chat => chat.recipient.id === f.target).length !== 1) issues.push('duplicate direct chat');
    } else if (!f.scenario.existingChat && chats.length) issues.push('unexpected chat creation');
    if (drafts.length !== (f.scenario.compose && !f.scenario.approve ? 1 : 0)) issues.push(`draft count ${drafts.length}`);
    if (drafts.some(draft => draft.recipientId !== f.target || draft.state !== 'ready' || !/ten|10/.test(draft.text ?? '') || !/late/i.test(draft.text ?? ''))) issues.push('wrong/unreviewed composed content');
    const sent = await db.query<{chatId: string; text: string}>('SELECT chat_id AS "chatId",text FROM messages WHERE sender_id=$1', [f.owner]);
    if (sent.length !== (f.scenario.approve ? 1 : 0)) issues.push(`sent message count ${sent.length}`);
    if (sent.some(message => message.chatId !== chats.find(chat => chat.recipient.id === f.target)?.id || !/late|behind/i.test(message.text))) issues.push('sent wrong content or recipient');
    const expectedContacts = f.initial.length + (f.scenario.label && !f.scenario.saved ? 1 : 0);
    if (contacts.length !== expectedContacts) issues.push(`contact count ${contacts.length}`);
    if (f.scenario.label && contacts.find(contact => contact.id === f.target)?.name !== f.scenario.label) issues.push('requested contact label missing');
    for (const initial of f.initial) {
      const actual = contacts.find(contact => contact.contactId === initial.contactId);
      if (!actual || actual.id !== initial.id || actual.name !== (initial.id === f.target && f.scenario.label ? f.scenario.label : initial.name)) issues.push('unrelated or wrong contact changed');
    }
    const profile = await messaging.profile(f.target);
    if (profile.phoneNumber !== f.phoneNumber || profile.displayName !== 'Ben Demo') issues.push('account profile changed');
    const result = { scenario: f.scenario.name, passed: issues.length === 0, reply: current.assistantText, actions: actions.map(action => action.kind), issues };
    results.push(result); console.info(JSON.stringify(result));
  }
  await writeFile(process.argv.includes('--approval-only') ? '.data/contact-approval-live.json' : '.data/contact-workflows-live.json', JSON.stringify({ observedAt: new Date().toISOString(), scope: 'Real configured model and isolated fictional PostgreSQL users; simulated phone navigation.', results, failures }, null, 2));
  assert.deepEqual(failures, []); assert.ok(results.every(result => result.passed), 'Inspect .data/contact-workflows-live.json');
} finally { clearInterval(timer); await polling; await runtime.close(); await db.close(); }
