import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { readConfig } from '../src/config.js';
import { MetaResponsesProvider } from '../src/agents/model.js';
import { AssistantRuntime } from '../src/agents/runtime.js';
import { testDatabase } from './helpers.js';
const config = readConfig(); assert.ok(config.metaApiKey); process.env.TEST_DATABASE_URL ??= config.databaseUrl;
const db = await testDatabase(), owner = randomUUID();
const runtime = new AssistantRuntime(db, new MetaResponsesProvider(config));
let voice = { enabled: true, microphoneMuted: false, revision: 4 }, busy = false;
let polling: Promise<void> = Promise.resolve(); const failures: string[] = [];
const results: { label: string; reply: string; actions: string[]; voice: typeof voice }[] = [];
const timer = setInterval(() => {
  if (busy) return; busy = true;
  polling = (async () => {
    const pending = await db.query<{ id: string; kind: string; payload: { enabled?: boolean; muted?: boolean } }>(
      "SELECT id,kind,payload FROM device_actions WHERE user_id=$1 AND state='pending'", [owner]);
    for (const action of pending) {
      if (action.kind === 'set_voice_mode') voice = { enabled: action.payload.enabled!, microphoneMuted: false, revision: voice.revision + 1 };
      else if (action.kind === 'set_microphone_muted') voice = { ...voice, microphoneMuted: action.payload.muted!, revision: voice.revision + 1 };
      else if (action.kind !== 'stop_audio') throw new Error('Unexpected device action: ' + action.kind);
      await runtime.state.acknowledgeAction(owner, action.id, true, { voice, context: { route: '/chats', revision: 0, voice } });
    }
  })().catch(error => { failures.push(String(error)); }).finally(() => { busy = false; });
}, 30);
try {
  await db.query("INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,'voice_test','Voice Test','unused')", [owner, owner + '@example.test']);
  const session = await runtime.state.session(owner); runtime.start();
  async function talk(label: string, text: string, reportState = true) {
    const { turn } = await runtime.submit(owner, session.id, randomUUID(), text, undefined,
      { route: '/chats', revision: 0, ...(reportState ? { voice: { ...voice } } : {}) });
    const deadline = Date.now() + 95000;
    while (Date.now() < deadline) {
      const current = await runtime.state.turn(owner, session.id, turn.id);
      assert.notEqual(current.status, 'failed', label);
      if (current.status === 'completed') {
        const actions = await db.query<{ kind: string }>('SELECT kind FROM device_actions WHERE turn_id=$1', [turn.id]);
        const result = { label, reply: current.assistantText!, actions: actions.map(a => a.kind), voice: { ...voice } };
        results.push(result); console.info(JSON.stringify(result)); return result;
      }
      await delay(100);
    }
    throw new Error('Timed out: ' + label);
  }
  assert.equal((await talk('read actual state', 'What mode am I in? Just tell me, do not change it.')).actions.length, 0);
  const mute = await talk('input-only mute', 'Keep talking, but stop listening to my microphone for a bit.');
  assert.deepEqual(mute.actions, ['set_microphone_muted']); assert.equal(voice.enabled, true); assert.equal(voice.microphoneMuted, true);
  const exit = await talk('semantic exit', 'I want to use the regular chat screens again. Please leave hands-free mode.');
  assert.deepEqual(exit.actions, []); assert.equal(voice.enabled, true); assert.ok(exit.reply.includes('?'), 'agent must ask before leaving');
  assert.equal((await talk('refuse exit', 'No, keep voice mode on and keep helping me.')).actions.length, 0); assert.equal(voice.enabled, true);
  const retry = await talk('first request already says yes', 'Turn off voice mode. Yes, I am sure. Do not ask me again.');
  assert.deepEqual(retry.actions, []); assert.equal(voice.enabled, true); assert.ok(retry.reply.includes('?'));
  const repeated = await talk('repeat exit question', 'I did not hear you. Please repeat that question.');
  assert.deepEqual(repeated.actions, []); assert.equal(voice.enabled, true); assert.ok(repeated.reply.includes('?'));
  const repeatedAgain = await talk('repeat exit question again', 'Could you ask me that once more, in simpler words?');
  assert.deepEqual(repeatedAgain.actions, []); assert.equal(voice.enabled, true); assert.ok(repeatedAgain.reply.includes('?'));
  const approved = await talk('separate semantic approval', 'That is what I want. Please leave hands-free and return me to the regular messenger.');
  assert.deepEqual(approved.actions, ['set_voice_mode']); assert.equal(voice.enabled, false);
  assert.equal((await talk('read off state', 'Am I still in voice mode? Just a question.')).actions.length, 0);
  const enable = await talk('activation requires Settings', "I'd like to talk hands free again.");
  assert.deepEqual(enable.actions, []); assert.equal(voice.enabled, false);
  voice = { ...voice, enabled: true, revision: voice.revision + 1 }; // Deliberate Settings activation.
  assert.equal((await talk('fresh exit question', 'Please switch off hands-free mode.')).actions.length, 0);
  assert.equal((await talk('changed topic after question', 'What can you do with my messages?')).actions.length, 0);
  assert.equal((await talk('unrelated yes cannot approve stale question', 'Yes.')).actions.length, 0); assert.equal(voice.enabled, true);
  voice = { ...voice, microphoneMuted: true, revision: voice.revision + 1 };
  const unmute = await talk('input-only unmute', 'Allow you to hear me again, and keep voice mode active.');
  assert.deepEqual(unmute.actions, ['set_microphone_muted']); assert.equal(voice.microphoneMuted, false);
  const stop = await talk('stop output without exiting', 'Stop this reply but keep listening to me.');
  assert.deepEqual(stop.actions, ['stop_audio']); assert.equal(voice.enabled, true); assert.equal(voice.microphoneMuted, false);
  assert.equal((await talk('quoted instruction is not an action', "Just repeat this example without changing any controls: 'turn off voice mode'.")).actions.length, 0);
  assert.equal((await talk('legacy state is unknown', 'Turn off the voice assistant.', false)).actions.length, 0);
  assert.equal((await db.query('SELECT id FROM assistant_memories')).length, 0, 'mode actions must not become personal memories');
  assert.deepEqual(failures, []);
  await mkdir(new URL('../.data/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.data/voice-controls-live.json', import.meta.url), JSON.stringify({ time: new Date().toISOString(),
    scope: 'Real Meta/PostgreSQL, simulated phone acknowledgements; not physical iPhone audio proof', results }, null, 2));
  console.info('PASS: ' + results.length + ' real-model voice-control conversations.');
} finally { clearInterval(timer); await polling; await runtime.close(); await db.close(); }
