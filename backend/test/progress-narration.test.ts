import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AssistantState } from '../src/agents/state.js';
import { conversationInput } from '../src/agents/conversation.js';
import type { ModelResponse } from '../src/agents/model.js';
import { phoneSignIn, testApp } from './helpers.js';

const call = (text: string, name = 'list_contacts'): ModelResponse => {
  const callId = randomUUID(), args = name === 'get_voice_mode' ? {} : { query: '' };
  return { text, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) }], calls: [{ callId, name, arguments: JSON.stringify(args) }] };
};
async function until(probe: () => Promise<boolean>) {
  const end = Date.now() + 6000;
  while (!await probe()) { if (Date.now() > end) throw new Error('Timed out'); await delay(10); }
}

test('model-authored progress is published before tools, never blocks them, and is optional without voice mode', async t => {
  let calls = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const c = await testApp({ provider: { configured: true, async respond() {
    if (++calls === 1) return call('I will find your saved contact.');
    await held; return { text: 'Your contact is Ben.', calls: [], output: [] };
  } } });
  t.after(() => { release(); return c.close(); });
  const owner = await phoneSignIn(c.app, '+15550009901', 'progress_owner');
  const state = new AssistantState(c.db), session = await state.session(owner.user.id);
  const response = await c.app.inject({ method: 'POST', url: `/v1/assistant/sessions/${session.id}/turns`,
    headers: { authorization: `Bearer ${owner.token}` }, payload: { clientTurnId: randomUUID(), text: 'Find Ben.',
      context: { route: '/mia', revision: 0, voice: { enabled: true, microphoneMuted: false, revision: 0 } } } });
  assert.equal(response.statusCode, 202);
  const turnId = response.json().turn.id;
  await until(async () => calls === 2);
  const events = await c.db.query<{ type: string; payload: { kind?: string; tool?: string } }>('SELECT type,payload FROM events WHERE user_id=$1 ORDER BY id', [owner.user.id]);
  const progress = events.findIndex(e => e.payload.kind === 'speak_progress');
  const tool = events.findIndex(e => e.type === 'agent.tool_completed' && e.payload.tool === 'list_contacts');
  assert.ok(progress >= 0 && tool > progress, 'the lookup finishes while narration has no phone acknowledgement');
  const [action] = await c.db.query<{ state: string; payload: { narration: string } }>("SELECT state,payload FROM device_actions WHERE turn_id=$1 AND kind='speak_progress'", [turnId]);
  assert.equal(action?.payload.narration, 'I will find your saved contact.'); assert.equal(action.state, 'pending');
  release();
  await until(async () => (await state.turn(owner.user.id, session.id, turnId)).status === 'completed');
  calls = 0;
  const next = await c.app.inject({ method: 'POST', url: `/v1/assistant/sessions/${session.id}/turns`, headers: { authorization: `Bearer ${owner.token}` }, payload: { clientTurnId: randomUUID(), text: 'Find Ben.' } });
  await until(async () => (await state.turn(owner.user.id, session.id, next.json().turn.id)).status === 'completed');
  assert.equal((await c.db.query("SELECT id FROM device_actions WHERE turn_id=$1 AND kind='speak_progress'", [next.json().turn.id])).length, 0);
});

test('repeated, oversized and excess progress is suppressed without changing tool execution', async t => {
  const updates = ['Looking for Ben.', 'Looking for Ben.', 'x'.repeat(281), 'Checking the result.', 'Preparing the draft.', 'Another unnecessary update.'];
  let calls = 0;
  const c = await testApp({ provider: { configured: true, async respond() {
    return calls < updates.length ? call(updates[calls++]!) : { text: 'Done.', calls: [], output: [] };
  } } }); t.after(() => c.close());
  const owner = await phoneSignIn(c.app, '+15550009902', 'bounded_progress');
  const state = new AssistantState(c.db), session = await state.session(owner.user.id);
  const response = await c.app.inject({ method: 'POST', url: `/v1/assistant/sessions/${session.id}/turns`, headers: { authorization: `Bearer ${owner.token}` },
    payload: { clientTurnId: randomUUID(), text: 'Help with Ben.', context: { route: '/mia', revision: 0, voice: { enabled: true, microphoneMuted: false, revision: 0 } } } });
  const id = response.json().turn.id;
  await until(async () => (await state.turn(owner.user.id, session.id, id)).status === 'completed');
  const actions = await c.db.query<{ payload: { narration: string } }>("SELECT payload FROM device_actions WHERE turn_id=$1 AND kind='speak_progress' ORDER BY sequence", [id]);
  assert.deepEqual(actions.map(a => a.payload.narration), ['Looking for Ben.', 'Checking the result.', 'Preparing the draft.']);
  const tools = await c.db.query("SELECT id FROM events WHERE type='agent.tool_completed' AND payload->>'turnId'=$1", [id]);
  assert.equal(tools.length, updates.length);
});

test('progress speech is owned, single-use and running-only; history contains only confirmed playback', async t => {
  const c = await testApp(); t.after(() => c.close());
  const owner = await phoneSignIn(c.app, '+15550009903', 'owned_progress');
  const foreign = await phoneSignIn(c.app, '+15550009904', 'foreign_progress');
  const state = new AssistantState(c.db), session = await state.session(owner.user.id), signal = new AbortController().signal;
  await state.accept(owner.user.id, session.id, randomUUID(), 'Find Ben.');
  const turn = await state.claim(randomUUID()); assert.ok(turn);
  const create = (narration: string) => state.action(turn, signal, 'speak_progress', { narration });
  const spoken = await create('I will look for Ben.');
  await assert.rejects(state.actionSpeech(foreign.user.id, session.id, turn.id, spoken.id), { code: 'NOT_FOUND' });
  assert.equal((await state.actionSpeech(owner.user.id, session.id, turn.id, spoken.id)).text, 'I will look for Ben.');
  await assert.rejects(state.actionSpeech(owner.user.id, session.id, turn.id, spoken.id), { code: 'STALE_SPEECH' });
  await state.acknowledgeAction(owner.user.id, spoken.id, true, {});
  const unheard = await create('Unheard progress.');
  const expired = await create('Expired progress.');
  await c.db.query("UPDATE device_actions SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
  await assert.rejects(state.actionSpeech(owner.user.id, session.id, turn.id, expired.id), { code: 'STALE_SPEECH' });
  await state.finish(turn, signal, 'Ben is saved.');
  await assert.rejects(state.actionSpeech(owner.user.id, session.id, turn.id, unheard.id), { code: 'STALE_SPEECH' });
  const { turn: next } = await state.accept(owner.user.id, session.id, randomUUID(), 'What did you say?');
  const history = JSON.stringify(await conversationInput(c.db, state, next));
  assert.ok(history.includes('I will look for Ben.')); assert.ok(!history.includes('Unheard progress.'));
  await assert.rejects(state.actionSpeech(owner.user.id, session.id, turn.id, unheard.id), { code: 'STALE_SPEECH' });
});
