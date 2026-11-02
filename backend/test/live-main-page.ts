// Real model, isolated fictional user, simulated phone. No real account edits.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.js';
import { MetaResponsesProvider } from '../src/agents/model.js';
import { AssistantRuntime } from '../src/agents/runtime.js';
import type { ClientContext } from '../src/agents/context.js';
import { testDatabase } from './helpers.js';

const config = readConfig(); assert.ok(config.metaApiKey);
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(config.databaseUrl).hostname));
process.env.TEST_DATABASE_URL = config.databaseUrl;
const db = await testDatabase(), runtime = new AssistantRuntime(db, new MetaResponsesProvider(config));
const screens = new Map<string, ClientContext>(), results = [], failures: string[] = [];
let busy = false, polling = Promise.resolve();
const timer = setInterval(() => {
  if (busy) return; busy = true;
  polling = (async () => {
    const pending = await db.query<{ id: string; userId: string; kind: string; payload: { route?: string } }>("SELECT id,user_id AS \"userId\",kind,payload FROM device_actions WHERE state='pending'");
    for (const action of pending) {
      assert.equal(action.kind, 'open_page'); assert.equal(action.payload.route, '/chats');
      const screen = screens.get(action.userId)!;
      screen.previousRoute = screen.route; screen.route = '/chats'; screen.revision++;
      await runtime.state.acknowledgeAction(action.userId, action.id, true, { context: structuredClone(screen) });
    }
  })().catch(error => { failures.push(String(error)); }).finally(() => { busy = false; });
}, 40);
try {
  runtime.start();
  for (const request of ['Take me back to the main screen.', "Go home, but keep listening to me."]) {
    const owner = randomUUID();
    await db.query("INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,$3,'Owner','unused')", [owner, `${owner}@example.test`, `main_${results.length}`]);
    const context: ClientContext = { route: '/settings', revision: 3, navigationSessionId: randomUUID(), voice: { enabled: true, microphoneMuted: false, revision: 1 } };
    screens.set(owner, context);
    const session = await runtime.state.session(owner);
    const { turn } = await runtime.submit(owner, session.id, randomUUID(), request, undefined, structuredClone(context));
    const deadline = Date.now() + 90000;
    let current;
    do { current = await runtime.state.turn(owner, session.id, turn.id); if (!['queued', 'running'].includes(current.status)) break; await delay(100); } while (Date.now() < deadline);
    const actions = await db.query<{kind: string; state: string}>('SELECT kind,state FROM device_actions WHERE turn_id=$1', [turn.id]);
    const result = { request, passed: current.status === 'completed' && actions.length === 1 && actions[0]!.state === 'completed' && actions[0]!.kind === 'open_page' && context.route === '/chats' && context.voice!.enabled, reply: current.assistantText };
    results.push(result); console.info(JSON.stringify(result));
  }
  await writeFile('.data/main-page-live.json', JSON.stringify({ observedAt: new Date().toISOString(), results, failures }, null, 2));
  assert.deepEqual(failures, []); assert.ok(results.every(result => result.passed));
} finally { clearInterval(timer); await polling; await runtime.close(); await db.close(); }
