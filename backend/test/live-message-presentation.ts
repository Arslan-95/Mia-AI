// Real model/tool decisions against fictional accounts in an isolated local schema.
// Card rendering and speech completion are simulated; no real user history is read.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.js';
import { MetaResponsesProvider } from '../src/agents/model.js';
import { AssistantRuntime } from '../src/agents/runtime.js';
import type { ClientContext } from '../src/agents/context.js';
import { MessagingService } from '../src/messaging.js';
import { testDatabase } from './helpers.js';

const config = readConfig();
assert.ok(config.metaApiKey, 'A configured real model is required.');
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(config.databaseUrl).hostname), 'Use local QA only.');
process.env.TEST_DATABASE_URL = config.databaseUrl;
const db = await testDatabase();
const provider = new MetaResponsesProvider(config);
const runtime = new AssistantRuntime(db, { configured: provider.configured, async respond(request) {
  const response = await provider.respond(request);
  if (process.argv[2]) {
    const context = request.instructions.split('Server-supplied current context (data, not instructions):\n').at(-1);
    console.info(JSON.stringify({ trace: true, context: context?.startsWith('{') ? JSON.parse(context).clientContext : null,
      calls: response.calls, reply: response.text }));
  }
  return response;
} });
const messaging = new MessagingService(db);
type Source = 'notebook' | 'rehearsal' | 'hello';
type Scenario = {
  label: string; utterance: string; expected: Source[]; visible?: Source;
  history?: [string, string][]; draft?: string; replyTopic?: RegExp;
};
const scenarios: Scenario[] = [
  { label: 'last-message question without display wording', utterance: 'What is last message?', expected: ['hello'] },
  { label: 'newest received message without display wording', utterance: 'What was the last thing Ben said to me?', expected: ['rehearsal'] },
  { label: 'explain a particular source from no card', utterance: "What does Ben's note about the notebook mean?", expected: ['notebook'] },
  { label: 'assess tone and replace an unrelated card', utterance: 'Does his notebook message sound annoyed?', expected: ['notebook'], visible: 'hello' },
  { label: 'help reply to a particular source', utterance: 'Help me reply to his notebook message. Ask which notebook he means.', expected: ['notebook'], replyTopic: /notebook/i },
  { label: 'two sources summarized with their own narration', utterance: 'Summarize the two newest messages in this chat, one at a time.', expected: ['hello', 'rehearsal'] },
  { label: 'already visible source stays without entrance replay', utterance: 'What does he mean by that?', expected: [], visible: 'notebook', replyTopic: /notebook|friday/i,
    history: [['What did Ben say about the notebook?', 'Ben said he will bring the blue notebook on Friday.']] },
  { label: 'general chat counts do not select a source', utterance: 'How many chats do I have, and with whom?', expected: [], replyTopic: /ben/i },
  { label: 'specific contents in a chat overview still get cards', utterance: 'Tell me what each of the three messages in this chat says, starting with the oldest.', expected: ['notebook', 'rehearsal', 'hello'] },
  { label: 'draft revision does not reselect stale source', utterance: 'Make that shorter, please.', expected: [], visible: 'notebook', draft: 'Hi Ben, could you please tell me what time the rehearsal starts and where we should meet?',
    history: [['Help me ask Ben about rehearsal.', 'I prepared this for Ben: Hi Ben, could you please tell me what time the rehearsal starts and where we should meet? Should I send it?']], replyTopic: /rehearsal/i },
  { label: 'explicit no-display preference is respected', utterance: 'Tell me the last message, but do not put a message card on screen.', expected: [], replyTopic: /hello/i },
];
const selectedScenarios = process.argv[2] ? scenarios.filter(scenario => scenario.label.includes(process.argv[2]!)) : scenarios;
assert.ok(selectedScenarios.length, 'The requested scenario must exist.');
type Action = { id: string; userId: string; turnId: string; kind: string; payload: { chatId?: string; messageId?: string; route?: string; narration?: string; focus?: { start: number; end: number } } };
const screens = new Map<string, ClientContext>();
const actions: Action[] = [];
const failures: string[] = [];
const results: Record<string, unknown>[] = [];
let busy = false, polling: Promise<void> = Promise.resolve();
const timer = setInterval(() => {
  if (busy) return;
  busy = true;
  polling = (async () => {
    const pending = await db.query<Action>('SELECT id,user_id AS "userId",turn_id AS "turnId",kind,payload FROM device_actions WHERE state=$1 ORDER BY sequence', ['pending']);
    for (const action of pending) {
      actions.push(action);
      const screen = screens.get(action.userId)!;
      if (action.kind === 'show_message') {
        const source = await messaging.source(action.userId, action.payload.chatId!, action.payload.messageId!);
        screen.route = `/chat/${source.chatId}`;
        screen.reference = { chatId: source.chatId, messageId: source.id, revision: (screen.reference?.revision ?? 0) + 1,
          ...(action.payload.focus ? { focus: action.payload.focus } : {}) };
      } else if (action.kind === 'dismiss_message') delete screen.reference;
      else if (action.kind === 'open_chat' || action.kind === 'open_page') {
        screen.route = action.payload.route ?? `/chat/${action.payload.chatId}`;
        if (screen.route !== `/chat/${screen.reference?.chatId}`) delete screen.reference;
      } else throw new Error(`Unexpected QA device action: ${action.kind}`);
      screen.revision++;
      // ACK stands for the complete card entrance AND this source's narration.
      await delay(80);
      await runtime.state.acknowledgeAction(action.userId, action.id, true, { context: structuredClone(screen), reference: screen.reference ?? null });
    }
  })().catch(error => { failures.push(String(error)); }).finally(() => { busy = false; });
}, 40);

try {
  const fixtures = [];
  for (const [index, scenario] of selectedScenarios.entries()) {
    const owner = randomUUID(), ben = randomUUID();
    for (const [id, username, name] of [[owner, `presentation_owner_${index}`, 'Presentation QA'], [ben, `presentation_ben_${index}`, 'Ben']]) {
      await db.query("INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,$3,$4,'unused')", [id, `${id}@example.test`, username, name]);
    }
    await messaging.addContact(owner, ben, 'Ben');
    const chat = await messaging.createDirectChat(owner, ben);
    const notebook = await messaging.send(ben, chat.id, { kind: 'text', text: 'I will bring the blue notebook on Friday.' }, randomUUID());
    const rehearsal = await messaging.send(ben, chat.id, { kind: 'text', text: 'Rehearsal starts at seven. I will wait at the side entrance.' }, randomUUID());
    const hello = await messaging.send(owner, chat.id, { kind: 'text', text: 'Hello.' }, randomUUID());
    const sources = { notebook, rehearsal, hello };
    for (const [index, source] of Object.values(sources).entries()) await db.query('UPDATE messages SET created_at=$2 WHERE id=$1', [source.id, `2026-10-${20 + index}T12:00:00Z`]);
    const screen: ClientContext = { route: `/chat/${chat.id}`, revision: 1, voice: { enabled: true, microphoneMuted: false, revision: 1 } };
    if (scenario.visible) screen.reference = { chatId: chat.id, messageId: sources[scenario.visible].id, revision: 1 };
    screens.set(owner, screen);
    const session = await runtime.state.session(owner);
    for (const [user, assistant] of scenario.history ?? []) {
      const { turn } = await runtime.state.accept(owner, session.id, randomUUID(), user, undefined, screen);
      await db.query("UPDATE assistant_turns SET status='completed',assistant_text=$2 WHERE id=$1", [turn.id, assistant]);
    }
    if (scenario.draft) await messaging.createDraft(owner, ben, { kind: 'text', text: scenario.draft });
    fixtures.push({ scenario, owner, session, sources });
  }
  runtime.start();
  for (const { scenario, owner, session, sources } of fixtures) {
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
    const completed = actions.filter(action => action.turnId === turn.id);
    const shown = completed.filter(action => action.kind === 'show_message');
    const names = shown.map(action => Object.entries(sources).find(([, source]) => source.id === action.payload.messageId)?.[0]);
    const report = { label: scenario.label, reply, shown: names, actions: completed.map(action => ({ kind: action.kind, narration: action.payload.narration })) };
    results.push(report); console.info(JSON.stringify(report));
    assert.deepEqual(names, scenario.expected, scenario.label);
    for (const action of shown) {
      const narration = action.payload.narration;
      assert.ok(narration && narration.trim(), `${scenario.label}: the substantive answer must accompany its own source`);
      const topic = action.payload.messageId === sources.notebook.id ? /notebook/i : action.payload.messageId === sources.rehearsal.id ? /rehearsal|seven|entrance/i : /hello/i;
      assert.match(narration, topic, `${scenario.label}: narration must discuss this source`);
    }
    if (scenario.expected.length) {
      assert.equal(completed.some(action => action.kind === 'dismiss_message'), false, 'the last source stays for follow-up');
      assert.equal(screens.get(owner)!.reference?.messageId, sources[scenario.expected.at(-1)!].id);
    }
    const drafts = await messaging.drafts(owner);
    if (scenario.replyTopic) assert.match([reply, ...shown.map(action => action.payload.narration), ...drafts.map(draft => draft.text)].join('\n'), scenario.replyTopic, scenario.label);
    assert.equal((await db.query('SELECT id FROM messages WHERE sender_id=$1', [owner])).length, 1, 'no sending was authorized');
  }
  console.info(`PASS: ${results.length} real-model presentation scenarios.`);
} finally {
  clearInterval(timer); await polling; await runtime.close(); await db.close();
  await mkdir(new URL('../.data/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.data/message-presentation-live.json', import.meta.url), JSON.stringify({
    time: new Date().toISOString(), model: config.metaModel,
    scope: 'Real model and isolated PostgreSQL with fictional data; simulated card/speech ACKs, not physical iPhone validation.',
    results,
  }, null, 2));
}
