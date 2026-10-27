import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AssistantRuntime } from '../src/agents/runtime.js';
import { MetaResponsesProvider, type ModelProvider, type ModelRequest, type ModelResponse } from '../src/agents/model.js';
import { readConfig } from '../src/config.js';
import { MessagingService } from '../src/messaging.js';
import { testDatabase } from './helpers.js';

function call(name: string, args: unknown): ModelResponse {
  const callId = randomUUID();
  return { output: [{ type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) }],
    calls: [{ callId, name, arguments: JSON.stringify(args) }], text: '' };
}
function answer(text: string): ModelResponse {
  return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], calls: [], text };
}
function lastResult(request: ModelRequest): unknown {
  const output = request.input.at(-1)?.output;
  return typeof output === 'string' ? JSON.parse(output) as unknown : null;
}
async function waitFor<T>(probe: () => Promise<T | undefined>, timeout = 6000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await probe();
    if (value !== undefined) return value;
    await delay(15);
  }
  throw new Error('Timed out waiting for an asynchronous operation');
}
async function fixture(provider: ModelProvider) {
  const db = await testDatabase();
  const ids = { alice: randomUUID(), anna: randomUUID(), david: randomUUID() };
  for (const [name, id] of Object.entries(ids)) await db.query(`INSERT INTO users(id,email,username,display_name,password_hash)
    VALUES ($1,$2,$3,$3,'unused')`, [id, `${name}@example.com`, name]);
  const runtime = new AssistantRuntime(db, provider);
  runtime.start();
  const session = await runtime.state.session(ids.alice);
  return { db, ids, runtime, session, messaging: new MessagingService(db),
    async close() { await runtime.close(); await db.close(); },
    async submit(text: string) { return runtime.submit(ids.alice, session.id, randomUUID(), text); },
    async completed(turnId: string) { return waitFor(async () => {
      const turn = await runtime.state.turn(ids.alice, session.id, turnId);
      if (turn.status === 'failed') throw new Error(`Turn failed: ${JSON.stringify(turn)}`);
      return turn.status === 'completed' ? turn : undefined;
    }); } };
}

test('coordinator delegates to a real specialist loop and sends only a later reviewed version', async (t) => {
  let rootStep = 0;
  let childStep = 0;
  let draft: { id: string; version: number };
  let recipientId = '';
  let finalTools: string[] = [];
  const seen: string[] = [];
  const provider: ModelProvider = { configured: true, async respond(request) {
    if (request.instructions.startsWith("You are Mia's messaging specialist")) {
      seen.push('messaging');
      assert.equal(request.tools.some((tool) => tool.name === 'send_approved_draft'), false);
      if (childStep++ === 0) return call('create_draft', { recipientId, content: { kind: 'text', text: 'Seven works for me.' } });
      draft = lastResult(request) as typeof draft;
      return answer(`Prepared draft ${draft.id}, version ${draft.version}, for Anna.`);
    }
    seen.push('mia');
    finalTools = request.tools.map((tool) => tool.name);
    switch (rootStep++) {
      case 0: return call('delegate_messaging', { goal: `Prepare a reply for ${recipientId}: seven works.` });
      case 1: return call('review_draft', { draftId: draft.id, version: 1 });
      case 2: return call('send_approved_draft', { draftId: draft.id, version: 1 });
      case 3:
        assert.equal((lastResult(request) as { error: string }).error, 'CONFLICT');
        return answer('To Anna: Seven works for me. Shall I send it?');
      case 4:
        assert.ok(request.input.some((item) => item.role === 'assistant'));
        return call('send_approved_draft', { draftId: draft.id, version: 1 });
      default: return answer('Sent to Anna.');
    }
  } };
  const context = await fixture(provider);
  t.after(() => context.close());
  recipientId = context.ids.anna;
  const first = await context.submit('Reply to Anna that seven works.');
  await context.completed(first.turn.id);
  assert.equal((await context.db.query('SELECT id FROM messages')).length, 0);
  assert.ok(seen.includes('messaging'));
  assert.ok(finalTools.includes('delegate_contacts'));
  const approval = await context.submit('That sounds good, go ahead.');
  await context.completed(approval.turn.id);
  const messages = await context.db.query<{ text: string }>('SELECT text FROM messages');
  assert.deepEqual(messages.map((message) => message.text), ['Seven works for me.']);
  const retry = await context.runtime.submit(context.ids.alice, context.session.id,
    approval.turn.clientTurnId, approval.turn.userText);
  assert.equal(retry.duplicate, true);
  assert.equal((await context.db.query('SELECT id FROM messages')).length, 1);
});

test('a plain new request interrupts specialists, keeps drafts and fences late mutations', async (t) => {
  let anna = '';
  let david = '';
  let draftId = '';
  let lateRequest: ModelRequest | undefined;
  let releaseLate: (() => void) | undefined;
  const provider: ModelProvider = { configured: true, async respond(request) {
    if (request.instructions.startsWith("You are Mia's messaging specialist")) {
      if (!draftId) {
        const result = lastResult(request) as { id?: string } | null;
        if (!result?.id) return call('create_draft', { recipientId: anna, content: { kind: 'text', text: 'A saved draft' } });
        draftId = result.id;
      }
      lateRequest = request;
      await new Promise<void>((resolve) => { releaseLate = resolve; });
      return call('update_draft', { draftId, version: 1, content: { kind: 'text', text: 'Stale edit' } });
    }
    const userItems = request.input.filter((item) => item.role === 'user');
    const latest = JSON.stringify(userItems.at(-1));
    if (latest.includes('Open David')) {
      if (!lastResult(request)) return call('open_chat', { recipientId: david });
      return answer("I'm opening David's chat.");
    }
    return call('delegate_messaging', { goal: 'Help prepare the message to Anna.' });
  } };
  const context = await fixture(provider);
  t.after(() => context.close());
  anna = context.ids.anna; david = context.ids.david;
  const first = await context.submit('Write Anna a message.');
  await waitFor(async () => lateRequest);
  const second = await context.submit("Open David's chat.");
  assert.equal(lateRequest?.signal.aborted, true);
  releaseLate?.();
  await context.completed(second.turn.id);
  const previous = await context.runtime.state.turn(context.ids.alice, context.session.id, first.turn.id);
  assert.equal(previous.status, 'interrupted');
  const draft = await context.messaging.draft(context.ids.alice, draftId);
  assert.equal(draft.text, 'A saved draft');
  assert.equal(draft.version, 1);
  assert.equal((await context.db.query('SELECT id FROM messages')).length, 0);
  const [action] = await context.db.query<{ id: string; state: string }>('SELECT id,state FROM device_actions');
  assert.equal(action?.state, 'pending');
  assert.ok(action);
  const ack = await context.runtime.state.acknowledgeAction(context.ids.alice, action.id, true, {});
  assert.equal(ack.state, 'completed');
});

test('device actions from superseded turns reject stale results and isolate ownership', async (t) => {
  const context = await fixture({ configured: false, respond: async () => answer('unused') });
  t.after(() => context.close());
  const first = await context.runtime.state.accept(context.ids.alice, context.session.id, randomUUID(), 'Open a chat.');
  const claimed = await context.runtime.state.claim(randomUUID());
  assert.ok(claimed);
  const action = await context.runtime.state.action(claimed, new AbortController().signal, 'open_chat', {});
  await assert.rejects(context.runtime.state.acknowledgeAction(context.ids.david, action.id, true, {}), { status: 404 });
  await context.runtime.state.accept(context.ids.alice, context.session.id, randomUUID(), 'Do something else.');
  const stale = await context.runtime.state.acknowledgeAction(context.ids.alice, action.id, true, {});
  assert.equal(stale.state, 'cancelled');
  await assert.rejects(context.runtime.state.mutate(first.turn, new AbortController().signal, async () => 'stale'), { code: 'TURN_SUPERSEDED' });
});

test('a delayed stop acknowledgement cannot abort a newer accepted turn', async (t) => {
  const signals = new Map<string, AbortSignal>();
  let releaseModels!: () => void;
  let releaseStop!: () => void;
  const models = new Promise<void>(resolve => { releaseModels = resolve; });
  const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
  const context = await fixture({ configured: true, async respond(request) {
    const text = String((request.input.at(-1)?.content as { text: string }[])[0]?.text);
    signals.set(text, request.signal);
    await models;
    return answer('The current request completed.');
  } });
  t.after(async () => { releaseStop(); releaseModels(); await context.close(); });
  await context.submit('First request.');
  await waitFor(async () => signals.get('First request.'));
  const interrupt = context.runtime.state.interrupt.bind(context.runtime.state);
  let committed = false;
  context.runtime.state.interrupt = async (...args) => {
    const result = await interrupt(...args);
    committed = true; await stopGate;
    return result;
  };
  const stopping = context.runtime.interrupt(context.ids.alice, context.session.id);
  await waitFor(async () => committed || undefined);
  const next = await context.submit('New request.');
  const newerSignal = await waitFor(async () => signals.get('New request.'));
  releaseStop(); await stopping;
  assert.equal(newerSignal.aborted, false);
  releaseModels(); await context.completed(next.turn.id);
});

test('Meta Responses adapter uses actual tool items, private replay and cancellation', async () => {
  let payload: Record<string, unknown> = {};
  const config = readConfig({ META_API_KEY: 'test-key', NODE_ENV: 'test' });
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(input, 'https://api.meta.ai/v1/responses');
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.ok(init?.signal);
    return new Response(JSON.stringify({ status: 'completed', output: [
      { type: 'reasoning', encrypted_content: 'opaque-provider-state' },
      { type: 'function_call', call_id: 'call-1', name: 'list_chats', arguments: '{}' },
    ] }), { headers: { 'content-type': 'application/json' } });
  };
  const provider = new MetaResponsesProvider(config, fetcher);
  const result = await provider.respond({ instructions: 'Test', input: [], tools: [], signal: new AbortController().signal });
  assert.equal(payload.store, false);
  assert.deepEqual(payload.include, ['reasoning.encrypted_content']);
  assert.equal(payload.parallel_tool_calls, false);
  assert.deepEqual(result.calls, [{ callId: 'call-1', name: 'list_chats', arguments: '{}' }]);
  assert.equal(result.output[0]?.encrypted_content, 'opaque-provider-state');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(provider.respond({ instructions: 'Test', input: [], tools: [], signal: aborted.signal }));
});
