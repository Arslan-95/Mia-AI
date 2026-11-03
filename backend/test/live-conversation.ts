// Real-model regression for conversation references. Uses an isolated database
// schema and simulated phone acknowledgements; never reads a real user's turns.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { readConfig } from '../src/config.js';
import { MetaResponsesProvider } from '../src/agents/model.js';
import { AssistantRuntime } from '../src/agents/runtime.js';
import type { ClientContext } from '../src/agents/context.js';
import { MessagingService } from '../src/messaging.js';
import { testDatabase } from './helpers.js';

const config = readConfig();
assert.ok(config.metaApiKey, 'A configured model is required.');
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(config.databaseUrl).hostname), 'Use local QA only.');
process.env.TEST_DATABASE_URL = config.databaseUrl;
const db = await testDatabase();
const runtime = new AssistantRuntime(db, new MetaResponsesProvider(config));
const messaging = new MessagingService(db);
const notebook = 'Hi Ben, just following up - are you still bringing the blue notebook this Friday? Let me know which one you mean. Thanks!';
const sharingan = 'Hi Ben, quick Naruto bit - the Sharingan is the Uchiha clan eye. It lets you see chakra, copy jutsu and cast visual genjutsu.';
const byakugan = 'Hi Ben, another quick Naruto bit - the Byakugan is the Hyuga clan eye and gives almost 360-degree vision.';
type Exchange = [user: string, assistant: string | null];
const discussion: Exchange[] = [
  ['Read my first two messages.', 'Those were your first two. Want the third one too?'],
  ["Maybe we can ask him something; he hasn't answered me.", 'His last message was about bringing the blue notebook on Friday. Want me to prepare a follow-up about the notebook?'],
  ['Yes please.', `I prepared this for Ben: ${notebook} Should I send it?`],
  ['Can you repeat?', `For Ben: ${notebook} Should I send it?`],
  ['No, delete it please.', 'Done, I deleted that draft for Ben.'],
];
const mistaken: Exchange[] = [
  ['Would you please make something like that message', null],
  ['but another one', `I prepared this for Ben: ${byakugan} Should I send it?`],
];
const cases = [
  { label: 'revision after deletion with stale Naruto card', history: discussion, utterance: 'Would you please make something like that message, but another one?', topic: /notebook/i },
  { label: 'split speech continues interrupted request', history: [...discussion, ['Would you please make something like that message', null] as Exchange], utterance: 'but another one', topic: /notebook/i },
  { label: 'correction overrides wrong draft and screen', history: [...discussion, ...mistaken], utterance: 'No, I thought about that question, not the last message.', topic: /notebook/i, wrongDraft: true },
  { label: 'actual final clarification recovers notebook', history: [...discussion, ...mistaken,
    ['The bike', 'What do you want to tell Ben about the bike?'] as Exchange,
    ['No I thought about that question not last message', 'Which bike question do you mean?'] as Exchange,
    ['Yeah I mean I mean not notebook I mean I mean notebook', null] as Exchange],
  utterance: "with we was talking about I was talking about that what we can answer a new made something but I didn't like it and I asked you make something like this but something else", topic: /notebook/i, wrongDraft: true },
  { label: 'explicit screen reference can deliberately change topic', history: discussion,
    utterance: 'Actually use the Sharingan message still on screen as the example. Draft a different short Naruto fact for Ben instead of the notebook question.', topic: /naruto|byakugan|rasengan|sharingan|chakra|jutsu/i, anime: true },
  { label: 'new task can replace notebook discussion', history: discussion,
    utterance: 'Forget that question. Instead ask Ben what time rehearsal starts.', topic: /rehearsal/i },
  { label: 'repeat includes earlier spoken narration', history: [discussion[0]!],
    utterance: 'Repeat the first message you just read to me, about the notebook.', topic: /notebook/i, repeat: true },
];
const screens = new Map<string, ClientContext>();
const results: Record<string, unknown>[] = [];
const failures: string[] = [];
let busy = false, polling: Promise<void> = Promise.resolve();
const timer = setInterval(() => {
  if (busy) return;
  busy = true;
  polling = (async () => {
    const pending = await db.query<{ id: string; userId: string; kind: string; payload: { chatId?: string; messageId?: string; route?: string } }>(
      "SELECT id,user_id AS \"userId\",kind,payload FROM device_actions WHERE state='pending' ORDER BY sequence");
    for (const action of pending) {
      const screen = screens.get(action.userId)!;
      if (action.kind === 'dismiss_message') delete screen.reference;
      else if (action.kind === 'show_message') {
        screen.route = `/chat/${action.payload.chatId}`;
        screen.reference = { chatId: action.payload.chatId!, messageId: action.payload.messageId!, revision: (screen.reference?.revision ?? 0) + 1 };
      } else if (action.kind === 'open_chat' || action.kind === 'open_page') {
        screen.route = action.payload.route ?? `/chat/${action.payload.chatId}`;
        if (screen.route !== `/chat/${screen.reference?.chatId}`) delete screen.reference;
      } else throw new Error(`Unexpected device action: ${action.kind}`);
      screen.revision++;
      await runtime.state.acknowledgeAction(action.userId, action.id, true,
        { context: structuredClone(screen), reference: screen.reference ?? null });
    }
  })().catch(error => { failures.push(String(error)); }).finally(() => { busy = false; });
}, 40);

try {
  const fixtures = [];
  for (const [index, scenario] of cases.entries()) {
    const owner = randomUUID(), ben = randomUUID();
    for (const [id, name] of [[owner, `conversation_owner_${index}`], [ben, `conversation_ben_${index}`]]) await db.query(
      "INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,$3,$4,'unused')", [id, `${id}@example.test`, name, id === ben ? 'Ben Demo' : 'Conversation QA']);
    await messaging.addContact(owner, ben, 'Ben Demo');
    const chat = await messaging.createDirectChat(owner, ben);
    await messaging.send(ben, chat.id, { kind: 'text', text: 'I will bring the blue notebook this Friday.' }, randomUUID());
    const first = await messaging.send(owner, chat.id, { kind: 'text', text: 'Hi Ben, which blue notebook and which Friday do you mean? Please clarify.' }, randomUUID());
    const source = await messaging.send(owner, chat.id, { kind: 'text', text: sharingan }, randomUUID());
    const screen: ClientContext = { route: `/chat/${chat.id}`, revision: 3,
      reference: { chatId: chat.id, messageId: source.id, revision: 17 },
      voice: { enabled: true, microphoneMuted: false, revision: 6 } };
    screens.set(owner, screen);
    const session = await runtime.state.session(owner);
    for (const [position, [text, reply]] of scenario.history.entries()) {
      const { turn } = await runtime.state.accept(owner, session.id, randomUUID(), text, undefined, screen);
      await db.query('UPDATE assistant_turns SET status=$2,assistant_text=$3 WHERE id=$1', [turn.id, reply ? 'completed' : 'interrupted', reply]);
      if (position === 0) for (const message of [first, source]) await db.query(`INSERT INTO device_actions
        (id,user_id,session_id,turn_id,generation,kind,payload,state,expires_at)
        VALUES ($1,$2,$3,$4,$5,'show_message',$6::jsonb,'completed',now())`,
      [randomUUID(), owner, session.id, turn.id, turn.generation, JSON.stringify({ chatId: chat.id, messageId: message.id, narration: message.text })]);
    }
    const discarded = await messaging.createDraft(owner, ben, { kind: 'text', text: notebook });
    await messaging.discardDraft(owner, discarded.id, discarded.version);
    if ('wrongDraft' in scenario && scenario.wrongDraft) await messaging.createDraft(owner, ben, { kind: 'text', text: byakugan });
    fixtures.push({ scenario, owner, session });
  }
  runtime.start();
  for (const { scenario, owner, session } of fixtures) {
    const before = await db.query<{ id: string; version: number }>('SELECT id,version FROM message_drafts WHERE owner_id=$1', [owner]);
    const { turn } = await runtime.submit(owner, session.id, randomUUID(), scenario.utterance, undefined, structuredClone(screens.get(owner)!));
    const deadline = Date.now() + 180000;
    let reply: string | null = null;
    while (Date.now() < deadline) {
      assert.deepEqual(failures, []);
      const current = await runtime.state.turn(owner, session.id, turn.id);
      assert.notEqual(current.status, 'failed', `${scenario.label}: ${JSON.stringify(current)}`);
      if (current.status === 'completed') { reply = current.assistantText; break; }
      await delay(100);
    }
    assert.ok(reply, `Timed out: ${scenario.label}`);
    const drafts = await db.query<{ id: string; version: number; text: string }>("SELECT id,version,text FROM message_drafts WHERE owner_id=$1 AND state IN ('editing','ready')", [owner]);
    const changed = drafts.filter(draft => !before.some(old => old.id === draft.id && old.version === draft.version));
    const narrations = await db.query<{ text: string }>("SELECT payload->>'narration' AS text FROM device_actions WHERE turn_id=$1 AND state='completed' AND payload->>'narration' IS NOT NULL ORDER BY sequence", [turn.id]);
    const spoken = [...narrations.map(item => item.text), reply].join('\n');
    assert.match(spoken + '\n' + changed.map(draft => draft.text).join('\n'), scenario.topic, scenario.label);
    if (!('anime' in scenario && scenario.anime)) {
      for (const draft of changed) assert.doesNotMatch(draft.text, /naruto|byakugan|sharingan|chakra|jutsu/i, scenario.label);
    }
    if ('repeat' in scenario && scenario.repeat) assert.match(spoken, /which blue notebook and which Friday/i);
    assert.equal((await db.query('SELECT id FROM messages WHERE sender_id=$1', [owner])).length, 2, 'no sending was authorized');
    const result = { label: scenario.label, reply, newOrRevisedDrafts: changed.map(draft => draft.text), narrations: narrations.map(item => item.text) };
    results.push(result); console.info(JSON.stringify(result));
  }
  await mkdir(new URL('../.data/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.data/conversation-live.json', import.meta.url), JSON.stringify({
    time: new Date().toISOString(), scope: 'Real model and isolated PostgreSQL. Simulated phone ACKs; no physical audio verification.', results,
  }, null, 2));
  console.info(`PASS: ${results.length} real-model conversation regressions.`);
} finally { clearInterval(timer); await polling; await runtime.close(); await db.close(); }
