// Real model, isolated fictional users, simulated phone acknowledgements.
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
assert.ok(config.metaApiKey);
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(config.databaseUrl).hostname));
process.env.TEST_DATABASE_URL = config.databaseUrl;
const db = await testDatabase(), runtime = new AssistantRuntime(db, new MetaResponsesProvider(config));
const messaging = new MessagingService(db), screens = new Map<string, ClientContext>();
const fixtures = [], failures: string[] = [];
let busy = false, polling = Promise.resolve();
const timer = setInterval(() => {
  if (busy) return; busy = true;
  polling = (async () => {
    const actions = await db.query<{ id: string; userId: string; kind: string; sequence: string; payload: { chatId?: string; messageId?: string; route?: string } }>(
      "SELECT id,user_id AS \"userId\",kind,sequence,payload FROM device_actions WHERE state='pending' ORDER BY sequence");
    for (const action of actions) {
      const screen = screens.get(action.userId)!;
      if (action.kind === 'dismiss_message') delete screen.reference;
      else if (action.kind === 'open_chat' || action.kind === 'open_page') { screen.route = action.payload.route ?? `/chat/${action.payload.chatId}`; delete screen.reference; }
      else if (action.kind === 'show_message' || action.kind === 'play_audio') {
        screen.route = `/chat/${action.payload.chatId}`;
        screen.reference = { chatId: action.payload.chatId!, messageId: action.payload.messageId!, revision: Number(action.sequence) };
      } else throw new Error(`Unexpected device action ${action.kind}`);
      screen.revision++;
      await runtime.state.acknowledgeAction(action.userId, action.id, true, { context: structuredClone(screen), reference: screen.reference ?? null, presentationConfirmed: true });
    }
  })().catch(error => { failures.push(String(error)); }).finally(() => { busy = false; });
}, 40);
try {
  for (const [index, scenario] of ['close', 'repeated-close', 'navigate-after-close', 'continue-fragment'].entries()) {
    const owner = randomUUID(), ben = randomUUID(), anna = randomUUID();
    for (const [id, label] of [[owner, 'Owner'], [ben, 'Ben'], [anna, 'Anna']]) await db.query(
      "INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,$3,$4,'unused')",
      [id, `${id}@example.test`, `navigation_${index}_${label}`, label]);
    await messaging.addContact(owner, ben, 'Ben Demo'); await messaging.addContact(owner, anna, 'Anna Demo');
    const benChat = await messaging.createDirectChat(owner, ben), annaChat = await messaging.createDirectChat(owner, anna);
    const mediaId = randomUUID();
    await db.query("INSERT INTO media(id,owner_id,mime_type,byte_size,digest,duration_ms) VALUES ($1,$2,'audio/wav',4844,$3,100)", [mediaId, ben, '0'.repeat(64)]);
    const voice = await messaging.send(ben, benChat.id, { kind: 'voice', mediaId }, randomUUID());
    const annaMessage = await messaging.send(anna, annaChat.id, { kind: 'text', text: 'Please bring the blue notebook tomorrow.' }, randomUUID());
    const screen: ClientContext = { route: `/chat/${benChat.id}`, revision: 2,
      voice: { enabled: true, microphoneMuted: false, revision: 0 }, reference: { chatId: benChat.id, messageId: voice.id, revision: 1 } };
    screens.set(owner, screen);
    const session = await runtime.state.session(owner);
    const seed = async (text: string, reply: string | null) => {
      const { turn } = await runtime.state.accept(owner, session.id, randomUUID(), text, undefined, structuredClone(screen));
      await db.query('UPDATE assistant_turns SET status=$2,assistant_text=$3 WHERE id=$1', [turn.id, reply ? 'completed' : 'interrupted', reply]);
    };
    await seed(scenario === 'continue-fragment' ? 'Please read the latest message' : 'Open Ben Demo and play his last voice message.', null);
    if (scenario === 'repeated-close') await seed('Could you please close that message?', null);
    if (scenario === 'navigate-after-close') { await seed('Please close this message.', "That message is closed. Ben's chat is still open."); delete screen.reference; screen.revision++; }
    fixtures.push({ scenario, owner, session, screen, annaChat, annaMessage });
  }
  runtime.start();
  for (const f of fixtures) {
    const text = f.scenario === 'navigate-after-close' ? "Please open Anna Demo's chat." : f.scenario === 'continue-fragment' ? "in Anna Demo's chat" : 'Please close this message.';
    const { turn } = await runtime.submit(f.owner, f.session.id, randomUUID(), text, undefined, structuredClone(f.screen));
    const deadline = Date.now() + 90000;
    let current;
    do { current = await runtime.state.turn(f.owner, f.session.id, turn.id); if (!['queued', 'running'].includes(current.status)) break; await delay(100); } while (Date.now() < deadline);
    const actions = await db.query<{ kind: string; payload: { chatId?: string; messageId?: string }; state: string }>('SELECT kind,payload,state FROM device_actions WHERE turn_id=$1 ORDER BY sequence', [turn.id]);
    const passed = current.status === 'completed' && actions.length > 0 && actions.every(action => action.state === 'completed')
      && (f.scenario.includes('close') && f.scenario !== 'navigate-after-close' ? actions.every(action => action.kind === 'dismiss_message')
        : f.scenario === 'navigate-after-close' ? actions.every(action => action.kind === 'open_chat' && action.payload.chatId === f.annaChat.id)
          : actions.some(action => action.kind === 'show_message' && action.payload.messageId === f.annaMessage.id) && !actions.some(action => action.kind === 'play_audio'));
    console.info(JSON.stringify({ scenario: f.scenario, passed, actions: actions.map(action => action.kind), reply: current.assistantText }));
    if (!passed) failures.push(`${f.scenario}: ${current.status}, ${actions.map(action => action.kind).join(',')}`);
  }
  assert.deepEqual(failures, []);
} finally { clearInterval(timer); await polling; await runtime.close(); await db.close(); }
