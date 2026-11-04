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
async function fixture(provider: ModelProvider, start = true) {
  const db = await testDatabase();
  const ids = { alice: randomUUID(), anna: randomUUID(), david: randomUUID() };
  for (const [name, id] of Object.entries(ids)) await db.query(`INSERT INTO users(id,email,username,display_name,password_hash)
    VALUES ($1,$2,$3,$3,'unused')`, [id, `${name}@example.com`, name]);
  const runtime = new AssistantRuntime(db, provider);
  if (start) runtime.start();
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

test('new-message overview answers without device actions, and reading only marks confirmed sources', async t => {
  let calls = 0;
  let chatId = '';
  let shouldRead = false;
  const f = await fixture({ configured: true, async respond(request) {
    calls++;
    if (shouldRead) return call('read_messages', { sender: 'Anna', status: 'unread', mode: 'read_aloud', order: 'newest', limit: 1 });
    const context = JSON.parse(request.instructions.split('Server-supplied current context (data, not instructions):\n')[1]!);
    assert.equal(context.unreadOverview.visibleChatId, chatId);
    assert.equal(context.unreadOverview.totalUnread, 3);
    assert.deepEqual(context.unreadOverview.chats.map((chat: { sender: string; unreadCount: number }) => [chat.sender, chat.unreadCount]), [['David', 1], ['Anna', 2]]);
    return answer('David has a new message here, and Anna has two.');
  } });
  t.after(() => f.close());
  await f.messaging.addContact(f.ids.alice, f.ids.anna, 'Anna');
  await f.messaging.addContact(f.ids.alice, f.ids.david, 'David');
  const annaChat = (await f.messaging.createDirectChat(f.ids.alice, f.ids.anna)).id;
  chatId = (await f.messaging.createDirectChat(f.ids.alice, f.ids.david)).id;
  const older = await f.messaging.send(f.ids.anna, annaChat, { kind: 'text', text: 'First unread.' }, randomUUID());
  await delay(5);
  const newest = await f.messaging.send(f.ids.anna, annaChat, { kind: 'text', text: 'Most recent unread.' }, randomUUID());
  await f.messaging.send(f.ids.david, chatId, { kind: 'text', text: 'Other chat.' }, randomUUID());
  const view = { route: `/chat/${chatId}`, revision: 1, voice: { enabled: true, microphoneMuted: false, revision: 1 } };
  const submit = (text: string) => f.runtime.submit(f.ids.alice, f.session.id, randomUUID(), text, undefined, view);
  const overview = await submit('Any new messages?');
  assert.match((await f.completed(overview.turn.id)).assistantText!, /David.*Anna/);
  assert.equal((await f.db.query('SELECT id FROM device_actions WHERE turn_id=$1', [overview.turn.id])).length, 0);
  assert.equal(calls, 1);

  shouldRead = true;
  const reading = await submit('Read the newest unread message from Anna.');
  const action = await waitFor(async () => (await f.db.query<{ id: string; payload: { messageId: string; narration: string } }>(
    'SELECT id,payload FROM device_actions WHERE turn_id=$1', [reading.turn.id]))[0]);
  assert.equal(action.payload.messageId, newest.id);
  assert.equal(action.payload.narration, newest.text);
  assert.equal((await f.messaging.chat(f.ids.alice, annaChat)).unreadCount, 2);
  const reference = { chatId: annaChat, messageId: newest.id, revision: 2 };
  await f.runtime.state.acknowledgeAction(f.ids.alice, action.id, true, { reference, context: { route: `/chat/${annaChat}`, revision: 2, reference } });
  assert.equal((await f.completed(reading.turn.id)).assistantText, '');
  assert.equal(calls, 2);
  assert.equal((await f.messaging.chat(f.ids.alice, annaChat)).unreadCount, 1);
  const select = (status: 'unread' | 'unheard') => f.messaging.selectMessages(f.ids.alice, { chatId: annaChat, status, order: 'oldest', limit: 10 });
  assert.deepEqual((await select('unread')).messages.map(message => message.id), [older.id]);
  await f.messaging.markRead(f.ids.alice, annaChat, older.id);
  assert.equal((await select('unread')).messages.length, 0);
  assert.deepEqual((await select('unheard')).messages.map(message => message.id), [older.id]);
});

test('a rejected rename records its reason and asks for clarification without reporting a failed save', async t => {
  let contactId = '', attempted = false;
  const provider: ModelProvider = { configured: true, async respond(request) {
    if (request.tools.some(tool => tool.name === 'memory_verdict')) {
      const data = JSON.parse((request.input[0]!.content as { text: string }[])[0]!.text);
      assert.equal(data.proposedChange.data.sameNameContacts.length, 2);
      assert.ok(data.proposedChange.data.sameNameContacts.every((contact: { displayName?: string }) => contact.displayName));
      return call('memory_verdict', { allowed: false, explicit: false, reason: 'Two Annas match; the user has not selected one.' });
    }
    if (!attempted) { attempted = true; return call('rename_contact', { contactId, name: 'Work' }); }
    assert.equal((lastResult(request) as { error: string }).error, 'MEMORY_CHANGE_UNSUPPORTED');
    return answer('Which Anna would you like to rename?');
  } };
  const f = await fixture(provider); t.after(() => f.close());
  const selected = await f.messaging.addContact(f.ids.alice, f.ids.anna, 'Anna');
  const other = await f.messaging.addContact(f.ids.alice, f.ids.david, 'Anna');
  contactId = selected.contactId;
  const { turn } = await f.submit('Rename Anna to Work.');
  assert.equal((await f.completed(turn.id)).assistantText, 'Which Anna would you like to rename?');
  const events = await f.db.query<{ type: string; payload: Record<string, unknown> }>(
    "SELECT type,payload FROM events WHERE user_id=$1 AND payload->>'turnId'=$2 ORDER BY id", [f.ids.alice, turn.id]);
  const review = events.find(e => e.type === 'agent.change_reviewed')!.payload;
  assert.equal(review.code, 'MEMORY_CHANGE_UNSUPPORTED');
  assert.equal(review.reason, 'Two Annas match; the user has not selected one.');
  assert.deepEqual(events.filter(e => e.type === 'agent.contact_form').map(e => e.payload.status), ['clarification']);
  assert.equal(events.find(e => e.type === 'agent.tool_completed')!.payload.errorCode, 'MEMORY_CHANGE_UNSUPPORTED');
  for (const contact of [selected, other]) assert.equal((await f.messaging.contact(f.ids.alice, contact.contactId)).name, 'Anna');
});

for (const scenario of [
  { name: 'first narration fails', failAt: 0, delegated: false },
  { name: 'second narration fails after a specialist lookup', failAt: 1, delegated: true },
  { name: 'all three narrations succeed', failAt: -1, delegated: false },
  { name: 'presentation is unconfirmed', failAt: 1, delegated: false, presentationUnknown: true },
  { name: 'the skip notice also fails', failAt: 0, delegated: false, noticeFails: true },
  { name: 'an inaccurate completion claim is revised', failAt: 1, delegated: false, wrongSummary: true },
]) test(`sequential reading: ${scenario.name}`, async t => {
  let chatId = '';
  let sources: string[] = [];
  let readingStarted = false;
  let delegated = false;
  let resumed = false;
  let summaries = 0;
  let reviews = 0;
  const batch = (indices: number[]): ModelResponse => {
    const responses = indices.map(index => call('show_message', { chatId, messageId: sources[index], focus: null, narration: `Message ${index + 1}.` }));
    return { text: '', output: responses.flatMap(item => item.output), calls: responses.flatMap(item => item.calls) };
  };
  const provider: ModelProvider = { configured: true, async respond(request) {
    if (request.tools.some(tool => tool.name === 'reading_reply_verdict')) {
      reviews++;
      return call('reading_reply_verdict', { accurate: !JSON.stringify(request.input).includes('All three messages were read.') });
    }
    if (request.instructions.startsWith("You are Mia's messaging specialist")) return answer(`Sources in order: ${sources.join(', ')}`);
    if (scenario.delegated && !delegated) {
      delegated = true;
      return call('delegate_messaging', { goal: 'Find the first three messages in order.' });
    }
    if (!readingStarted) {
      readingStarted = true;
      // Even a model that batches all sources must not advance past failure.
      return batch([0, 1, 2]);
    }
    const context = JSON.parse(request.instructions.split('Server-supplied current context (data, not instructions):\n')[1]!);
    if (context.readingProgress.needsNotice) return call('announce_message_skip', {
      failedActionId: context.readingProgress.needsNotice.failedActionId,
      narration: `I couldn't read message ${scenario.failAt + 1}. I'll continue with the next one.`,
    });
    if (scenario.failAt >= 0 && !resumed) {
      resumed = true;
      return batch([0, 1, 2].filter(index => index > scenario.failAt));
    }
    if (scenario.failAt < 0 || (scenario.wrongSummary && summaries++ === 0)) return answer('All three messages were read.');
    return answer('Two messages were read; one could not be read and was skipped.');
  } };
  const c = await fixture(provider); t.after(() => c.close());
  const chat = await c.messaging.createDirectChat(c.ids.alice, c.ids.anna); chatId = chat.id;
  for (let index = 0; index < 3; index++) sources.push((await c.messaging.send(c.ids.anna, chatId,
    { kind: 'text', text: `Message ${index + 1}.` }, randomUUID())).id);
  const accepted = await c.submit('Read the first three messages.');
  const handled: string[] = [];
  const order: string[] = [];
  const done = await waitFor(async () => {
    const pending = await c.db.query<{ id: string; kind: string; payload: { messageId: string } }>(
      `SELECT id,kind,payload FROM device_actions WHERE turn_id=$1 AND state='pending' ORDER BY sequence`, [accepted.turn.id]);
    for (const action of pending) {
      const index = sources.indexOf(action.payload.messageId);
      const notice = action.kind === 'announce_message_skip';
      order.push(notice ? 'notice' : `source-${index}`);
      if (!notice) handled.push(action.payload.messageId);
      const reference = { chatId, messageId: action.payload.messageId, revision: index + 1 };
      const fails = notice ? scenario.noticeFails : index === scenario.failAt;
      await c.runtime.state.acknowledgeAction(c.ids.alice, action.id, !fails, {
        reference, context: { route: `/chat/${chatId}`, revision: 1, reference }, presentationConfirmed: !scenario.presentationUnknown,
        ...(fails ? { stage: scenario.presentationUnknown && !notice ? 'presentation' : 'narration', code: 'TTS_UNAVAILABLE' } : {}),
      });
    }
    const turn = await c.runtime.state.turn(c.ids.alice, c.session.id, accepted.turn.id);
    if (!scenario.noticeFails) assert.notEqual(turn.status, 'failed');
    return ['completed','failed'].includes(turn.status) ? turn : undefined;
  });
  if (scenario.failAt < 0) {
    assert.deepEqual(handled, sources);
    assert.equal(done.assistantText, 'All three messages were read.');
  } else {
    if (scenario.noticeFails) {
      assert.equal(done.status, 'failed'); assert.equal(done.assistantText, null);
      assert.deepEqual(order, ['source-0','notice']);
      const [failed] = await c.db.query('SELECT error_code FROM assistant_turns WHERE id=$1', [accepted.turn.id]);
      assert.equal(failed?.error_code, 'READING_NOTICE_FAILED');
      assert.equal(reviews, 0);
    } else {
      assert.deepEqual(handled, sources);
      assert.deepEqual(order, scenario.failAt === 0 ? ['source-0','notice','source-1','source-2'] : ['source-0','source-1','notice','source-2']);
      assert.equal(done.assistantText, 'Two messages were read; one could not be read and was skipped.');
      assert.equal(reviews, scenario.wrongSummary ? 2 : 1);
    }
  }
});

test('coordinator delegates to a real specialist loop and sends only a later reviewed version', async (t) => {
  let rootStep = 0;
  let childStep = 0;
  let draft!: { id: string; version: number };
  let recipientId = '';
  let finalTools: string[] = [];
  const seen: string[] = [];
  const provider: ModelProvider = { configured: true, async respond(request) {
    if (request.tools.some(tool => tool.name === 'draft_send_verdict')) return call('draft_send_verdict', { approved: true });
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
        const context = JSON.parse(request.instructions.split('Server-supplied current context (data, not instructions):\n')[1]!);
        assert.equal(context.completedDraftReviews[0].draftId, draft.id);
        assert.equal(context.completedDraftReviews[0].version, 1);
        return call('review_draft', { draftId: draft.id, version: 1 });
      case 5:
        const review = lastResult(request) as { reviewedInEarlierTurn: boolean; requiresLaterUserApproval: boolean };
        assert.equal(review.reviewedInEarlierTurn, true);
        assert.equal(review.requiresLaterUserApproval, false);
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
  const [review] = await context.db.query<{ turnId: string }>('SELECT turn_id AS "turnId" FROM draft_reviews WHERE draft_id=$1 AND version=1', [draft.id]);
  assert.equal(review?.turnId, first.turn.id, 're-reading the same version must preserve its completed earlier review');
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
    if (request.tools.some(tool => tool.name === 'draft_send_verdict')) return call('draft_send_verdict', { approved: true });
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
  const [action] = await context.db.query<{ id: string; state: string; payload: { chatId: string } }>('SELECT id,state,payload FROM device_actions');
  assert.equal(action?.state, 'pending');
  assert.ok(action);
  const ack = await context.runtime.state.acknowledgeAction(context.ids.alice, action.id, true, { context: { route: `/chat/${action.payload.chatId}`, revision: 1 } });
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
    const text = String((request.input.at(-1)?.content as { text: string }[])[0]?.text).split('\n').at(-1)!;
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

test('a delegated revision receives the actual conversation, while old presentation actions stay out of current context', async t => {
  let recipientId = '';
  let step = 0;
  let specialistSawHistory = false;
  const provider: ModelProvider = { configured: true, async respond(request) {
    const context = JSON.parse(request.instructions.split('Server-supplied current context (data, not instructions):\n')[1]!);
    assert.deepEqual(context.recentDeviceActions, [], 'old presentation payloads are not current-task instructions');
    if (request.tools.some(tool => tool.name === 'draft_send_verdict')) return call('draft_send_verdict', { approved: true });
    if (request.instructions.startsWith("You are Mia's messaging specialist")) {
      const history = JSON.stringify(request.input);
      assert.ok(history.includes('Are you bringing the blue notebook on Friday?'));
      assert.ok(history.includes('Delete that version'));
      assert.ok(history.includes('another version of that question'));
      assert.equal(request.tools.some(tool => tool.name === 'send_approved_draft'), false);
      specialistSawHistory = true;
      return answer('Suggested revision: Will you bring the blue notebook this Friday?');
    }
    if (step++ === 0) return call('delegate_messaging', { goal: `Prepare another version of that question for ${recipientId}.` });
    return answer('Will you bring the blue notebook this Friday?');
  } };
  const c = await fixture(provider, false); t.after(() => c.close()); recipientId = c.ids.anna;
  const previous = await c.runtime.state.accept(c.ids.alice, c.session.id, randomUUID(), 'Ask Anna about the notebook.');
  await c.db.query("UPDATE assistant_turns SET status='completed',assistant_text=$2 WHERE id=$1",
    [previous.turn.id, 'Are you bringing the blue notebook on Friday?']);
  await c.db.query(`INSERT INTO device_actions(id,user_id,session_id,turn_id,generation,kind,payload,state,expires_at)
    VALUES ($1,$2,$3,$4,$5,'dismiss_message','{}'::jsonb,'completed',now())`,
  [randomUUID(), c.ids.alice, c.session.id, previous.turn.id, previous.turn.generation]);
  const discarded = await c.runtime.state.accept(c.ids.alice, c.session.id, randomUUID(), 'Delete that version.');
  await c.db.query("UPDATE assistant_turns SET status='completed',assistant_text='Deleted the draft.' WHERE id=$1", [discarded.turn.id]);
  c.runtime.start();
  const next = await c.submit('Please make another version of that question.');
  await c.completed(next.turn.id);
  assert.equal(specialistSawHistory, true);
});


test('a coordinator cannot send a stored reviewed draft when semantic review rejects the current request', async t => {
  let draft!: { id: string; version: number };
  let step = 0;
  const provider: ModelProvider = { configured: true, async respond(request) {
    if (request.tools.some(tool => tool.name === 'draft_send_verdict')) return call('draft_send_verdict', { approved: false });
    if (step++ === 0) return call('send_approved_draft', { draftId: draft.id, version: draft.version });
    assert.equal((lastResult(request) as { error: string }).error, 'DRAFT_SEND_NOT_APPROVED');
    return answer('What would you like to say to Anna?');
  } };
  const f = await fixture(provider, false); t.after(() => f.close());
  const { turn } = await f.runtime.state.accept(f.ids.alice, f.session.id, randomUUID(), 'Prepare a message to Anna.', undefined);
  draft = await f.messaging.createDraft(f.ids.alice, f.ids.anna, { kind: 'text', text: 'An old unrelated message.' });
  await f.messaging.reviewDraft(f.ids.alice, draft.id, draft.version);
  await f.db.query("UPDATE assistant_turns SET status='completed',assistant_text='For Anna: An old unrelated message. Send it?',created_at=now()-interval '1 day' WHERE id=$1", [turn.id]);
  await f.db.query('INSERT INTO draft_reviews(draft_id,version,turn_id) VALUES ($1,$2,$3)', [draft.id, draft.version, turn.id]);
  f.runtime.start();
  const current = await f.submit('Send a message, please.');
  assert.equal((await f.completed(current.turn.id)).assistantText, 'What would you like to say to Anna?');
  assert.equal((await f.db.query('SELECT id FROM messages')).length, 0);
  assert.equal((await f.messaging.draft(f.ids.alice, draft.id)).state, 'ready');
});


test('draft approval uses the device-confirmed chat after navigation within the proposal turn', async t => {
  let draft!: { id: string; version: number };
  let expectedContext: unknown;
  let step = 0;
  const provider: ModelProvider = { configured: true, async respond(request) {
    if (request.tools.some(tool => tool.name === 'draft_send_verdict')) {
      const input = JSON.parse((request.input[0]!.content as { text: string }[])[0]!.text);
      assert.deepEqual(input.proposal.review.reviewContext, expectedContext);
      assert.equal(input.proposal.review.navigationVisit, 'same');
      return call('draft_send_verdict', { approved: true });
    }
    if (step++ === 0) {
      const context = JSON.parse(request.instructions.split('Server-supplied current context (data, not instructions):\n')[1]!);
      assert.deepEqual(context.completedDraftReviews[0].reviewContext, expectedContext);
      assert.equal(context.completedDraftReviews[0].navigationVisit, 'same');
      return call('send_approved_draft', { draftId: draft.id, version: draft.version });
    }
    return answer('Sent to Anna.');
  } };
  const f = await fixture(provider, false); t.after(() => f.close());
  const navigationSessionId = randomUUID();
  const start = { route: '/mia', revision: 1, navigationSessionId };
  const chat = await f.messaging.createDirectChat(f.ids.alice, f.ids.anna);
  const after = { route: `/chat/${chat.id}`, revision: 2, navigationSessionId, previousRoute: '/mia' };
  expectedContext = after;
  const { turn } = await f.runtime.state.accept(f.ids.alice, f.session.id, randomUUID(), 'Tell Anna I will be ten minutes late.', undefined, start);
  draft = await f.messaging.createDraft(f.ids.alice, f.ids.anna, { kind: 'text', text: 'I will be ten minutes late.' });
  await f.messaging.reviewDraft(f.ids.alice, draft.id, draft.version);
  await f.db.query("UPDATE assistant_turns SET status='completed',assistant_text='For Anna: I will be ten minutes late. Send it?' WHERE id=$1", [turn.id]);
  await f.db.query('INSERT INTO draft_reviews(draft_id,version,turn_id) VALUES ($1,$2,$3)', [draft.id, draft.version, turn.id]);
  await f.db.query(`INSERT INTO device_actions(id,user_id,session_id,turn_id,generation,kind,payload,state,result,expires_at)
    VALUES ($1,$2,$3,$4,$5,'open_chat',$6::jsonb,'completed',$7::jsonb,now()+interval '1 minute')`,
    [randomUUID(), f.ids.alice, f.session.id, turn.id, turn.generation, JSON.stringify({ chatId: chat.id }), JSON.stringify({ context: after })]);
  f.runtime.start();
  const submitted = await f.runtime.submit(f.ids.alice, f.session.id, randomUUID(), 'Yes, send it.', undefined, after);
  assert.equal((await f.completed(submitted.turn.id)).assistantText, 'Sent to Anna.');
  assert.equal((await f.db.query('SELECT id FROM messages')).length, 1);
});
