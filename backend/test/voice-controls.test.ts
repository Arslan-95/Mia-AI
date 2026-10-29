import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { testDatabase } from './helpers.js';
import { AssistantState } from '../src/agents/state.js';
import { toolsFor } from '../src/agents/tools.js';

async function fixture() {
  const db = await testDatabase(), owner = randomUUID();
  await db.query("INSERT INTO users(id,email,username,display_name,password_hash) VALUES ($1,$2,'voice_owner','Voice Owner','unused')", [owner, owner + '@test.local']);
  const state = new AssistantState(db), session = await state.session(owner);
  const context = { route: '/chats', revision: 0, voice: { enabled: true, microphoneMuted: false, revision: 3 } };
  const { turn } = await state.accept(owner, session.id, randomUUID(), 'Go back to the messenger.', undefined, context);
  await db.query("UPDATE assistant_turns SET status='running' WHERE id=$1", [turn.id]);
  const signal = new AbortController().signal;
  const tools = toolsFor('mia', { db, state, turn, signal, delegate: async () => '' });
  return { db, owner, state, session, turn, context, tools, signal };
}
test('voice mode is reported explicitly, while legacy clients have an unknown state', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  assert.deepEqual(await f.tools.get('get_voice_mode')!.execute({}), { reported: true, source: 'request snapshot', ...f.context.voice });
  const legacy = toolsFor('mia', { db: f.db, state: f.state, turn: { ...f.turn, context: { route: '/chats', revision: 0 } }, signal: f.signal, delegate: async () => '' });
  assert.deepEqual(await legacy.get('get_voice_mode')!.execute({}), { reported: false });
  await assert.rejects(legacy.get('set_voice_mode')!.execute({ enabled: false }), { code: 'VOICE_CONTROLS_UNAVAILABLE' });
  assert.equal((await f.db.query('SELECT id FROM device_actions')).length, 0);
});
test('a mode change awaits actual phone confirmation and rejects missing or contradictory success feedback', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const first = await f.tools.get('set_voice_mode')!.execute({ enabled: false }) as { confirmationRequired: boolean };
  assert.equal(first.confirmationRequired, true);
  await f.tools.get('set_voice_mode')!.execute({ enabled: false });
  assert.equal((await f.db.query('SELECT id FROM device_actions')).length, 0, 'same-turn retries cannot bypass the later answer');
  await f.state.finish(f.turn, f.signal, 'Are you sure you want to leave hands-free voice mode?');
  const { turn } = await f.state.accept(f.owner, f.session.id, randomUUID(), 'Yes, leave voice mode.', undefined, f.context);
  await f.db.query("UPDATE assistant_turns SET status='running' WHERE id=$1", [turn.id]);
  const tools = toolsFor('mia', { db: f.db, state: f.state, turn, signal: f.signal, delegate: async () => '', reviewVoiceExit: async () => true });
  const requested = tools.get('set_voice_mode')!.execute({ enabled: false });
  let actionId = '';
  for (let n = 0; n < 100 && !actionId; n++) { const [row] = await f.db.query<{ id: string }>("SELECT id FROM device_actions WHERE kind='set_voice_mode'"); actionId = row?.id ?? ''; if (!actionId) await delay(10); }
  assert.ok(actionId);
  await assert.rejects(f.state.acknowledgeAction(f.owner, actionId, true, {}), { code: 'CONFLICT' });
  await assert.rejects(f.state.acknowledgeAction(f.owner, actionId, true, { voice: f.context.voice }), { code: 'CONFLICT' });
  const voice = { enabled: false, microphoneMuted: false, revision: 4 };
  await f.state.acknowledgeAction(f.owner, actionId, true, { voice, context: { ...f.context, voice } });
  const result = await requested as { state: string; result: { voice: unknown } };
  assert.equal(result.state, 'completed'); assert.deepEqual(result.result.voice, voice);
  assert.deepEqual(await tools.get('get_voice_mode')!.execute({}), { reported: true, source: 'device confirmation', ...voice });
  assert.equal((await f.state.turn(f.owner, f.session.id, turn.id)).status, 'running', 'an applied exit must allow the final agent reply to complete');
});

test('activation is Settings-only; denied or stale exit approval never produces a phone action', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await assert.rejects(f.tools.get('set_voice_mode')!.execute({ enabled: true }), { code: 'VOICE_ENABLE_SETTINGS_ONLY' });
  await f.tools.get('set_voice_mode')!.execute({ enabled: false });
  await f.state.finish(f.turn, f.signal, 'Are you sure you want to leave hands-free voice mode?');
  const { turn } = await f.state.accept(f.owner, f.session.id, randomUUID(), 'No, keep helping me.', undefined, f.context);
  await f.db.query("UPDATE assistant_turns SET status='running' WHERE id=$1", [turn.id]);
  const tools = toolsFor('mia', { db: f.db, state: f.state, turn, signal: f.signal, delegate: async () => '', reviewVoiceExit: async () => false });
  await assert.rejects(tools.get('set_voice_mode')!.execute({ enabled: false }), { code: 'VOICE_EXIT_NOT_CONFIRMED' });
  await f.state.finish(turn, f.signal, 'I will stay in voice mode.');
  const later = (await f.state.accept(f.owner, f.session.id, randomUUID(), 'Yes.', undefined, f.context)).turn;
  await f.db.query("UPDATE assistant_turns SET status='running' WHERE id=$1", [later.id]);
  const lateTools = toolsFor('mia', { db: f.db, state: f.state, turn: later, signal: f.signal, delegate: async () => '', reviewVoiceExit: async question => {
    assert.equal(question.assistantText, 'I will stay in voice mode.', 'review the latest reply, not the old exit question');
    return false;
  } });
  await assert.rejects(lateTools.get('set_voice_mode')!.execute({ enabled: false }), { code: 'VOICE_EXIT_NOT_CONFIRMED' });
  assert.equal((await f.db.query('SELECT id FROM device_actions')).length, 0);
});

test('separate approval of a repeated question uses the latest reply and consumes the original request once', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.tools.get('set_voice_mode')!.execute({ enabled: false });
  await f.state.finish(f.turn, f.signal, 'Are you sure you want to leave voice mode?');
  for (const text of ['I did not hear you. Repeat that question.', 'Please ask me that once more.']) {
    const repeated = (await f.state.accept(f.owner, f.session.id, randomUUID(), text, undefined, f.context)).turn;
    await f.db.query("UPDATE assistant_turns SET status='running' WHERE id=$1", [repeated.id]);
    await f.state.finish(repeated, f.signal, 'Do you want me to switch off hands-free voice assistance?');
  }
  const turn = (await f.state.accept(f.owner, f.session.id, randomUUID(), 'Yes, leave voice mode.', undefined, f.context)).turn;
  await f.db.query("UPDATE assistant_turns SET status='running' WHERE id=$1", [turn.id]);
  const tools = toolsFor('mia', { db: f.db, state: f.state, turn, signal: f.signal, delegate: async () => '', reviewVoiceExit: async question => {
    assert.deepEqual({ userText: question.userText, assistantText: question.assistantText }, {
      userText: 'Please ask me that once more.', assistantText: 'Do you want me to switch off hands-free voice assistance?',
    });
    return true;
  } });
  const requested = tools.get('set_voice_mode')!.execute({ enabled: false });
  let actionId: string | undefined;
  for (let n = 0; n < 100 && !actionId; n++) {
    actionId = (await f.db.query<{ id: string }>('SELECT id FROM device_actions WHERE turn_id=$1', [turn.id]))[0]?.id;
    if (!actionId) await delay(10);
  }
  assert.ok(actionId);
  const voice = { enabled: false, microphoneMuted: false, revision: 4 };
  await f.state.acknowledgeAction(f.owner, actionId, true, { voice, context: { ...f.context, voice } });
  assert.equal((await requested as { state: string }).state, 'completed');
  const [request] = await f.db.query('SELECT request_turn_id,consumed_by FROM voice_exit_requests');
  assert.equal(request!.request_turn_id, f.turn.id); assert.equal(request!.consumed_by, turn.id);
  assert.equal((await f.db.query('SELECT id FROM device_actions')).length, 1);
  await tools.get('set_voice_mode')!.execute({ enabled: false });
  assert.equal((await f.db.query('SELECT id FROM device_actions')).length, 1, 'same-turn retries cannot reuse consent');
});

test('exit confirmation expires and changing voice revision requires a fresh question', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.tools.get('set_voice_mode')!.execute({ enabled: false });
  await f.state.finish(f.turn, f.signal, 'Are you sure you want to leave voice mode?');
  await f.db.query("UPDATE voice_exit_requests SET expires_at=now()-interval '1 second'");
  const { turn } = await f.state.accept(f.owner, f.session.id, randomUUID(), 'Yes.', undefined, f.context);
  await f.db.query("UPDATE assistant_turns SET status='running' WHERE id=$1", [turn.id]);
  const tools = toolsFor('mia', { db:f.db,state:f.state,turn,signal:f.signal,delegate:async()=>'',reviewVoiceExit:async()=>{throw new Error('Expired consent must not reach review');} });
  assert.equal((await tools.get('set_voice_mode')!.execute({enabled:false}) as {confirmationRequired:boolean}).confirmationRequired,true);
  await f.state.finish(turn,f.signal,'Are you sure you want to leave voice mode?');
  const changed = (await f.state.accept(f.owner,f.session.id,randomUUID(),'Yes.',undefined,{...f.context,voice:{...f.context.voice,revision:4}})).turn;
  await f.db.query("UPDATE assistant_turns SET status='running' WHERE id=$1",[changed.id]);
  const changedTools=toolsFor('mia',{db:f.db,state:f.state,turn:changed,signal:f.signal,delegate:async()=>'',reviewVoiceExit:async()=>{throw new Error('Changed controls must not reach review');}});
  assert.equal((await changedTools.get('set_voice_mode')!.execute({enabled:false}) as {confirmationRequired:boolean}).confirmationRequired,true);
  assert.equal((await f.db.query('SELECT id FROM device_actions')).length,0);
});

test('an interrupted repeat cannot authorize exit even when the original request is still valid', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.tools.get('set_voice_mode')!.execute({ enabled: false });
  await f.state.finish(f.turn, f.signal, 'Are you sure you want to leave voice mode?');
  const repeated = (await f.state.accept(f.owner, f.session.id, randomUUID(), 'Repeat the question.', undefined, f.context)).turn;
  await f.db.query("UPDATE assistant_turns SET status='interrupted' WHERE id=$1", [repeated.id]);
  const turn = (await f.state.accept(f.owner, f.session.id, randomUUID(), 'Yes.', undefined, f.context)).turn;
  await f.db.query("UPDATE assistant_turns SET status='running' WHERE id=$1", [turn.id]);
  const tools = toolsFor('mia', { db: f.db, state: f.state, turn, signal: f.signal, delegate: async () => '',
    reviewVoiceExit: async () => { throw new Error('An interrupted reply must not reach consent review'); } });
  assert.equal((await tools.get('set_voice_mode')!.execute({ enabled: false }) as { confirmationRequired: boolean }).confirmationRequired, true);
  assert.equal((await f.db.query('SELECT id FROM device_actions')).length, 0);
});
test('microphone changes are separate device actions and stale actions cannot complete after a newer request', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const action = await f.state.action(f.turn, f.signal, 'set_microphone_muted', { muted: true });
  const voice = { ...f.context.voice, microphoneMuted: true, revision: 4 };
  await f.state.acknowledgeAction(f.owner, action.id, true, { voice, context: { ...f.context, voice } });
  const pending = await f.state.action(f.turn, f.signal, 'set_voice_mode', { enabled: false });
  await f.state.accept(f.owner, f.session.id, randomUUID(), 'Keep voice mode on.');
  const result = await f.state.acknowledgeAction(f.owner, pending.id, true, { voice: { ...voice, enabled: false } });
  assert.equal(result.state, 'cancelled');
  assert.equal((await f.db.query('SELECT id FROM assistant_memories')).length, 0);
});
