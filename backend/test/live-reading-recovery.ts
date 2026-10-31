// Real model decisions with fictional accounts and simulated phone feedback.
// Isolated local schema only; no real user data or device actions are used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { readConfig } from '../src/config.js';
import { MetaResponsesProvider } from '../src/agents/model.js';
import { AssistantRuntime } from '../src/agents/runtime.js';
import { MessagingService } from '../src/messaging.js';
import { testDatabase } from './helpers.js';
import type { Turn } from '../src/agents/state.js';

const config = readConfig();
assert.ok(config.metaApiKey);
assert.ok(['localhost','127.0.0.1','::1','[::1]'].includes(new URL(config.databaseUrl).hostname));
process.env.TEST_DATABASE_URL = config.databaseUrl;
const db = await testDatabase();
const provider = new MetaResponsesProvider(config);
const runtime = new AssistantRuntime(db, provider);
const results: unknown[] = [];
try {
  runtime.start();
  for (const noticeFails of [false, true]) {
    const owner = randomUUID(), friend = randomUUID();
    for (const [id, name] of [[owner,'Owner'],[friend,'Anna']] as const) await db.query(
      `INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,$3,$4,'unused')`,
      [id, `${id}@example.test`, `qa_${id.replaceAll('-','').slice(0,12)}`, name]);
    const messaging = new MessagingService(db);
    await messaging.addContact(owner, friend, 'Anna');
    const chat = await messaging.createDirectChat(owner, friend);
    const sources: string[] = [];
    for (const [sender, text] of [[friend,'Our meeting is at six tomorrow evening.'],[owner,'Six works for me.'],[friend,'See you then.']])
      sources.push((await messaging.send(sender!, chat.id, { kind: 'text', text: text! }, randomUUID())).id);
    const session = await runtime.state.session(owner);
    const accepted = await runtime.submit(owner, session.id, randomUUID(), 'Open Anna and read the first three messages, from both of us, in oldest-first order.', undefined,
      { route: '/mia', revision: 0, voice: { enabled: true, microphoneMuted: false, revision: 0 } });
    const order: { kind: string; messageId: string; narration: string; success: boolean }[] = [];
    let final: Turn | undefined;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const actions = await db.query<{ id: string; kind: string; payload: { chatId?: string; messageId?: string; narration?: string } }>(
        `SELECT id,kind,payload FROM device_actions WHERE turn_id=$1 AND state='pending' ORDER BY sequence`, [accepted.turn.id]);
      for (const action of actions) {
        const source = action.kind === 'show_message';
        const notice = action.kind === 'announce_message_skip';
        const success = !(source && action.payload.messageId === sources[0]) && !(notice && noticeFails);
        const reference = { chatId: chat.id, messageId: action.payload.messageId ?? sources[0]!, revision: order.length + 1 };
        await runtime.state.acknowledgeAction(owner, action.id, success, {
          reference, context: { route: `/chat/${chat.id}`, revision: 1, reference }, presentationConfirmed: true,
          ...(!success ? { code: 'TTS_UNAVAILABLE', stage: 'narration' } : {}),
        });
        if (source || notice) order.push({ kind: action.kind, messageId: reference.messageId, narration: action.payload.narration ?? '', success });
      }
      final = await runtime.state.turn(owner, session.id, accepted.turn.id);
      if (['completed','failed'].includes(final.status)) break;
      await delay(30);
    }
    assert.ok(final);
    assert.deepEqual(order.map(item => item.kind), noticeFails
      ? ['show_message','announce_message_skip']
      : ['show_message','announce_message_skip','show_message','show_message']);
    assert.equal(final.status, noticeFails ? 'failed' : 'completed');
    if (!noticeFails) assert.deepEqual(order.filter(item => item.kind === 'show_message').map(item => item.messageId), sources);
    const [stored] = await db.query<{ error_code: string | null }>('SELECT error_code FROM assistant_turns WHERE id=$1', [final.id]);
    if (noticeFails) assert.equal(stored?.error_code, 'READING_NOTICE_FAILED');
    const result = { noticeFails, status: final.status, error: stored?.error_code, order, reply: final.assistantText };
    results.push(result); console.info(JSON.stringify(result));
  }
  await mkdir('.data', { recursive: true });
  await writeFile('.data/reading-recovery-live.json', JSON.stringify({ scope: 'Real model; simulated phone and synthesis failure; isolated fictional data.', results }, null, 2));
} finally { await runtime.close(); await db.close(); }
