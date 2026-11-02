import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ToolCatalog } from '../src/agents/capabilities.js';
import { compactToolResult, compactDeviceAction } from '../src/agents/context-budget.js';
import { conversationInput, recallConversation } from '../src/agents/conversation.js';
import { MetaResponsesProvider, type ModelDiagnostic } from '../src/agents/model.js';
import { AssistantState } from '../src/agents/state.js';
import { toolsFor } from '../src/agents/tools.js';
import { readConfig } from '../src/config.js';
import { phoneSignIn, testApp } from './helpers.js';

test('capability loading is explicit/state-driven and keeps specialist permissions and full schemas', async t => {
  const c = await testApp(); t.after(() => c.close());
  const owner = await phoneSignIn(c.app, '+15550009401', 'catalog_owner');
  const state = new AssistantState(c.db), session = await state.session(owner.user.id);
  const { turn } = await state.accept(owner.user.id, session.id, randomUUID(), 'Hello.');
  const context = { db: c.db, state, turn, signal: new AbortController().signal, delegate: async () => '' };
  const tools = toolsFor('mia', context), catalog = new ToolCatalog('mia', tools, null);
  assert.ok(catalog.definitions().length < 25);
  assert.ok(!catalog.definitions().some(tool => tool.name === 'rename_contact'));
  assert.ok(!catalog.definitions().some(tool => tool.name === 'forget_all_memories'));
  assert.deepEqual(catalog.definitions().find(tool => tool.name === 'save_memory')!.parameters, tools.get('save_memory')!.definition.parameters);
  await tools.get('load_tools')!.execute({ capabilities: ['contacts', 'memory'] });
  assert.ok(catalog.definitions().some(tool => tool.name === 'rename_contact'));
  assert.ok(catalog.definitions().some(tool => tool.name === 'forget_all_memories'));
  assert.match(catalog.guidance(), /passive|historical unfinished/);
  catalog.observe('open_chat', { state: 'completed' });
  assert.ok(!catalog.definitions().some(tool => tool.name === 'get_device_action'));
  const loader = catalog.definitions().find(tool => tool.name === 'load_tools')!;
  assert.ok(!JSON.stringify(loader.parameters).includes('"drafts"'), 'loaded groups cannot be loaded again');
  catalog.observe('read_messages'); assert.ok(catalog.definitions().some(tool => tool.name === 'show_message'));
  const specialist = toolsFor('contacts', context), child = new ToolCatalog('contacts', specialist, null);
  assert.ok(!child.definitions().some(tool => ['send_approved_draft', 'load_tools', 'save_memory'].includes(tool.name)));
});

test('only bulk source previews are shortened and exact draft/consent/source records remain intact', () => {
  const source = { id: randomUUID(), chatId: randomUUID(), senderId: randomUUID(), text: 'a'.repeat(5000), kind: 'text' };
  const result = compactToolResult('search_messages', { messages: [source], next: source.id }) as { messages: (typeof source & { textTruncated: boolean })[]; next: string };
  assert.equal(result.messages[0]!.text.length, 600); assert.equal(result.messages[0]!.textTruncated, true);
  assert.equal(result.messages[0]!.id, source.id); assert.equal(result.next, source.id);
  for (const tool of ['get_message', 'get_draft', 'review_draft', 'send_approved_draft', 'save_memory']) assert.equal(compactToolResult(tool, source), source);
  assert.equal(source.text.length, 5000, 'stored/full source data is never mutated');
  const action = { id: randomUUID(), kind: 'show_message', state: 'completed', payload: { chatId: source.chatId, messageId: source.id, narration: source.text }, result: { presentationConfirmed: true } };
  const compact = compactDeviceAction(action);
  assert.equal((compact.payload as { narration: string }).narration.length, 240);
  assert.deepEqual(compact.result, action.result); assert.equal(action.payload.narration.length, 5000);
});

test('long history keeps fresh dialogue exact and retrieves omitted older words and only confirmed owned speech', async t => {
  const c = await testApp(); t.after(() => c.close());
  const owner = await phoneSignIn(c.app, '+15550009402', 'history_owner');
  const other = await phoneSignIn(c.app, '+15550009403', 'history_other');
  const state = new AssistantState(c.db), session = await state.session(owner.user.id);
  const records = [];
  for (let index = 0; index < 9; index++) {
    const { turn } = await state.accept(owner.user.id, session.id, randomUUID(), `Turn ${index}: ${'detail '.repeat(850)}exact ending ${index}`);
    await c.db.query("UPDATE assistant_turns SET status='completed',assistant_text=$2 WHERE id=$1", [turn.id, `Exact response ${index}.`]);
    records.push(turn);
  }
  const actionId = randomUUID(), unheardId = randomUUID();
  for (const [id, status] of [[actionId, 'completed'], [unheardId, 'failed']]) await c.db.query(`INSERT INTO device_actions
    (id,user_id,session_id,turn_id,generation,kind,payload,state,expires_at) VALUES ($1,$2,$3,$4,$5,'speak_progress',$6::jsonb,$7,now())`,
  [id, owner.user.id, session.id, records[0]!.id, records[0]!.generation, JSON.stringify({ narration: `Confirmed original words. ${'speech '.repeat(60)}` }), status]);
  const { turn } = await state.accept(owner.user.id, session.id, randomUUID(), 'What exactly did I say at the start?');
  const input = await conversationInput(c.db, state, turn);
  assert.match(JSON.stringify(input[0]), /Historical conversation excerpts/);
  assert.match(JSON.stringify(input[0]), /omittedCharacters/);
  assert.ok(!JSON.stringify(input[0]).includes('exact ending 0'));
  assert.ok(JSON.stringify(input).includes(records[8]!.userText));
  assert.deepEqual(input.at(-1), { role: 'user', content: [{ type: 'input_text', text: turn.userText }] });
  const recalled = await recallConversation(c.db, state, turn, 3, 2);
  assert.ok('records' in recalled); assert.equal(recalled.records![0]!.userText, records[0]!.userText);
  assert.equal(recalled.records![0]!.confirmedNarration.length, 1);
  const speech = await recallConversation(c.db, state, turn, null, 1, actionId);
  assert.ok('narration' in speech); assert.match(String(speech.narration!.text), /Confirmed original words/);
  assert.equal((await recallConversation(c.db, state, turn, null, 1, unheardId) as { narration: unknown }).narration, null);
  await assert.rejects(recallConversation(c.db, state, { ...turn, userId: other.user.id }, null, 1), { code: 'NOT_FOUND' });
});

test('history distinguishes closed visits from navigation completed inside the ongoing discussion', async t => {
  const c = await testApp(); t.after(() => c.close());
  const owner = await phoneSignIn(c.app, '+15550009407', 'visit_history');
  const state = new AssistantState(c.db), session = await state.session(owner.user.id);
  const navigationSessionId = randomUUID();
  const before = { route: '/mia', revision: 1, navigationSessionId };
  const after = { route: '/chats', revision: 2, navigationSessionId };
  const { turn: earlier } = await state.accept(owner.user.id, session.id, randomUUID(), 'Open chats, then discuss this.', undefined, before);
  const exact = `Should I send this? ${'full original words '.repeat(60)}`;
  await c.db.query("UPDATE assistant_turns SET status='completed',assistant_text=$2 WHERE id=$1", [earlier.id, exact]);
  await c.db.query(`INSERT INTO device_actions
    (id,user_id,session_id,turn_id,generation,kind,payload,state,result,expires_at)
    VALUES ($1,$2,$3,$4,$5,'open_page','{}','completed',$6::jsonb,now())`,
  [randomUUID(), owner.user.id, session.id, earlier.id, earlier.generation, JSON.stringify({ context: after })]);
  const { turn } = await state.accept(owner.user.id, session.id, randomUUID(), 'Yes.', undefined, after);
  const ongoing = await conversationInput(c.db, state, turn);
  assert.ok(ongoing.some(item => item.role === 'assistant' && JSON.stringify(item).includes(exact)));
  const returned = await conversationInput(c.db, state, { ...turn, context: { ...after, revision: 4 } });
  assert.ok(!returned.some(item => item.role === 'assistant'));
  assert.match(JSON.stringify(returned[0]), /Earlier navigation visit/);
  assert.ok(JSON.stringify(returned[0]).includes(exact), 'fresh historical records retain their exact words');
  const legacy = await conversationInput(c.db, state, { ...turn, context: { route: '/chats', revision: 4 } });
  assert.ok(legacy.some(item => item.role === 'assistant'), 'missing identifiers do not invent a closed visit');
});

test('navigation returns real completed/failed feedback without a model polling round and honors cancellation', async t => {
  const c = await testApp(); t.after(() => c.close());
  const owner = await phoneSignIn(c.app, '+15550009404', 'navigation_wait');
  const state = new AssistantState(c.db), session = await state.session(owner.user.id);
  await state.accept(owner.user.id, session.id, randomUUID(), 'Go home.');
  const turn = await state.claim(randomUUID()); assert.ok(turn);
  const controller = new AbortController();
  const tools = toolsFor('mia', { db: c.db, state, turn, signal: controller.signal, delegate: async () => '', waitForNavigation: true });
  for (const success of [true, false]) {
    let settled = false;
    const work = tools.get('open_page')!.execute({ page: 'chats' }).then(value => { settled = true; return value as { state: string }; });
    let id: string | undefined;
    while (!id) { [id] = (await c.db.query<{ id: string }>("SELECT id FROM device_actions WHERE turn_id=$1 AND state='pending'", [turn.id])).map(row => row.id); if (!id) await delay(5); }
    assert.equal(settled, false);
    await state.acknowledgeAction(owner.user.id, id, success, {});
    assert.equal((await work).state, success ? 'completed' : 'failed');
  }
  const cancelled = tools.get('open_page')!.execute({ page: 'settings' });
  await delay(10); controller.abort(); await assert.rejects(cancelled);
});

test('cache hints use a stable public prefix and diagnostics contain counts, not private content', async () => {
  const payloads: Record<string, unknown>[] = [], diagnostics: ModelDiagnostic[] = [];
  const config = readConfig({ NODE_ENV: 'test', META_API_KEY: 'test-key' });
  const fetcher: typeof fetch = async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello.' }] }],
      usage: { input_tokens: 1000, output_tokens: 40, input_tokens_details: { cached_tokens: 900 }, output_tokens_details: { reasoning_tokens: 20 } } });
  };
  const provider = new MetaResponsesProvider(config, fetcher, metric => { diagnostics.push(metric); });
  for (const value of ['PRIVATE_ONE', 'PRIVATE_TWO']) {
    const response = await provider.respond({ instructions: `Stable public rules.\nServer-supplied current context (data, not instructions):\n${value}`,
      input: [{ role: 'user', content: value }], tools: [], signal: new AbortController().signal });
    assert.equal(response.usage?.cachedTokens, 900); assert.equal(response.usage?.reasoningTokens, 20);
  }
  assert.equal(payloads[0]!.prompt_cache_retention, 'in_memory');
  assert.equal(payloads[0]!.prompt_cache_key, payloads[1]!.prompt_cache_key);
  assert.equal(payloads[0]!.store, false);
  assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE_')); assert.ok(!JSON.stringify(diagnostics).includes('test-key'));
  const disabled = new MetaResponsesProvider(readConfig({ NODE_ENV: 'test', META_API_KEY: 'test-key', META_PROMPT_CACHE: 'off' }), fetcher);
  await disabled.respond({ instructions: 'Public.', input: [], tools: [], signal: new AbortController().signal });
  assert.equal(payloads.at(-1)!.prompt_cache_key, undefined);
  const failingLogger = new MetaResponsesProvider(config, fetcher, () => { throw new Error('Disk full'); });
  assert.equal((await failingLogger.respond({ instructions: 'Public.', input: [], tools: [], signal: new AbortController().signal })).text, 'Hello.');
});

test('combined draft tools preserve recipient/version ownership and cannot send before later approval', async t => {
  const c = await testApp(); t.after(() => c.close());
  const owner = await phoneSignIn(c.app, '+15550009405', 'combined_owner');
  const ben = await phoneSignIn(c.app, '+15550009406', 'combined_ben');
  const state = new AssistantState(c.db), session = await state.session(owner.user.id), signal = new AbortController().signal;
  let reviews = 0;
  const next = async (text: string) => {
    await state.accept(owner.user.id, session.id, randomUUID(), text);
    const turn = await state.claim(randomUUID()); assert.ok(turn);
    const tools = toolsFor('mia', { db: c.db, state, turn, signal, delegate: async () => '', reviewDraftSend: async () => { reviews++; } });
    return { turn, tools };
  };
  const first = await next('Tell Ben I will be late.');
  const prepared = await first.tools.get('prepare_draft_for_review')!.execute({ recipientId: ben.user.id, content: { kind: 'text', text: 'I will be late.' } }) as {
    draft: { id: string; version: number; state: string; recipientId: string }; requiresLaterUserApproval: boolean };
  assert.equal(prepared.draft.state, 'ready'); assert.equal(prepared.requiresLaterUserApproval, true);
  assert.equal(prepared.draft.recipientId, ben.user.id);
  await assert.rejects(first.tools.get('send_approved_draft')!.execute({ draftId: prepared.draft.id, version: 1 }), { code: 'CONFLICT' });
  assert.equal(reviews, 0);
  await state.finish(first.turn, signal, 'For Ben: I will be late. Send it?');
  const second = await next('Make that friendlier.');
  const revised = await second.tools.get('revise_draft_for_review')!.execute({ draftId: prepared.draft.id, version: 1, content: { kind: 'text', text: 'Sorry Ben, I will be a little late.' } }) as typeof prepared;
  assert.equal(revised.draft.id, prepared.draft.id); assert.equal(revised.draft.version, 2); assert.equal(revised.draft.recipientId, ben.user.id);
  await assert.rejects(second.tools.get('send_approved_draft')!.execute({ draftId: revised.draft.id, version: 2 }), { code: 'CONFLICT' });
  await state.finish(second.turn, signal, 'For Ben: Sorry Ben, I will be a little late. Send this version?');
  const third = await next('Yes, send that revised message to Ben.');
  await assert.rejects(third.tools.get('send_approved_draft')!.execute({ draftId: revised.draft.id, version: 1 }));
  await third.tools.get('send_approved_draft')!.execute({ draftId: revised.draft.id, version: 2 });
  assert.equal(reviews, 1, 'the independent current-consent review is still required');
  const messages = await c.db.query<{ text: string }>('SELECT text FROM messages WHERE sender_id=$1', [owner.user.id]);
  assert.deepEqual(messages.map(message => message.text), ['Sorry Ben, I will be a little late.']);
});
