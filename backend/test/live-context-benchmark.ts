// Identical real-model conversations against a supplied backend snapshot.
// Database and phone feedback are isolated/simulated; no production users or TTS.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.js';
import { testDatabase } from './helpers.js';
import type { ClientContext } from '../src/agents/context.js';
import type { ModelProvider, ModelRequest } from '../src/agents/model.js';

const config = readConfig(); assert.ok(config.metaApiKey);
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(config.databaseUrl).hostname));
process.env.TEST_DATABASE_URL = config.databaseUrl;
const root = resolve(process.env.MIA_BENCHMARK_BACKEND ?? '.');
const sourceHash = createHash('sha256');
for (const file of ['runtime.ts', 'model.ts', 'prompts.ts', 'tools.ts', 'conversation.ts', 'capabilities.ts', 'context-budget.ts']) {
  sourceHash.update(file); sourceHash.update(await readFile(join(root, 'src/agents', file)).catch(() => Buffer.from('absent')));
}
const fingerprint = sourceHash.digest('hex');
const { AssistantRuntime } = await import(pathToFileURL(join(root, 'src/agents/runtime.ts')).href) as typeof import('../src/agents/runtime.js');
const { MetaResponsesProvider } = await import(pathToFileURL(join(root, 'src/agents/model.ts')).href) as typeof import('../src/agents/model.js');
const { MessagingService } = await import(pathToFileURL(join(root, 'src/messaging.ts')).href) as typeof import('../src/messaging.js');
type Trace = { ms: number; instructionChars: number; inputChars: number; toolChars: number; toolCount: number;
  inputTokens?: number; cachedTokens?: number; outputTokens?: number; reasoningTokens?: number; tools: string[] };
const results: { repetition: number; scenario: string; ms: number; passed: boolean; reply: string | null; calls: Trace[]; progress: number }[] = [];
const db = await testDatabase();
let currentTrace: Trace[] = [], currentRequest: ModelRequest;
const fetcher: typeof fetch = async (url, init) => {
  const payload = JSON.parse(String(init?.body)) as { instructions: string; input: unknown; tools: unknown[] };
  const start = performance.now(), response = await fetch(url, init);
  if (response.ok) {
    const body = await response.clone().json() as { usage?: { input_tokens: number; output_tokens: number;
      input_tokens_details?: { cached_tokens: number }; output_tokens_details?: { reasoning_tokens: number } }; output: { type: string; name?: string }[] };
    currentTrace.push({ ms: Math.round(performance.now() - start), instructionChars: payload.instructions.length,
      inputChars: JSON.stringify(payload.input).length, toolChars: JSON.stringify(payload.tools).length, toolCount: payload.tools.length,
      inputTokens: body.usage?.input_tokens, cachedTokens: body.usage?.input_tokens_details?.cached_tokens,
      outputTokens: body.usage?.output_tokens, reasoningTokens: body.usage?.output_tokens_details?.reasoning_tokens,
      tools: body.output.filter(item => item.type === 'function_call').map(item => item.name!) });
  }
  return response;
};
const real = new MetaResponsesProvider(config, fetcher);
const provider: ModelProvider = { configured: true, async respond(request) { currentRequest = request; return real.respond(request); } };
const runtime = new AssistantRuntime(db, provider), messaging = new MessagingService(db);
const screens = new Map<string, ClientContext>(), handled = new Set<string>();
let polling = false;
const failures: string[] = [];
const timer = setInterval(() => {
  if (polling) return; polling = true;
  void (async () => {
    const actions = await db.query<{ id: string; userId: string; kind: string; payload: { chatId?: string; messageId?: string; route?: string } }>(
      `SELECT id,user_id AS "userId",kind,payload FROM device_actions WHERE state='pending' ORDER BY sequence`);
    for (const action of actions) {
      if (handled.has(action.id)) continue; handled.add(action.id);
      const screen = screens.get(action.userId)!;
      if (action.kind === 'speak_progress') {
        await runtime.state.acknowledgeAction(action.userId, action.id, false, { code: 'ACTION_CANCELLED', stage: 'narration', context: screen });
        continue;
      }
      if (action.kind === 'open_chat') { screen.route = `/chat/${action.payload.chatId}`; screen.revision++; }
      else if (action.kind === 'open_page') { screen.route = action.payload.route!; screen.revision++; }
      else if (action.kind === 'show_message') {
        screen.route = `/chat/${action.payload.chatId}`; screen.revision++;
        screen.reference = { chatId: action.payload.chatId!, messageId: action.payload.messageId!, revision: screen.revision };
      } else if (action.kind === 'dismiss_message') delete screen.reference;
      else throw new Error(`Unexpected benchmark action ${action.kind}`);
      await runtime.state.acknowledgeAction(action.userId, action.id, true, { context: structuredClone(screen), reference: screen.reference ?? null });
    }
  })().catch(error => failures.push(String(error))).finally(() => { polling = false; });
}, 20);
runtime.start();
try {
  for (let repetition = 1; repetition <= 2; repetition++) {
    const owner = randomUUID(), ben = randomUUID();
    for (const [id, name, phone] of [[owner, 'Context QA', `+155500098${repetition}1`], [ben, 'Ben Demo', `+155500098${repetition}2`]]) await db.query(
      "INSERT INTO users(id,email,username,display_name,password_hash,phone_number) VALUES ($1,$2,$3,$4,'unused',$5)",
      [id, `${id}@example.test`, `bench_${id!.slice(0, 8)}`, name, phone]);
    await messaging.addContact(owner, ben, 'Ben Demo');
    const screen: ClientContext = { route: '/chats', revision: 1, navigationSessionId: randomUUID(), voice: { enabled: true, microphoneMuted: false, revision: 1 } };
    screens.set(owner, screen);
    const session = await runtime.state.session(owner);
    let draftId = '', version = 0;
    for (const [scenario, text] of [
      ['greeting', 'Hi Mia.'],
      ['phone_lookup', 'What is the phone number of my saved contact Ben Demo?'],
      ['draft', 'Open Ben Demo\'s chat and prepare an unsent text draft saying I will be ten minutes late. Keep me posted as you work, but do not send it.'],
      ['revision', 'Make that a little warmer and shorter. Keep it unsent.'],
      ['approval', 'Yes, send that exact revised message to Ben Demo.'],
    ]) {
      currentTrace = [];
      const start = performance.now();
      const { turn: accepted } = await runtime.submit(owner, session.id, randomUUID(), text!, undefined, structuredClone(screen));
      let turn = accepted;
      while (['queued', 'running'].includes(turn.status)) {
        if (performance.now() - start > 150000) throw new Error(`Benchmark timeout: ${scenario}`);
        await delay(20); turn = await runtime.state.turn(owner, session.id, turn.id);
      }
      const ms = Math.round(performance.now() - start);
      const drafts = await messaging.drafts(owner);
      const messages = await db.query<{ text: string }>('SELECT text FROM messages WHERE sender_id=$1', [owner]);
      let passed = turn.status === 'completed';
      if (scenario === 'greeting') passed &&= Boolean(turn.assistantText && turn.assistantText.length < 120 && !/how can i help/i.test(turn.assistantText));
      if (scenario === 'phone_lookup') passed &&= Boolean(turn.assistantText?.replace(/\D/g, '').includes(`155500098${repetition}2`));
      if (scenario === 'draft') { passed &&= drafts.length === 1 && drafts[0]!.recipientId === ben && messages.length === 0; draftId = drafts[0]?.id ?? ''; version = drafts[0]?.version ?? 0; }
      if (scenario === 'revision') { passed &&= drafts.length === 1 && drafts[0]!.id === draftId && drafts[0]!.version > version && drafts[0]!.recipientId === ben && messages.length === 0; }
      if (scenario === 'approval') passed &&= messages.length === 1;
      const progress = await db.query("SELECT id FROM device_actions WHERE turn_id=$1 AND kind='speak_progress'", [turn.id]);
      const result = { repetition, scenario: scenario!, ms, passed, reply: turn.assistantText, calls: currentTrace, progress: progress.length };
      results.push(result); console.log(JSON.stringify(result));
      assert.ok(currentRequest!, 'The model was called.');
    }
  }
  await mkdir('.data', { recursive: true });
  const output = resolve(process.env.MIA_BENCHMARK_OUTPUT ?? '.data/context-benchmark.json');
  await writeFile(output, JSON.stringify({ observedAt: new Date().toISOString(), backend: root, fingerprint, model: config.metaModel, results, failures }, null, 2));
  console.log(`RESULT=${output}`);
  assert.equal(failures.length, 0, failures.join('\n'));
  assert.ok(results.every(result => result.passed), 'One or more conversation quality checks failed; inspect the report.');
} finally { clearInterval(timer); while (polling) await delay(5); await runtime.close(); await db.close(); }
