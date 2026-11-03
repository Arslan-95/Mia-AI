import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { readConfig } from '../src/config.js';
import { PostgresDatabase } from '../src/db/database.js';
import { testDatabase } from './helpers.js';
import { MetaResponsesProvider } from '../src/agents/model.js';
import { AssistantRuntime } from '../src/agents/runtime.js';
import { AgentMemory } from '../src/agents/memory.js';
import { MessagingService } from '../src/messaging.js';

// Uses the configured real model and real PostgreSQL in a disposable isolated
// schema. Never touches the owner's contacts, memories, messages or account.
const config = readConfig(); assert.ok(config.metaApiKey);
await mkdir(new URL('../.data/', import.meta.url), { recursive: true });
process.env.TEST_DATABASE_URL ??= config.databaseUrl;
const db = await testDatabase(), owner = randomUUID(), anna = randomUUID(), ben = randomUUID();
const messaging = new MessagingService(db), memories = new AgentMemory(db), actualProvider = new MetaResponsesProvider(config);
const modelTrace: unknown[] = [];
const provider = { configured: actualProvider.configured, async respond(request: Parameters<typeof actualProvider.respond>[0]) {
  const response = await actualProvider.respond(request);
  const result = request.input.at(-1);
  modelTrace.push({ review: request.instructions.startsWith('You verify a proposed'), calls: response.calls, lastToolResult: result?.type === 'function_call_output' ? result.output : undefined });
  if (response.calls.length) console.info(JSON.stringify(modelTrace.at(-1)));
  return response;
} };
let runtime = new AssistantRuntime(db, provider), reconnect: PostgresDatabase | undefined;
const report: { label: string; user: string; reply: string; memoryCount: number }[] = [];
let session: { id: string };
async function talk(label: string, text: string) {
  const accepted = await runtime.submit(owner, session.id, randomUUID(), text);
  const deadline = Date.now() + 95000;
  while (Date.now() < deadline) {
    const turn = await runtime.state.turn(owner, session.id, accepted.turn.id);
    if (turn.status === 'failed') {
      const tools = await db.query(`SELECT type,payload FROM events WHERE payload->>'turnId'=$1 ORDER BY id`, [turn.id]);
      console.info(JSON.stringify({ failedCase: label, tools })); throw new Error('Live memory turn failed: ' + label);
    }
    if (turn.status === 'completed') {
      report.push({ label, user: text, reply: turn.assistantText!, memoryCount: (await memories.context(owner)).total });
      console.info('Completed: ' + label); return turn.assistantText!;
    }
    await delay(100);
  }
  throw new Error('Live memory turn timed out: ' + label);
}
try {
  for (const [id, name] of [[owner, 'MemoryOwner'], [anna, 'Anna'], [ben, 'Ben']]) await db.query(`INSERT INTO users(id,email,username,display_name,password_hash,profile_complete)
    VALUES ($1,$2,$3,$3,'unused',true)`, [id, id + '@memory.test', name]);
  const annaContact = await messaging.addContact(owner, anna, 'Anna'); await messaging.addContact(owner, ben, 'Ben');
  runtime.start(); session = await runtime.state.session(owner);
  await talk('implicit preferred name', 'Most people call me Arslan. I prefer that.');
  assert.ok((await memories.list(owner)).memories.some(m => m.contactId === null && m.value.includes('Arslan')));
  await talk('implicit relationship', 'By the way, Anna is my sister.');
  const relation = (await memories.list(owner)).memories.find(m => m.kind === 'relationship');
  assert.equal(relation?.contactId, annaContact.contactId); assert.match(relation!.value, /sister/i);
  await talk('implicit preference', 'With coworkers I keep my messages brief and skip emojis.');
  assert.ok((await memories.list(owner)).memories.some(m => m.kind === 'preference' && /brief|emoji/i.test(m.value)));
  await talk('dictated content is not identity', 'Prepare a draft to Anna saying exactly: My name is Sasha.');
  assert.equal((await memories.list(owner)).memories.some(m => /Sasha/i.test(m.value)), false);
  assert.equal((await db.query('SELECT id FROM messages')).length, 0);
  await talk('hypothetical is not a fact', "As a fictional example only, imagine I am called Victor and Anna is my boss. Don't act on it; just say understood.");
  assert.equal((await memories.list(owner)).memories.some(m => /Victor|boss/i.test(m.value)), false);
  await talk('rename is a messenger action', "Change Anna's saved contact name to Work.");
  assert.equal((await messaging.contact(owner, annaContact.contactId)).name, 'Work');
  assert.match((await memories.get(owner, relation!.id)).value, /sister/i);
  assert.equal((await memories.list(owner)).memories.some(m => /\bWork\b/i.test(m.value)), false);
  await talk('semantic correction', 'Actually, address me as Timur from now on.');
  const name = (await memories.list(owner)).memories.filter(m => m.contactId === null && m.kind === 'identity' && /Arslan|Timur/i.test(m.value));
  assert.equal(name.length, 1); assert.match(name[0]!.value, /Timur/); assert.ok(name[0]!.version >= 2);
  await talk('pause automatic learning', 'Please stop automatically retaining things I tell you.');
  assert.equal(await memories.automatic(owner), false);
  const beforePause = (await memories.context(owner)).total;
  await talk('casual facts while paused', 'I work as a baker.');
  assert.equal((await memories.context(owner)).total, beforePause);
  await talk('explicit save while paused', 'Please keep this in memory: I work as a designer.');
  assert.ok((await memories.list(owner)).memories.some(m => /designer/i.test(m.value)));
  await talk('resume automatic learning', "I'd like you to remember useful things naturally again.");
  assert.equal(await memories.automatic(owner), true);
  await runtime.close();
  // Historical filler is old conversation, not a burst of new user requests.
  await db.query("UPDATE assistant_turns SET created_at=now()-interval '10 minutes' WHERE session_id=$1", [session.id]);
  for (let i = 0; i < 14; i++) {
    const accepted = await runtime.state.accept(owner, session.id, randomUUID(), 'Unrelated filler ' + i);
    await db.query("UPDATE assistant_turns SET status='completed',assistant_text='Done.' WHERE id=$1", [accepted.turn.id]);
  }
  const [schemaRow] = await db.query<{ schema: string }>('SELECT current_schema() AS schema');
  const schema = schemaRow!.schema;
  const url = new URL(process.env.TEST_DATABASE_URL!); url.searchParams.set('options', '-c search_path=' + schema);
  reconnect = new PostgresDatabase(url.toString()); runtime = new AssistantRuntime(reconnect, provider); runtime.start();
  const recalled = await talk('recall beyond history after reconnect', 'What should you call me, and who is my sister?');
  assert.match(recalled, /Timur/i); assert.match(recalled, /Work/i);
  await talk('forget a specific fact', 'Please remove the name you remember for addressing me.');
  assert.equal((await memories.list(owner)).memories.some(m => /Arslan|Timur/i.test(m.value)), false);
  const forgotten = await talk('no reconstruction of forgotten name', 'What name have you saved for me?');
  assert.doesNotMatch(forgotten, /Timur|Arslan/i);
  await talk('forget relationship without renaming', 'Forget the relationship you remembered for Work.');
  assert.equal((await memories.list(owner)).memories.some(m => m.kind === 'relationship'), false);
  assert.equal((await messaging.contact(owner, annaContact.contactId)).name, 'Work');
  await talk('forget all preserves messenger', 'Erase everything you have stored in your personal memory about me, but keep my contacts and messages.');
  assert.equal((await memories.context(owner)).total, 0); assert.equal((await messaging.contacts(owner)).length, 2);
  const result = { time: new Date().toISOString(), scope: 'Real configured Meta model and PostgreSQL, disposable schema, no owner data', passed: report.length, report };
  await writeFile(new URL('../.data/memory-live-result.json', import.meta.url), JSON.stringify(result, null, 2));
  console.info('PASS: ' + report.length + ' live memory conversation cases.');
} catch (error) {
  await writeFile(new URL('../.data/memory-live-partial.json', import.meta.url), JSON.stringify({ time: new Date().toISOString(), report, modelTrace }, null, 2));
  throw error;
} finally { await runtime.close(); await reconnect?.close(); await db.close(); }
