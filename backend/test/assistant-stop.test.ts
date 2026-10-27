import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AssistantState } from '../src/agents/state.js';
import { phoneSignIn, testApp } from './helpers.js';

test('HTTP stop fences late tools, cancels device actions and allows a fresh turn without a WebSocket', async (t) => {
  let started = false;
  let released = false;
  let modelSignal: AbortSignal | undefined;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let targetId = '';
  const context = await testApp({ provider: { configured: true, async respond(request) {
    if (released) return { text: 'Following your new request.', calls: [], output: [] };
    modelSignal = request.signal; started = true;
    await gate;
    const callId = randomUUID();
    const args = JSON.stringify({ userId: targetId, name: 'Late contact' });
    return { text: '', output: [{ type: 'function_call', call_id: callId, name: 'add_contact', arguments: args }],
      calls: [{ callId, name: 'add_contact', arguments: args }] };
  } } });
  t.after(async () => { release(); await context.close(); });
  const identity = await phoneSignIn(context.app, '+15550000701', 'stop_owner');
  targetId = (await phoneSignIn(context.app, '+15550000702', 'stop_target')).user.id;
  const headers = { authorization: `Bearer ${identity.token}` };
  const session = (await context.app.inject({ method: 'POST', url: '/v1/assistant/sessions', headers })).json<{ id: string }>();
  const accepted = await context.app.inject({ method: 'POST', url: `/v1/assistant/sessions/${session.id}/turns`, headers,
    payload: { clientTurnId: randomUUID(), text: 'Save this person as a contact.' } });
  assert.equal(accepted.statusCode, 202);
  const { turn } = accepted.json<{ turn: { id: string; generation: number } }>();
  for (let attempt = 0; !started && attempt < 300; attempt++) await delay(10);
  assert.equal(started, true);
  const state = new AssistantState(context.db);
  const running = await state.turn(identity.user.id, session.id, turn.id);
  const action = await state.action(running, new AbortController().signal, 'stop_audio', {});
  const stopped = await context.app.inject({ method: 'POST', url: `/v1/assistant/sessions/${session.id}/stop`, headers, payload: {} });
  assert.equal(stopped.statusCode, 200);
  assert.deepEqual(stopped.json(), { sessionId: session.id, generation: turn.generation + 1, stopped: true });
  assert.equal(modelSignal?.aborted, true);
  assert.equal((await state.turn(identity.user.id, session.id, turn.id)).status, 'interrupted');
  assert.equal((await state.acknowledgeAction(identity.user.id, action.id, true, {})).state, 'cancelled');
  await assert.rejects(state.mutate(running, new AbortController().signal, async () => 'late'), { code: 'TURN_SUPERSEDED' });
  release(); released = true;
  const next = await context.app.inject({ method: 'POST', url: `/v1/assistant/sessions/${session.id}/turns`, headers,
    payload: { clientTurnId: randomUUID(), text: 'Follow a new request.' } });
  assert.equal(next.statusCode, 202);
  const nextId = next.json<{ turn: { id: string } }>().turn.id;
  let completed = false;
  for (let attempt = 0; !completed && attempt < 300; attempt++) {
    completed = (await state.turn(identity.user.id, session.id, nextId)).status === 'completed';
    if (!completed) await delay(10);
  }
  assert.equal(completed, true);
  assert.equal((await context.db.query('SELECT id FROM contacts')).length, 0);
});

test('HTTP stop requires authentication and ownership before advancing a generation', async (t) => {
  const context = await testApp(); t.after(() => context.close());
  const owner = await phoneSignIn(context.app, '+15550000703', 'stop_authorized');
  const foreign = await phoneSignIn(context.app, '+15550000704', 'stop_foreign');
  const state = new AssistantState(context.db);
  const session = await state.session(owner.user.id);
  const url = `/v1/assistant/sessions/${session.id}/stop`;
  assert.equal((await context.app.inject({ method: 'POST', url, payload: {} })).statusCode, 401);
  assert.equal((await context.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${foreign.token}` }, payload: {} })).statusCode, 404);
  assert.equal((await state.requireSession(owner.user.id, session.id)).generation, 0);
  const headers = { authorization: `Bearer ${owner.token}` };
  assert.equal((await context.app.inject({ method: 'POST', url, headers, payload: { userId: foreign.user.id } })).statusCode, 400);
  const stopped = await context.app.inject({ method: 'POST', url, headers, payload: {} });
  assert.equal(stopped.statusCode, 200);
  assert.deepEqual(stopped.json(), { sessionId: session.id, generation: 1, stopped: true });
});
