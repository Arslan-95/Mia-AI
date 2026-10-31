import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import WebSocket from 'ws';
import type { SpeechProvider, RecognitionEvent } from '../src/speech/providers.js';
import { phoneSignIn, testApp } from './helpers.js';
import { MessagingService } from '../src/messaging.js';
import { AssistantState } from '../src/agents/state.js';
import type { SpeechOptions } from '../src/speech/delivery.js';

type Frame = Record<string, unknown> & { type: string };
async function waitFor<T>(probe: () => T | undefined, timeout = 6000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = probe(); if (result !== undefined) return result;
    await delay(10);
  }
  throw new Error('Timed out waiting for a realtime frame');
}
async function connect(url: string, origin?: string) {
  const socket = new WebSocket(url, origin ? { origin } : {});
  const frames: Frame[] = [];
  socket.on('message', (data) => { frames.push(JSON.parse(data.toString()) as Frame); });
  await once(socket, 'open');
  return { socket, frames, send: (value: unknown) => socket.send(JSON.stringify(value)),
    next: (type: string, predicate: (frame: Frame) => boolean = () => true) => waitFor(() => frames.find((frame) => frame.type === type && predicate(frame))),
    async close() { if (socket.readyState === WebSocket.OPEN) { socket.close(); await once(socket, 'close'); } } };
}

test('running-turn narration synthesizes only the persisted owned action once and rejects superseded or caller-authored speech', async t => {
  const spoken: string[] = [];
  const deliveries: (SpeechOptions | undefined)[] = [];
  const speech: SpeechProvider = { recognitionConfigured: true, synthesisConfigured: true, transcribe: async () => '',
    async *synthesize(text, _signal, options) { spoken.push(text); deliveries.push(options); yield new Uint8Array([0, 0, 0, 0]); },
    async recognize() { return { write() {}, end() {}, close() {} }; } };
  const c = await testApp({ speech }); t.after(() => c.close());
  const owner = await phoneSignIn(c.app, '+15551112201', 'narration_owner');
  const friend = await phoneSignIn(c.app, '+15551112202', 'narration_friend');
  const service = new MessagingService(c.db), state = new AssistantState(c.db);
  const chat = await service.createDirectChat(owner.user.id, friend.user.id);
  const source = await service.send(friend.user.id, chat.id, { kind: 'text', text: 'This exact source is never auto-read.' }, randomUUID());
  const session = await state.session(owner.user.id);
  await state.accept(owner.user.id, session.id, randomUUID(), 'Explain this message.');
  const turn = await state.claim(randomUUID()); assert.ok(turn);
  const delivery = { tone: 'gentle', pace: 'steady', warmth: 'reserved' } as const;
  const action = await state.action(turn, new AbortController().signal, 'show_message', { chatId: chat.id, messageId: source.id, narration: 'Her question refers to your earlier plan.', delivery });
  const url = (await c.app.listen({ host: '127.0.0.1', port: 0 })).replace('http:', 'ws:') + '/v1/realtime';
  const client = await connect(url); t.after(() => client.close());
  client.send({ type: 'auth', token: owner.token, after: '0' }); await client.next('ready');
  const foreign = await connect(url); t.after(() => foreign.close());
  foreign.send({ type: 'auth', token: friend.token, after: '0' }); await foreign.next('ready');
  const stolen = randomUUID(); foreign.send({ type: 'speech.request', requestId: stolen, turnId: turn.id, actionId: action.id });
  assert.equal((await foreign.next('speech.failed', frame => frame.requestId === stolen)).code, 'NOT_FOUND');
  const first = randomUUID(); client.send({ type: 'speech.request', requestId: first, turnId: turn.id, actionId: action.id });
  await client.next('speech.completed', frame => frame.requestId === first);
  assert.deepEqual(spoken, ['Her question refers to your earlier plan.']);
  assert.deepEqual(deliveries, [{ narration: true, delivery }], 'the narration keeps its own persisted delivery');
  const repeat = randomUUID(); client.send({ type: 'speech.request', requestId: repeat, turnId: turn.id, actionId: action.id });
  assert.equal((await client.next('speech.failed', frame => frame.requestId === repeat)).code, 'STALE_SPEECH');
  client.send({ type: 'speech.request', requestId: randomUUID(), turnId: turn.id, text: 'Untrusted caller text' });
  await client.next('error'); assert.equal(spoken.length, 1);
  const late = await state.action(turn, new AbortController().signal, 'show_message', { chatId: chat.id, messageId: source.id, narration: 'Never speak this cancelled segment.' });
  await state.interrupt(owner.user.id, session.id);
  const stale = randomUUID(); client.send({ type: 'speech.request', requestId: stale, turnId: turn.id, actionId: late.id });
  assert.equal((await client.next('speech.failed', frame => frame.requestId === stale)).code, 'STALE_SPEECH');
  assert.equal(spoken.length, 1);
});

test('final speech uses server-owned delivery and rejects caller-provided speech controls', async t => {
  const spoken: { text: string; options?: SpeechOptions }[] = [];
  const speech: SpeechProvider = { recognitionConfigured: true, synthesisConfigured: true, transcribe: async () => '',
    async *synthesize(text, _signal, options) { spoken.push({ text, options }); yield new Uint8Array(4); },
    async recognize() { return { write() {}, end() {}, close() {} }; } };
  const c = await testApp({ speech }); t.after(() => c.close());
  const owner = await phoneSignIn(c.app, '+15551112203', 'delivery_speaker');
  const state = new AssistantState(c.db), session = await state.session(owner.user.id);
  await state.accept(owner.user.id, session.id, randomUUID(), 'Take this gently.');
  const turn = await state.claim(randomUUID()); assert.ok(turn);
  const signal = new AbortController().signal;
  const delivery = { tone: 'gentle', pace: 'unhurried', warmth: 'reserved' } as const;
  await state.setSpeechDelivery(turn, signal, delivery); await state.finish(turn, signal, 'We can take this one step at a time.');
  const url = (await c.app.listen({ host: '127.0.0.1', port: 0 })).replace('http:', 'ws:') + '/v1/realtime';
  const client = await connect(url); t.after(() => client.close());
  client.send({ type: 'auth', token: owner.token, after: '0' }); await client.next('ready');
  client.send({ type: 'speech.request', requestId: randomUUID(), turnId: turn.id, delivery: { tone: 'shout' } });
  await client.next('error'); assert.equal(spoken.length, 0);
  const id = randomUUID(); client.send({ type: 'speech.request', requestId: id, turnId: turn.id });
  await client.next('speech.completed', frame => frame.requestId === id);
  assert.deepEqual(spoken, [{ text: 'We can take this one step at a time.', options: { delivery, narration: false } }]);
});

test('native iPhone API-origin sockets authenticate while foreign browser origins remain rejected', { timeout: 10_000 }, async t => {
  const context = await testApp(); t.after(() => context.close());
  const identity = await phoneSignIn(context.app, '+15550000901', 'native_origin');
  const address = await context.app.listen({ port: 0, host: '127.0.0.1' });
  const url = address.replace('http:', 'ws:') + '/v1/realtime';
  const native = await connect(url, address); t.after(() => native.close());
  native.send({ type: 'auth', token: identity.token, after: '0' });
  const ready = await native.next('ready');
  assert.match(String(ready.replayThrough), /^\d+$/);
  native.send({ type: 'ping' }); await native.next('pong');
  const browser = new WebSocket(url, { origin: 'http://untrusted.example' });
  const closed = await once(browser, 'close');
  assert.equal(closed[0], 1008); assert.equal(closed[1].toString(), 'Origin is not allowed');
  assert.equal((await context.db.query('SELECT id FROM assistant_turns')).length, 0);
});

test('long speech drains bounded writes, survives input mute, and cancels a stalled write without reconnecting', { timeout: 20_000 }, async t => {
  const pcm = new Uint8Array(2_400_000).fill(7);
  const speech: SpeechProvider = {
    recognitionConfigured: true, synthesisConfigured: true, transcribe: async () => '',
    async *synthesize() { yield pcm; },
    async recognize() { return { write() {}, end() {}, close() {} }; },
  };
  const context = await testApp({ speech, provider: { configured: true, respond: async () => ({ text: 'A long spoken answer.', calls: [], output: [] }) } });
  t.after(() => context.close());
  const identity = await phoneSignIn(context.app, '+15550000920', 'long_speech');
  const url = (await context.app.listen({ port: 0, host: '127.0.0.1' })).replace('http:', 'ws:') + '/v1/realtime';
  const client = await connect(url); t.after(() => client.close());
  client.send({ type: 'auth', token: identity.token, after: '0' }); await client.next('ready');
  client.send({ type: 'turn', clientTurnId: randomUUID(), text: 'Explain in detail.' });
  const accepted = await client.next('turn.accepted'); const turnId = (accepted.turn as { id: string }).id;
  await client.next('event', frame => (frame.event as { type: string }).type === 'assistant.completed');
  const voiceRequestId = randomUUID();
  client.send({ type: 'voice.start', requestId: voiceRequestId, sampleRate: 24000, format: 'pcm_s16le' }); await client.next('voice.ready');

  // Model a slow network at the actual server socket boundary. A provider may
  // yield an entire answer at once; a single huge write used to close with 1013.
  const server = [...context.app.websocketServer.clients][0]!;
  const send = server.send.bind(server);
  let queued = 0, maximum = 0, hold = false;
  const held: (() => void)[] = [];
  Object.defineProperty(server, 'bufferedAmount', { configurable: true, get: () => queued });
  server.send = ((data: string, callback?: (error?: Error) => void) => {
    if (JSON.parse(data).type !== 'speech.chunk') { send(data, callback); return; }
    const length = Buffer.byteLength(data); queued += length; maximum = Math.max(maximum, queued);
    send(data, error => {
      const flushed = () => { queued -= length; callback?.(error); };
      if (hold) held.push(flushed); else setTimeout(flushed, 5);
    });
  }) as typeof server.send;
  const requestId = randomUUID(); client.send({ type: 'speech.request', requestId, turnId }); await client.next('speech.chunk');
  client.send({ type: 'voice.mute', requestId: voiceRequestId, muted: true, revision: 1 });
  client.send({ type: 'ping' }); await client.next('pong');
  const completed = await client.next('speech.completed', frame => frame.requestId === requestId);
  const chunks = client.frames.filter(frame => frame.type === 'speech.chunk' && frame.requestId === requestId);
  assert.equal(completed.totalBytes, pcm.length); assert.equal(completed.chunks, chunks.length);
  assert.deepEqual(Buffer.concat(chunks.map(frame => Buffer.from(String(frame.audio), 'base64'))), Buffer.from(pcm));
  assert.ok(maximum < 20_000, `Queued ${maximum} bytes`);
  assert.equal(client.socket.readyState, WebSocket.OPEN);

  hold = true;
  const cancelledId = randomUUID(); client.send({ type: 'speech.request', requestId: cancelledId, turnId });
  await client.next('speech.chunk', frame => frame.requestId === cancelledId);
  client.send({ type: 'speech.cancel' }); await client.next('speech.cancelled', frame => frame.requestId === cancelledId);
  for (const release of held) release();
  await delay(25);
  assert.equal(client.frames.filter(frame => frame.type === 'speech.chunk' && frame.requestId === cancelledId).length, 1);
  assert.equal(client.frames.some(frame => frame.type === 'speech.completed' && frame.requestId === cancelledId), false);
  assert.equal(client.socket.readyState, WebSocket.OPEN);
});

test('voice onset and noise preserve a spoken reply; a recognized word cancels it while the recognition session stays live', { timeout: 12000 }, async t => {
  let emit!: (event: RecognitionEvent) => void; let synthesisSignal!: AbortSignal; let recognitionClosed = false; let audioPackets = 0;
  const speech: SpeechProvider = {
    recognitionConfigured: true, synthesisConfigured: true, transcribe: async () => '',
    async *synthesize(_text, signal) {
      synthesisSignal = signal; yield new Uint8Array(2);
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
    async recognize(_keywords, events) { emit = events; return { write() { audioPackets++; }, end() {}, close() { recognitionClosed = true; } }; },
  };
  const context = await testApp({ speech, provider: { configured: true, respond: async () => ({ text: 'Anna said the meeting starts at six.', calls: [], output: [] }) } });
  t.after(() => context.close());
  const identity = await phoneSignIn(context.app, '+15550000902', 'word_interrupt');
  const url = (await context.app.listen({ port: 0, host: '127.0.0.1' })).replace('http:', 'ws:') + '/v1/realtime';
  const client = await connect(url); t.after(() => client.close());
  client.send({ type: 'auth', token: identity.token, after: '0' }); await client.next('ready');
  client.send({ type: 'turn', clientTurnId: randomUUID(), text: 'Read my message.' });
  const accepted = await client.next('turn.accepted'); const turnId = (accepted.turn as { id: string }).id;
  await client.next('event', frame => (frame.event as { type: string }).type === 'assistant.completed');
  client.send({ type: 'speech.request', requestId: randomUUID(), turnId }); await client.next('speech.chunk');
  const requestId = randomUUID(); client.send({ type: 'voice.start', requestId, sampleRate: 24000, format: 'pcm_s16le', inputProcessing: 'aec-residual-v1' });
  await client.next('voice.ready');
  client.socket.send(new Uint8Array(3840));
  await waitFor(() => audioPackets === 1 ? true : undefined);
  emit({ type: 'speechStart', turnId: 1 });
  await client.next('voice.event', frame => (frame.event as { type: string }).type === 'speechStart');
  assert.equal(synthesisSignal.aborted, false);
  emit({ type: 'speechComplete', turnId: 1, transcript: '[noise]' });
  emit({ type: 'speechStart', turnId: 2 });
  emit({ type: 'speechComplete', turnId: 2, transcript: 'the meeting starts at six' });
  await delay(50);
  assert.equal(synthesisSignal.aborted, false); assert.equal(client.frames.some(frame => frame.type === 'voice.interruption'), false);
  const human = new Uint8Array(3840), pcm = new DataView(human.buffer);
  for (let i = 0; i < human.length / 2; i++) pcm.setInt16(i * 2, Math.round(2000 * Math.sin(i * .1)), true);
  client.socket.send(human); await waitFor(() => audioPackets === 2 ? true : undefined);
  emit({ type: 'speechStart', turnId: 3 }); emit({ type: 'transcript', transcript: 'Stop.', final: false });
  const interruption = await client.next('voice.interruption'); assert.equal(interruption.requestId, requestId);
  assert.equal(synthesisSignal.aborted, true, 'a single stable partial stops playback before endpointing');
  emit({ type: 'speechComplete', turnId: 3, transcript: 'Stop.' });
  await client.next('turn.accepted', frame => (frame.turn as { userText: string }).userText === 'Stop.');
  assert.equal(synthesisSignal.aborted, true); assert.equal(recognitionClosed, false);
  assert.equal(client.frames.filter(frame => frame.type === 'voice.interruption').length, 1);
  client.socket.send(human); await waitFor(() => audioPackets === 3 ? true : undefined);
  emit({ type: 'speechStart', turnId: 4 }); emit({ type: 'speechComplete', turnId: 4, transcript: 'Anna said the meeting starts at six.' });
  await client.next('turn.accepted', frame => (frame.turn as { userText: string }).userText === 'Anna said the meeting starts at six.');
  const interruptions = client.frames.filter(frame => frame.type === 'voice.interruption').length;
  client.socket.send(human); await waitFor(() => audioPackets === 4 ? true : undefined);
  emit({ type: 'speechStart', turnId: 5 }); emit({ type: 'transcript', transcript: 'Open later', final: false });
  await client.next('voice.event', frame => (frame.event as { transcript?: string }).transcript === 'Open later');
  client.send({ type: 'voice.cancel' }); await client.next('voice.cancelled'); await delay(250);
  assert.equal(client.frames.filter(frame => frame.type === 'voice.interruption').length, interruptions, 'cancelled recognition must revoke a pending stable-word timer');
});

test('Mia’s echo during reported playback neither interrupts nor submits a turn, while a person still can', { timeout: 12000 }, async t => {
  let emit!: (event: RecognitionEvent) => void; let synthesisSignal!: AbortSignal; let audioPackets = 0;
  const speech: SpeechProvider = {
    recognitionConfigured: true, synthesisConfigured: true, transcribe: async () => '',
    async *synthesize(_text, signal) {
      synthesisSignal = signal; yield new Uint8Array(2);
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
    async recognize(_keywords, events) { emit = events; return { write() { audioPackets++; }, end() {}, close() {} }; },
  };
  const context = await testApp({ speech, provider: { configured: true, respond: async () => ({ text: 'Anna said the meeting starts at six.', calls: [], output: [] }) } });
  t.after(() => context.close());
  const identity = await phoneSignIn(context.app, '+15550000903', 'echo_filter');
  const url = (await context.app.listen({ port: 0, host: '127.0.0.1' })).replace('http:', 'ws:') + '/v1/realtime';
  const client = await connect(url); t.after(() => client.close());
  client.send({ type: 'auth', token: identity.token, after: '0' }); await client.next('ready');
  client.send({ type: 'turn', clientTurnId: randomUUID(), text: 'Read my message.' });
  const accepted = await client.next('turn.accepted'); const turnId = (accepted.turn as { id: string }).id;
  await client.next('event', frame => (frame.event as { type: string }).type === 'assistant.completed');
  client.send({ type: 'speech.request', requestId: randomUUID(), turnId }); await client.next('speech.chunk');
  const requestId = randomUUID(); client.send({ type: 'voice.start', requestId, sampleRate: 24000, format: 'pcm_s16le', inputProcessing: 'aec-residual-v1' });
  await client.next('voice.ready');
  client.send({ type: 'speech.playback', turnId, playing: true });
  const echo = new Uint8Array(3840), pcm = new DataView(echo.buffer);
  for (let i = 0; i < echo.length / 2; i++) pcm.setInt16(i * 2, Math.round(2000 * Math.sin(i * .1)), true);
  client.socket.send(echo); await waitFor(() => audioPackets === 1 ? true : undefined);
  emit({ type: 'speechStart', turnId: 1 });
  for (const transcript of ['Anna', 'Anna said', 'Anna said the meet']) emit({ type: 'transcript', transcript, final: false });
  emit({ type: 'speechComplete', turnId: 1, transcript: 'Anna said the meeting starts at six.' });
  await client.next('voice.event', frame => (frame.event as { type: string }).type === 'speechComplete'); await delay(300);
  assert.equal(synthesisSignal.aborted, false);
  assert.equal(client.frames.some(frame => frame.type === 'voice.interruption'), false);
  assert.equal(client.frames.filter(frame => frame.type === 'turn.accepted').length, 1, 'echo is not submitted as the person’s turn');
  client.socket.send(echo); await waitFor(() => audioPackets === 2 ? true : undefined);
  emit({ type: 'speechStart', turnId: 2 }); emit({ type: 'transcript', transcript: 'starts at six no open Boris', final: false });
  await client.next('voice.interruption'); assert.equal(synthesisSignal.aborted, true);
  emit({ type: 'speechComplete', turnId: 2, transcript: 'Starts at six. No, open Boris.' });
  await client.next('turn.accepted', frame => (frame.turn as { userText: string }).userText === 'No, open Boris.');
  client.send({ type: 'speech.playback', turnId, playing: false });
});

test('logout immediately revokes matching sockets and pending ASR while preserving another login', { timeout: 12_000 }, async (t) => {
  let recognitionSignal: AbortSignal | undefined;
  const speech: SpeechProvider = {
    recognitionConfigured: true, synthesisConfigured: false,
    transcribe: async () => '', async *synthesize() { yield new Uint8Array(2); },
    recognize: async (_keywords, _events, _failure, signal) => {
      recognitionSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  };
  const context = await testApp({ speech, provider: { configured: true, respond: async () => ({ text: 'Still signed in.', calls: [], output: [] }) } });
  t.after(() => context.close());
  const first = await phoneSignIn(context.app, '+15550000711', 'revocation');
  const second = await phoneSignIn(context.app, '+15550000711');
  const url = (await context.app.listen({ port: 0, host: '127.0.0.1' })).replace('http:', 'ws:') + '/v1/realtime';
  const revoked = await connect(url); t.after(() => revoked.close());
  const sameToken = await connect(url); t.after(() => sameToken.close());
  const valid = await connect(url); t.after(() => valid.close());
  for (const [client, token] of [[revoked, first.token], [sameToken, first.token], [valid, second.token]] as const) {
    client.send({ type: 'auth', token, after: '0' }); await client.next('ready');
  }
  revoked.send({ type: 'voice.start', requestId: randomUUID(), sampleRate: 24000, format: 'pcm_s16le' });
  await waitFor(() => recognitionSignal);
  const closed = once(revoked.socket, 'close');
  const alsoClosed = once(sameToken.socket, 'close');
  const logout = await context.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${first.token}` } });
  assert.equal(logout.statusCode, 204);
  assert.equal((await closed)[0], 1008); assert.equal((await alsoClosed)[0], 1008);
  assert.equal(recognitionSignal?.aborted, true);
  assert.equal((await context.app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${first.token}` } })).statusCode, 401);
  valid.send({ type: 'turn', clientTurnId: randomUUID(), text: 'My other login remains valid.' });
  await valid.next('turn.accepted');
  const turns = await context.db.query<{ text: string }>('SELECT user_text AS text FROM assistant_turns');
  assert.deepEqual(turns.map(turn => turn.text), ['My other login remains valid.']);
});

test('WebSocket commands revalidate sessions revoked outside the current process', { timeout: 10_000 }, async (t) => {
  const context = await testApp({ provider: { configured: true, respond: async () => ({ text: 'Unused.', calls: [], output: [] }) } });
  t.after(() => context.close());
  const identity = await phoneSignIn(context.app, '+15550000712', 'remote_revoke');
  const url = (await context.app.listen({ port: 0, host: '127.0.0.1' })).replace('http:', 'ws:') + '/v1/realtime';
  const client = await connect(url); t.after(() => client.close());
  client.send({ type: 'auth', token: identity.token, after: '0' }); await client.next('ready');
  const closed = once(client.socket, 'close');
  await context.db.query('DELETE FROM auth_sessions WHERE user_id = $1', [identity.user.id]);
  if (client.socket.readyState === WebSocket.OPEN) client.send({ type: 'turn', clientTurnId: randomUUID(), text: 'Rejected after revocation.' });
  assert.equal((await closed)[0], 1008);
  assert.equal((await context.db.query('SELECT id FROM assistant_turns')).length, 0);
});

test('HTTP stop closes existing recognition but leaves a later voice session usable', { timeout: 12_000 }, async (t) => {
  let recognitionClosed = false;
  let recognitionEvent: ((event: RecognitionEvent) => void) | undefined;
  const speech: SpeechProvider = {
    recognitionConfigured: true, synthesisConfigured: false,
    transcribe: async () => '', async *synthesize() { yield new Uint8Array(2); },
    recognize: async (_keywords, onEvent, _failure, signal) => {
      recognitionEvent = onEvent;
      signal.addEventListener('abort', () => { recognitionClosed = true; });
      return { write() {}, end() {}, close() { recognitionClosed = true; } };
    },
  };
  const context = await testApp({ speech, provider: { configured: true, respond: async () => ({ text: 'New voice request.', calls: [], output: [] }) } });
  t.after(() => context.close());
  const identity = await phoneSignIn(context.app, '+15550000713', 'http_stop_voice');
  const url = (await context.app.listen({ port: 0, host: '127.0.0.1' })).replace('http:', 'ws:') + '/v1/realtime';
  const client = await connect(url); t.after(() => client.close());
  client.send({ type: 'auth', token: identity.token, after: '0' });
  const ready = await client.next('ready');
  const firstRequest = randomUUID();
  client.send({ type: 'voice.start', requestId: firstRequest, sampleRate: 24000, format: 'pcm_s16le' });
  await client.next('voice.ready');
  const lateCallback = recognitionEvent;
  const stopped = await context.app.inject({ method: 'POST', url: `/v1/assistant/sessions/${String(ready.sessionId)}/stop`,
    headers: { authorization: `Bearer ${identity.token}` }, payload: {} });
  assert.equal(stopped.statusCode, 200);
  await waitFor(() => recognitionClosed || undefined);
  lateCallback?.({ type: 'speechStart', turnId: 1 });
  lateCallback?.({ type: 'speechComplete', turnId: 1, transcript: 'Obsolete voice request.' });
  const secondRequest = randomUUID();
  client.send({ type: 'voice.start', requestId: secondRequest, sampleRate: 24000, format: 'pcm_s16le' });
  await client.next('voice.ready', frame => frame.requestId === secondRequest);
  recognitionEvent?.({ type: 'speechStart', turnId: 1 });
  recognitionEvent?.({ type: 'speechComplete', turnId: 1, transcript: 'Follow the new voice request.' });
  await client.next('turn.accepted');
  const turns = await context.db.query<{ text: string }>('SELECT user_text AS text FROM assistant_turns');
  assert.deepEqual(turns.map(turn => turn.text), ['Follow the new voice request.']);
});

test('WebSocket text and recognized speech carry authorized route snapshots to the model', { timeout: 12_000 }, async (t) => {
  let recognized: ((event: RecognitionEvent) => void) | undefined;
  let recognitionCalls = 0;
  const snapshots: unknown[] = [];
  const speech: SpeechProvider = {
    recognitionConfigured: true, synthesisConfigured: false,
    transcribe: async () => '', async *synthesize() { yield new Uint8Array(2); },
    recognize: async (_keywords, callback) => {
      recognitionCalls++; recognized = callback;
      return { write() {}, end() {}, close() {} };
    },
  };
  const context = await testApp({ speech, provider: { configured: true, async respond(request) {
    const data = JSON.parse(request.instructions.split('Server-supplied current context (data, not instructions):\n')[1]!) as { clientContext: unknown };
    snapshots.push(data.clientContext);
    return { text: 'The current request is understood.', calls: [], output: [] };
  } } });
  t.after(() => context.close());
  const owner = await phoneSignIn(context.app, '+15550000811', 'socket_context');
  const bob = await phoneSignIn(context.app, '+15550000812', 'socket_bob');
  const carol = await phoneSignIn(context.app, '+15550000813', 'socket_carol');
  const service = new MessagingService(context.db);
  const ownChat = await service.createDirectChat(owner.user.id, bob.user.id);
  const foreignChat = await service.createDirectChat(bob.user.id, carol.user.id);
  const url = (await context.app.listen({ port: 0, host: '127.0.0.1' })).replace('http:', 'ws:') + '/v1/realtime';
  const client = await connect(url); t.after(() => client.close());
  client.send({ type: 'auth', token: owner.token, after: '0' }); await client.next('ready');
  const textContext = { route: `/chat/${ownChat.id}`, revision: 2 };
  client.send({ type: 'turn', clientTurnId: randomUUID(), text: 'Read this conversation.', context: textContext });
  const accepted = await client.next('turn.accepted');
  assert.deepEqual((accepted.turn as { context: unknown }).context, textContext);
  await client.next('event', frame => (frame.event as { type: string }).type === 'assistant.completed');
  client.send({ type: 'voice.start', requestId: randomUUID(), sampleRate: 24000, format: 'pcm_s16le',
    context: { route: `/chat/${foreignChat.id}`, revision: 3 } });
  await client.next('error', frame => (frame.error as { code: string }).code === 'NOT_FOUND');
  assert.equal(recognitionCalls, 0);
  const voiceContext = { route: '/mia', previousRoute: `/chat/${ownChat.id}`, revision: 4 };
  client.send({ type: 'voice.start', requestId: randomUUID(), sampleRate: 24000, format: 'pcm_s16le', context: voiceContext });
  await client.next('voice.ready');
  recognized?.({ type: 'speechStart', turnId: 1 });
  recognized?.({ type: 'speechComplete', turnId: 1, transcript: 'Reply to him.' });
  const voice = await client.next('turn.accepted', frame => (frame.turn as { userText: string }).userText === 'Reply to him.');
  assert.deepEqual((voice.turn as { context: unknown }).context, voiceContext);
  await waitFor(() => snapshots.length === 2 || undefined);
  assert.deepEqual(snapshots, [{ ...textContext, visibleRecipient: {
    id: bob.user.id, username: bob.user.username, displayName: bob.user.displayName,
  } }, voiceContext]);
});

test('live websocket authenticates, replays scoped events and runs only final speech turns', { timeout: 25_000 }, async (t) => {
  let recognitionEvent: ((event: RecognitionEvent) => void) | undefined;
  let recognitionClosed = false;
  const audioFrames: Buffer[] = [];
  const speech: SpeechProvider = {
    recognitionConfigured: true, synthesisConfigured: true,
    async transcribe() { return 'A recorded message.'; },
    async recognize(_keywords, onEvent, _onFailure, signal) {
      recognitionEvent = onEvent;
      signal.addEventListener('abort', () => { recognitionClosed = true; });
      return { write: (audio) => { audioFrames.push(audio); }, end() {}, close() { recognitionClosed = true; } };
    },
    async *synthesize(_text, signal) { signal.throwIfAborted(); yield new Uint8Array([1, 0, 2, 0]); yield new Uint8Array([3, 0]); },
  };
  const context = await testApp({ speech, provider: { configured: true, async respond() {
    return { text: 'Hello, I am Mia.', calls: [], output: [] };
  } } });
  t.after(() => context.close());
  const url = await context.app.listen({ port: 0, host: '127.0.0.1' });
  const wsUrl = `${url.replace('http:', 'ws:')}/v1/realtime`;
  const identity = await phoneSignIn(context.app, '+15550000041', 'realtime');
  const client = await connect(wsUrl);
  t.after(() => client.close());
  client.send({ type: 'auth', token: identity.token, after: '0' });
  const ready = await client.next('ready');
  assert.equal(ready.protocolVersion, 1);
  const sessionId = String(ready.sessionId);
  const headers = { authorization: `Bearer ${identity.token}` };

  client.send({ type: 'turn', clientTurnId: randomUUID(), text: 'Hello Mia.' });
  const accepted = await client.next('turn.accepted');
  const turnId = (accepted.turn as { id: string }).id;
  const completion = await client.next('event', (frame) => (frame.event as { type: string; payload: { turnId?: string } }).type === 'assistant.completed');
  const completedEvent = completion.event as { id: string; payload: { turnId: string } };
  assert.equal(completedEvent.payload.turnId, turnId);
  const speechRequestId = randomUUID();
  client.send({ type: 'speech.request', requestId: speechRequestId, turnId });
  const end = await client.next('speech.completed');
  assert.equal(end.totalBytes, 6);
  assert.deepEqual(client.frames.filter((frame) => frame.type === 'speech.chunk').map((frame) => frame.sequence), [0, 1]);

  const requestId = randomUUID();
  client.send({ type: 'voice.start', requestId, sampleRate: 24000, format: 'pcm_s16le' });
  await client.next('voice.ready');
  client.socket.send(Buffer.alloc(3840));
  await waitFor(() => audioFrames.length ? true : undefined);
  recognitionEvent?.({ type: 'speechStart', turnId: 1 });
  recognitionEvent?.({ type: 'transcript', transcript: 'Open Anna', final: false });
  await client.next('voice.event', (frame) => (frame.event as RecognitionEvent).type === 'transcript');
  assert.equal((await context.db.query('SELECT id FROM assistant_turns')).length, 1);
  recognitionEvent?.({ type: 'speechComplete', turnId: 1, transcript: "Open Anna's chat." });
  await client.next('turn.accepted', (frame) => (frame.turn as { userText: string }).userText === "Open Anna's chat.");
  const turns = await context.db.query<{ userText: string }>('SELECT user_text AS "userText" FROM assistant_turns ORDER BY generation');
  assert.deepEqual(turns.map((turn) => turn.userText), ['Hello Mia.', "Open Anna's chat."]);
  recognitionEvent?.({ type: 'speechComplete', turnId: 1, transcript: "Open Anna's chat." });
  await delay(40);
  assert.equal((await context.db.query('SELECT id FROM assistant_turns')).length, 2);

  recognitionEvent?.({ type: 'speechStart', turnId: 2 });
  recognitionEvent?.({ type: 'speechStart', turnId: 3 });
  recognitionEvent?.({ type: 'speechComplete', turnId: 3, transcript: "Open David's chat." });
  await client.next('voice.event', (frame) => {
    const event = frame.event as RecognitionEvent;
    return event.type === 'speechComplete' && event.turnId === 3;
  });
  assert.equal((await context.db.query('SELECT id FROM assistant_turns')).length, 2);
  recognitionEvent?.({ type: 'speechComplete', turnId: 2, transcript: 'Write Anna a message.' });
  await client.next('turn.accepted', (frame) => (frame.turn as { userText: string }).userText === "Write Anna a message. Open David's chat.");
  assert.equal((await context.db.query('SELECT id FROM assistant_turns')).length, 3);

  client.send({ type: 'voice.cancel' });
  await client.next('voice.cancelled');
  assert.equal(recognitionClosed, true);
  await client.close();
  const replay = await connect(wsUrl);
  t.after(() => replay.close());
  replay.send({ type: 'auth', token: identity.token, after: completedEvent.id });
  await replay.next('ready');
  await replay.next('event');
  for (const frame of replay.frames.filter((frame) => frame.type === 'event')) {
    assert.ok(BigInt((frame.event as { id: string }).id) > BigInt(completedEvent.id));
  }
  const events = await context.app.inject({ url: '/v1/events', headers });
  assert.equal(events.statusCode, 200);
  assert.ok(events.json().length > 0);
  assert.equal(sessionId, String((await context.app.inject({ method: 'POST', url: '/v1/assistant/sessions', headers })).json().id));
});

test('mute keeps recognition connected with synthetic silence and discards speech crossing mute edges', { timeout: 12_000 }, async t => {
  let emit!: (event: RecognitionEvent) => void;
  let opens = 0, closes = 0;
  const packets: Buffer[] = [];
  const speech: SpeechProvider = {
    recognitionConfigured: true, synthesisConfigured: false, transcribe: async () => '',
    async *synthesize() { yield new Uint8Array(2); },
    async recognize(_keywords, events) {
      opens++; emit = events;
      return { write(bytes) { packets.push(Buffer.from(bytes)); }, end() {}, close() { closes++; } };
    },
  };
  const context = await testApp({ speech, provider: { configured: true, respond: async () => ({ text: 'Okay.', calls: [], output: [] }) } });
  t.after(() => context.close());
  const identity = await phoneSignIn(context.app, '+15550000930', 'warm_mute');
  const url = (await context.app.listen({ port: 0, host: '127.0.0.1' })).replace('http:', 'ws:') + '/v1/realtime';
  const client = await connect(url); t.after(() => client.close());
  client.send({ type: 'auth', token: identity.token, after: '0' }); await client.next('ready');
  const requestId = randomUUID();
  client.send({ type: 'voice.start', requestId, sampleRate: 24000, format: 'pcm_s16le' }); await client.next('voice.ready');
  emit({ type: 'speechStart', turnId: 1 });
  emit({ type: 'transcript', transcript: 'Open later', final: false });
  await client.next('voice.event', f => (f.event as RecognitionEvent).type === 'transcript');
  client.send({ type: 'voice.mute', requestId, muted: true, revision: 1 });
  await waitFor(() => packets.length >= 3 ? true : undefined);
  assert.ok(packets.every(packet => packet.every(byte => byte === 0)));
  assert.ok(packets.every(packet => packet.length > 0 && packet.length <= 8192));
  client.socket.send(Buffer.alloc(3840, 7)); // Even a misbehaving muted client cannot send microphone audio upstream.
  emit({ type: 'speechComplete', turnId: 1, transcript: 'Open later.' });
  emit({ type: 'speechStart', turnId: 2, audioProcessedMs: 80 });
  emit({ type: 'speechComplete', turnId: 2, transcript: 'Muted words.' });
  await delay(50);
  assert.ok(packets.every(packet => packet.every(byte => byte === 0)));
  assert.equal(client.frames.some(f => f.type === 'voice.interruption'), false, 'mute cancels stable-word confirmation');
  client.send({ type: 'voice.mute', requestId, muted: false, revision: 2 });
  client.send({ type: 'ping' }); await client.next('pong');
  const packetCount = packets.length;
  await delay(180); assert.equal(packets.length, packetCount, 'unmute stops synthetic silence');
  emit({ type: 'speechComplete', turnId: 1, transcript: 'Late old words.' });
  emit({ type: 'speechStart', turnId: 2, audioProcessedMs: 80 });
  emit({ type: 'speechComplete', turnId: 2, transcript: 'Late muted words.' });
  await delay(30);
  assert.equal((await context.db.query('SELECT id FROM assistant_turns')).length, 0);
  client.socket.send(Buffer.alloc(3840, 9));
  await waitFor(() => packets.length > packetCount ? true : undefined);
  emit({ type: 'speechStart', turnId: 3 });
  emit({ type: 'speechComplete', turnId: 3, transcript: 'Fresh command.' });
  await client.next('turn.accepted', f => (f.turn as { userText: string }).userText === 'Fresh command.');
  assert.equal(opens, 1); assert.equal(closes, 0);
  assert.equal(client.frames.filter(f => f.type === 'voice.ready').length, 1);
  client.send({ type: 'voice.cancel' }); await client.next('voice.cancelled');
  const finalCount = packets.length; await delay(100);
  assert.equal(packets.length, finalCount); assert.equal(closes, 1);
  const oldEmit = emit, nextRequestId = randomUUID();
  client.send({ type: 'voice.start', requestId: nextRequestId, sampleRate: 24000, format: 'pcm_s16le',
    context: { route: '/chats', revision: 0, voice: { enabled: true, microphoneMuted: true, revision: 2 } } });
  await client.next('voice.ready', f => f.requestId === nextRequestId);
  oldEmit({ type: 'speechStart', turnId: 99 });
  client.send({ type: 'voice.mute', requestId: nextRequestId, muted: false, revision: 3 });
  client.send({ type: 'ping' }); await waitFor(() => client.frames.filter(f => f.type === 'pong').length >= 2 ? true : undefined);
  emit({ type: 'speechStart', turnId: 99 });
  emit({ type: 'speechComplete', turnId: 99, transcript: 'New stream command.' });
  await client.next('turn.accepted', f => (f.turn as { userText: string }).userText === 'New stream command.');
});

test('mute during pending recognition startup preserves the stream and latest mute intent', { timeout: 12_000 }, async t => {
  let release!: () => void;
  let signal!: AbortSignal;
  let writes = 0, closes = 0, ended = false;
  const speech: SpeechProvider = {
    recognitionConfigured: true, synthesisConfigured: false, transcribe: async () => '',
    async *synthesize() { yield new Uint8Array(2); },
    async recognize(_keywords, _events, _failure, currentSignal) {
      signal = currentSignal;
      await new Promise<void>(resolve => { release = resolve; });
      return { write() { assert.equal(ended, false, 'no PCM is allowed after endStream'); writes++; }, end() { ended = true; }, close() { closes++; } };
    },
  };
  const context = await testApp({ speech }); t.after(() => context.close());
  const identity = await phoneSignIn(context.app, '+15550000931', 'pending_mute');
  const url = (await context.app.listen({ port: 0, host: '127.0.0.1' })).replace('http:', 'ws:') + '/v1/realtime';
  const client = await connect(url); t.after(() => client.close());
  client.send({ type: 'auth', token: identity.token, after: '0' }); await client.next('ready');
  const requestId = randomUUID();
  client.send({ type: 'voice.start', requestId, sampleRate: 24000, format: 'pcm_s16le' });
  await waitFor(() => signal);
  for (const [index, muted] of [true, false, true].entries()) client.send({ type: 'voice.mute', requestId, muted, revision: index + 1 });
  await delay(30); release();
  await client.next('voice.ready'); await waitFor(() => writes > 0 ? true : undefined);
  assert.equal(signal.aborted, false); assert.equal(closes, 0);
  client.send({ type: 'voice.mute', requestId: randomUUID(), muted: false, revision: 4 });
  const before = writes; await delay(180);
  assert.ok(writes > before, 'a stale request cannot unmute the current stream');
  client.send({ type: 'voice.end' });
  await waitFor(() => ended ? true : undefined);
  const afterEnd = writes; await delay(180);
  assert.equal(writes, afterEnd);
  client.send({ type: 'voice.cancel' }); await client.next('voice.cancelled');
  assert.equal(signal.aborted, true); assert.equal(closes, 1);
});

test('mute aborts recognition queued behind authentication before it can interrupt or submit', { timeout: 12_000 }, async t => {
  let emit!: (event: RecognitionEvent) => void;
  const speech: SpeechProvider = {
    recognitionConfigured: true, synthesisConfigured: false, transcribe: async () => '',
    async *synthesize() { yield new Uint8Array(2); },
    async recognize(_keywords, events) { emit = events; return { write() {}, end() {}, close() {} }; },
  };
  const context = await testApp({ speech, provider: { configured: true, respond: async () => ({ text: 'Okay.', calls: [], output: [] }) } });
  t.after(() => context.close());
  const identity = await phoneSignIn(context.app, '+15550000934', 'queued_mute');
  const url = (await context.app.listen({ port: 0, host: '127.0.0.1' })).replace('http:', 'ws:') + '/v1/realtime';
  const client = await connect(url); t.after(() => client.close());
  client.send({ type: 'auth', token: identity.token, after: '0' }); await client.next('ready');
  const requestId = randomUUID();
  client.send({ type: 'voice.start', requestId, sampleRate: 24000, format: 'pcm_s16le' }); await client.next('voice.ready');
  const query = context.db.query.bind(context.db);
  let release!: () => void, held = false;
  context.db.query = (async (sql, values) => {
    if (!held && sql.includes('FROM auth_sessions s JOIN users')) {
      held = true; await new Promise<void>(resolve => { release = resolve; });
    }
    return query(sql, values);
  }) as typeof context.db.query;
  emit({ type: 'speechStart', turnId: 1 });
  emit({ type: 'speechComplete', turnId: 1, transcript: 'Must never run.' });
  await waitFor(() => release);
  client.send({ type: 'voice.mute', requestId, muted: true, revision: 1 });
  client.send({ type: 'ping' }); await client.next('pong'); release();
  await delay(80);
  assert.equal(client.frames.some(f => f.type === 'voice.interruption' || f.type === 'turn.accepted'), false);
  assert.equal((await context.db.query('SELECT id FROM assistant_turns')).length, 0);
});

test('mute arriving during route authorization applies to the new recognition session', { timeout: 12_000 }, async t => {
  let writes = 0, opens = 0;
  const speech: SpeechProvider = {
    recognitionConfigured: true, synthesisConfigured: false, transcribe: async () => '',
    async *synthesize() { yield new Uint8Array(2); },
    async recognize() { opens++; return { write() { writes++; }, end() {}, close() {} }; },
  };
  const context = await testApp({ speech }); t.after(() => context.close());
  const owner = await phoneSignIn(context.app, '+15550000932', 'authorize_mute');
  const other = await phoneSignIn(context.app, '+15550000933', 'authorize_other');
  const chat = await new MessagingService(context.db).createDirectChat(owner.user.id, other.user.id);
  const url = (await context.app.listen({ port: 0, host: '127.0.0.1' })).replace('http:', 'ws:') + '/v1/realtime';
  const client = await connect(url); t.after(() => client.close());
  client.send({ type: 'auth', token: owner.token, after: '0' }); await client.next('ready');
  const query = context.db.query.bind(context.db);
  let authorize!: () => void;
  context.db.query = (async (sql, values) => {
    if (sql.startsWith('SELECT 1 FROM chat_members')) await new Promise<void>(resolve => { authorize = resolve; });
    return query(sql, values);
  }) as typeof context.db.query;
  const requestId = randomUUID();
  client.send({ type: 'voice.start', requestId, sampleRate: 24000, format: 'pcm_s16le',
    context: { route: `/chat/${chat.id}`, revision: 0, voice: { enabled: true, microphoneMuted: false, revision: 0 } } });
  await waitFor(() => authorize);
  client.send({ type: 'voice.mute', requestId, muted: true, revision: 1 });
  await delay(30); authorize();
  await client.next('voice.ready'); await waitFor(() => writes > 0 ? true : undefined);
  assert.equal(opens, 1);
});

test('websocket rejects unauthenticated commands and disallowed browser origins', { timeout: 10_000 }, async (t) => {
  const context = await testApp(); t.after(() => context.close());
  const url = await context.app.listen({ port: 0, host: '127.0.0.1' });
  const wsUrl = `${url.replace('http:', 'ws:')}/v1/realtime`;
  const client = await connect(wsUrl);
  const closed = once(client.socket, 'close');
  client.send({ type: 'turn', clientTurnId: randomUUID(), text: 'Read messages.' });
  const [code] = await closed; assert.equal(code, 1008);
  const foreign = new WebSocket(wsUrl, { origin: 'https://untrusted.example' });
  const [originCode] = await once(foreign, 'close'); assert.equal(originCode, 1008);
});

test('a new request cancels ASR startup immediately and ignores late recognition callbacks', { timeout: 12_000 }, async (t) => {
  let pendingSignal: AbortSignal | undefined;
  let lateCallback: ((event: RecognitionEvent) => void) | undefined;
  const speech: SpeechProvider = {
    recognitionConfigured: true, synthesisConfigured: false,
    transcribe: async () => '',
    async *synthesize() { yield new Uint8Array(2); },
    recognize: async (_keywords, onEvent, _failure, signal) => {
      pendingSignal = signal; lateCallback = onEvent;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  };
  const context = await testApp({ speech, provider: { configured: true, respond: async () => ({ text: 'Opening the requested chat.', calls: [], output: [] }) } });
  t.after(() => context.close());
  const url = await context.app.listen({ port: 0, host: '127.0.0.1' });
  const { token } = await phoneSignIn(context.app, '+15550000042', 'interrupt');
  const client = await connect(`${url.replace('http:', 'ws:')}/v1/realtime`); t.after(() => client.close());
  client.send({ type: 'auth', token, after: '0' }); await client.next('ready');
  client.send({ type: 'voice.start', requestId: randomUUID(), sampleRate: 24000, format: 'pcm_s16le' });
  await waitFor(() => pendingSignal);
  client.send({ type: 'turn', clientTurnId: randomUUID(), text: "Open David's chat." });
  await client.next('turn.accepted');
  assert.equal(pendingSignal?.aborted, true);
  await client.next('event', (frame) => (frame.event as { type: string }).type === 'assistant.completed');
  lateCallback?.({ type: 'speechStart', turnId: 1 });
  lateCallback?.({ type: 'speechComplete', turnId: 1, transcript: 'Discard the message.' });
  await delay(50);
  const turns = await context.db.query<{ status: string; text: string }>('SELECT status,user_text AS text FROM assistant_turns');
  assert.deepEqual(turns, [{ status: 'completed', text: "Open David's chat." }]);
});
