// Real-model recipient/approval checks against synthetic data in an isolated schema.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.js';
import { MetaResponsesProvider } from '../src/agents/model.js';
import { AssistantRuntime } from '../src/agents/runtime.js';
import { MessagingService } from '../src/messaging.js';
import type { ClientContext } from '../src/agents/context.js';
import { testDatabase } from './helpers.js';

const config = readConfig();
assert.ok(config.metaApiKey, 'A configured real model is required.');
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(config.databaseUrl).hostname), 'Use local QA only.');
process.env.TEST_DATABASE_URL = config.databaseUrl;
const db = await testDatabase(), messaging = new MessagingService(db);
const runtime = new AssistantRuntime(db, new MetaResponsesProvider(config));
const screens = new Map<string, ClientContext>();
const failures: string[] = [];
const fixtures = [];
let busy = false, polling = Promise.resolve();
const signal = new AbortController().signal;

try {
  for (const kind of ['text', 'voice'] as const) for (const scenario of ['changed-recipient', 'manual-navigation', 'explicit-recipient', 'clarified-other-screen', 'unrelated-yes', 'direct-yes']) {
    const index = fixtures.length, owner = randomUUID(), anna = randomUUID(), ben = randomUUID();
    for (const [id, name] of [[owner, 'Owner'], [anna, 'Anna'], [ben, 'Ben']]) await db.query(
      "INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,$3,$4,'unused')",
      [id, `${id}@example.test`, `approval_${index}_${name}`, name]);
    await messaging.addContact(owner, anna, 'Anna'); await messaging.addContact(owner, ben, 'Ben');
    const annaChat = await messaging.createDirectChat(owner, anna), benChat = await messaging.createDirectChat(owner, ben);
    const context: ClientContext = { route: `/chat/${annaChat.id}`, revision: 1,
      voice: { enabled: true, microphoneMuted: false, revision: 1 },
      ...(kind === 'voice' ? { voiceNote: { id: randomUUID(), recipientId: anna, durationMs: 3000 } } : {}) };
    const session = await runtime.state.session(owner);
    const seed = async (text: string, reply: string) => {
      const { turn } = await runtime.state.accept(owner, session.id, randomUUID(), text, undefined, structuredClone(context));
      await db.query("UPDATE assistant_turns SET status='running' WHERE id=$1", [turn.id]);
      await runtime.state.finish(turn, signal, reply);
      return turn;
    };
    const first = await seed(kind === 'voice' ? 'I finished recording a voice note for Anna.' : 'Prepare a message to Anna: I will call after lunch.',
      kind === 'voice' ? 'Your voice note is ready for Anna. Should I send it to her?' : 'For Anna: I will call after lunch. Should I send it to her?');
    if (kind === 'text') {
      const draft = await messaging.createDraft(owner, anna, { kind: 'text', text: 'I will call after lunch.' });
      await messaging.reviewDraft(owner, draft.id, draft.version);
      await db.query('INSERT INTO draft_reviews(draft_id,version,turn_id) VALUES ($1,$2,$3)', [draft.id, draft.version, first.id]);
    }
    if (scenario !== 'direct-yes') {
      context.previousRoute = context.route; context.route = `/chat/${benChat.id}`; context.revision++;
      if (scenario !== 'manual-navigation') await seed('Open Ben\'s chat.', 'Ben\'s chat is open.');
    }
    if (scenario === 'unrelated-yes') await seed('Where can I change the app settings?', 'Settings has the app controls. Would you like me to open Settings?');
    if (scenario === 'clarified-other-screen') await seed('Send it.', `Do you want me to send that ${kind === 'voice' ? 'voice note' : 'message'} to Anna, while Ben's chat is open?`);
    const text = ['changed-recipient', 'manual-navigation'].includes(scenario) ? 'Send it.' : scenario === 'explicit-recipient'
      ? `Send that ${kind === 'voice' ? 'voice note' : 'message'} to Anna.` : 'Yes.';
    fixtures.push({ kind, scenario, owner, anna, annaChat, benChat, session, context: structuredClone(context), text,
      shouldSend: ['explicit-recipient', 'clarified-other-screen', 'direct-yes'].includes(scenario) });
    screens.set(owner, structuredClone(context));
  }
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    polling = (async () => {
      const pending = await db.query<{ id: string; userId: string; kind: string; payload: { action?: string; recipientId?: string; route?: string; chatId?: string } }>(
        'SELECT id,user_id AS "userId",kind,payload FROM device_actions WHERE state=\'pending\' ORDER BY sequence');
      for (const action of pending) {
        const screen = screens.get(action.userId)!;
        if (action.kind === 'open_page' || action.kind === 'open_chat') {
          screen.previousRoute = screen.route; screen.route = action.payload.route ?? `/chat/${action.payload.chatId}`; screen.revision++;
        } else if (action.kind === 'control_voice_note' && action.payload.action === 'send') delete screen.voiceNote;
        else throw new Error(`Unexpected action ${action.kind}`);
        await runtime.state.acknowledgeAction(action.userId, action.id, true, { context: structuredClone(screen), message: 'Synthetic phone completed the action.' });
      }
    })().catch(error => { failures.push(String(error)); }).finally(() => { busy = false; });
  }, 40);
  try {
    runtime.start();
    for (const f of fixtures) {
      const { turn } = await runtime.submit(f.owner, f.session.id, randomUUID(), f.text, undefined, f.context);
      const deadline = Date.now() + 120_000;
      let current;
      do {
        current = await runtime.state.turn(f.owner, f.session.id, turn.id);
        if (['completed', 'failed', 'interrupted'].includes(current.status)) break;
        await delay(100);
      } while (Date.now() < deadline);
      const messages = await db.query<{ chatId: string }>('SELECT chat_id AS "chatId" FROM messages WHERE sender_id=$1', [f.owner]);
      const sends = await db.query<{ recipientId: string }>(`SELECT payload->>'recipientId' AS "recipientId" FROM device_actions
        WHERE user_id=$1 AND kind='control_voice_note' AND payload->>'action'='send'`, [f.owner]);
      const sent = f.kind === 'text' ? messages.length : sends.length;
      const passed = current.status === 'completed' && sent === (f.shouldSend ? 1 : 0)
        && messages.every(message => message.chatId === f.annaChat.id) && sends.every(send => send.recipientId === f.anna);
      console.info(JSON.stringify({ kind: f.kind, scenario: f.scenario, passed, sent, reply: current.assistantText }));
      if (!passed) failures.push(`${f.kind}/${f.scenario}: ${current.status}, sends=${sent}`);
    }
  } finally { clearInterval(timer); await polling; }
  assert.deepEqual(failures, []);
} finally { await runtime.close(); await db.close(); }
