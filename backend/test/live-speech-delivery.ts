// Real semantic decisions in a disposable local schema; never reads owner data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.js';
import { MetaResponsesProvider } from '../src/agents/model.js';
import { AssistantRuntime } from '../src/agents/runtime.js';
import { AgentMemory } from '../src/agents/memory.js';
import { defaultSpeechDelivery } from '../src/speech/delivery.js';
import { testDatabase } from './helpers.js';

const config = readConfig();
assert.ok(config.metaApiKey, 'A configured real model is required.');
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(config.databaseUrl).hostname), 'Use local QA only.');
process.env.TEST_DATABASE_URL = config.databaseUrl;
const db = await testDatabase(), owner = randomUUID();
const provider = new MetaResponsesProvider(config), memories = new AgentMemory(db);
let runtime = new AssistantRuntime(db, provider);
const report: Record<string, unknown>[] = [];
const screen = { route: '/mia', revision: 1, voice: { enabled: true, microphoneMuted: false, revision: 1 } };
await db.query("INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,'delivery_qa','Delivery QA','unused')", [owner, `${owner}@example.test`]);
const session = await runtime.state.session(owner);

async function talk(label: string, text: string) {
  const { turn } = await runtime.submit(owner, session.id, randomUUID(), text, undefined, screen);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const current = await runtime.state.turn(owner, session.id, turn.id);
    assert.notEqual(current.status, 'failed', `${label}: ${JSON.stringify(current)}`);
    if (current.status === 'completed') {
      const delivery = current.speechDelivery ?? defaultSpeechDelivery;
      const saved = (await memories.list(owner)).memories;
      const entry = { label, user: text, reply: current.assistantText, delivery,
        memories: saved.map(({ id, key, value, version }) => ({ id, key, value, version })) };
      report.push(entry); console.info(JSON.stringify(entry));
      assert.doesNotMatch(current.assistantText!, /set_speech_delivery|speechDelivery|"tone"\s*:|\[(?:calm|gentle|light)\]/i, 'Internal delivery must not be spoken.');
      return { current, delivery, saved };
    }
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}

try {
  runtime.start();
  const greeting = await talk('plain greeting', 'Hello, Mia.');
  assert.deepEqual(greeting.delivery, defaultSpeechDelivery);
  assert.doesNotMatch(greeting.current.assistantText!, /!|how can I help|thrilled|delighted|oh wow/i);
  assert.equal(greeting.saved.length, 0);

  const gentle = await talk('delicate current topic', 'I am upset after a difficult conversation. Please answer gently for this reply only; just acknowledge that I can take a pause.');
  assert.equal(gentle.delivery.tone, 'gentle'); assert.equal(gentle.saved.length, 0);
  const light = await talk('temporary lightness', 'For this answer only, use a light tone and give me one very mild joke about a notebook.');
  assert.equal(light.delivery.tone, 'light'); assert.equal(light.saved.length, 0);
  const practical = await talk('ordinary answer resets context', 'What is two plus two?');
  assert.deepEqual(practical.delivery, defaultSpeechDelivery);
  assert.equal(practical.saved.length, 0);
  const temporary = await talk('one answer is not a lasting preference', 'For this reply only, speak a little more slowly, with natural pauses. Tell me that the notebook is on the desk.');
  assert.equal(temporary.delivery.pace, 'unhurried'); assert.equal(temporary.saved.length, 0);

  const preference = await talk('implicit lasting correction', 'You usually sound too rushed for me. In general I prefer a slightly slower, unhurried speaking pace, even for simple answers.');
  assert.equal(preference.delivery.pace, 'unhurried');
  assert.equal(preference.saved.length, 1, 'Save one supported communication preference.');
  const savedPace = preference.saved[0]!;

  await runtime.close();
  // Move the original preference beyond the recent conversation window, then
  // recreate the runtime. Only persisted account memory should carry it across.
  await db.query("UPDATE assistant_turns SET created_at=now()-interval '10 minutes' WHERE session_id=$1", [session.id]);
  for (let i = 0; i < 18; i++) {
    const filler = await runtime.state.accept(owner, session.id, randomUUID(), 'Unrelated old QA exchange ' + i);
    await db.query("UPDATE assistant_turns SET status='completed',assistant_text='Understood.' WHERE id=$1", [filler.turn.id]);
  }
  await db.query("UPDATE assistant_turns SET created_at=now()-interval '5 minutes' WHERE session_id=$1 AND user_text LIKE 'Unrelated old QA exchange %'", [session.id]);
  runtime = new AssistantRuntime(db, provider); runtime.start();
  const recalled = await talk('saved pace survives runtime restart and history window', 'What is three plus three?');
  assert.equal(recalled.delivery.pace, 'unhurried'); assert.equal(recalled.saved.length, 1);
  const override = await talk('current request overrides saved pace', 'For this answer only, use an ordinary steady pace instead of my usual preference. What is four plus four?');
  assert.equal(override.delivery.pace, 'steady');
  assert.equal(override.saved[0]!.id, savedPace.id); assert.equal(override.saved[0]!.version, savedPace.version);
  const resumed = await talk('temporary override expires', 'What is five plus five?');
  assert.equal(resumed.delivery.pace, 'unhurried');
  const correction = await talk('correction updates existing preference', 'Actually, I have changed my mind about my usual speaking pace. From now on I prefer an ordinary steady pace rather than slow speech.');
  assert.equal(correction.delivery.pace, 'steady'); assert.equal(correction.saved.length, 1);
  assert.equal(correction.saved[0]!.id, savedPace.id); assert.ok(correction.saved[0]!.version > savedPace.version);

  const quote = await talk('quoted preferences do not personalize the user', 'A fictional character says: "I always prefer exuberant voices and lots of laughter." This is only a quote, not my preference. Just acknowledge the example.');
  assert.equal(quote.saved.length, 1); assert.equal(quote.saved[0]!.version, correction.saved[0]!.version);
  const paused = await talk('pause automatic learning', 'Stop automatically remembering my communication preferences.');
  assert.equal(await memories.automatic(owner), false);
  const whilePaused = await talk('casual preference while automatic memory is paused', 'I prefer a friendlier voice in general.');
  assert.deepEqual(whilePaused.saved, paused.saved);
  const forgot = await talk('forget actual saved preference', 'Forget the speaking pace preference you saved for me.');
  assert.equal(forgot.saved.length, 0);
  const afterForget = await talk('do not reconstruct forgotten preference', 'What preferences about my speaking pace do you have saved?');
  assert.equal(afterForget.saved.length, 0); assert.equal(afterForget.delivery.pace, 'steady');

  console.info(`PASS: ${report.length} real-model delivery and personalization scenarios.`);
} finally {
  await mkdir(new URL('../.data/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.data/speech-delivery-live.json', import.meta.url), JSON.stringify({
    time: new Date().toISOString(), scope: 'Real model; isolated local PostgreSQL; no subjective audio assessment.', report,
  }, null, 2));
  await runtime.close(); await db.close();
}
