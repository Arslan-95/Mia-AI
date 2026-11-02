// Real-model recall from compacted history, in an isolated fictional session.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.js';
import { AssistantRuntime } from '../src/agents/runtime.js';
import { MetaResponsesProvider } from '../src/agents/model.js';
import { testDatabase } from './helpers.js';
import { conversationInput } from '../src/agents/conversation.js';

const config = readConfig(); assert.ok(config.metaApiKey);
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(config.databaseUrl).hostname));
process.env.TEST_DATABASE_URL = config.databaseUrl;
const db = await testDatabase(), live = new MetaResponsesProvider(config);
const calls: { tools: string[]; ms?: number; inputTokens?: number }[] = [];
const runtime = new AssistantRuntime(db, { configured: true, async respond(request) {
  const response = await live.respond(request);
  calls.push({ tools: response.calls.map(call => call.name), ms: response.durationMs, inputTokens: response.usage?.inputTokens });
  return response;
} });
const owner = randomUUID();
try {
  await db.query("INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,'history_recall_qa','History QA','unused')", [owner, `${owner}@example.test`]);
  const session = await runtime.state.session(owner);
  const paragraph = 'A quiet room, a wooden desk, and an open window. '.repeat(145) + 'violet clouds over mountains';
  const first = await runtime.state.accept(owner, session.id, randomUUID(), `Please repeat this paragraph exactly: ${paragraph}`);
  await db.query("UPDATE assistant_turns SET status='completed',assistant_text=$2 WHERE id=$1", [first.turn.id, paragraph]);
  for (let index = 0; index < 8; index++) {
    const { turn } = await runtime.state.accept(owner, session.id, randomUUID(), `Unrelated exchange ${index}. ${'Some unrelated logistics discussion. '.repeat(15)}`);
    await db.query("UPDATE assistant_turns SET status='completed',assistant_text='Understood.' WHERE id=$1", [turn.id]);
  }
  const { turn: accepted } = await runtime.state.accept(owner, session.id, randomUUID(), 'What were the exact last four words of the paragraph I asked you to repeat at the start?');
  const actualInput = JSON.stringify(await conversationInput(db, runtime.state, accepted));
  assert.match(actualInput, /Historical conversation excerpts/);
  assert.doesNotMatch(actualInput, /violet clouds over mountains/i, 'The requested words must actually be omitted before testing retrieval.');
  runtime.start();
  const deadline = Date.now() + 90000;
  let turn = accepted;
  while (['queued', 'running'].includes(turn.status)) {
    assert.ok(Date.now() < deadline, 'History recall timed out.');
    await delay(30); turn = await runtime.state.turn(owner, session.id, turn.id);
  }
  const passed = turn.status === 'completed' && /violet clouds over mountains/i.test(turn.assistantText ?? '') && calls.some(call => call.tools.includes('recall_conversation'));
  const result = { passed, reply: turn.assistantText, calls, scope: 'Isolated fictional dialogue, exact original words omitted from the compacted excerpt.' };
  await writeFile('.data/history-recall-live.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  assert.ok(passed, 'The agent must retrieve exact omitted words rather than guess from an excerpt.');
} finally { await runtime.close(); await db.close(); }
