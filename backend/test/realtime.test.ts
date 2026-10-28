import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import WebSocket from 'ws';
import type { SpeechProvider, RecognitionEvent } from '../src/speech/providers.js';
import { phoneSignIn, testApp } from './helpers.js';
import { MessagingService } from '../src/messaging.js';

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

test('voice onset and noise preserve a spoken reply; a recognized word cancels it while the recognition session stays live', { timeout: 12000 }, async t => {
  let emit!: (event: RecognitionEvent) => void; let synthesisSignal!: AbortSignal; let recognitionClosed = false;
  const speech: SpeechProvider = {
    recognitionConfigured: true, synthesisConfigured: true, transcribe: async () => '',
    async *synthesize(_text, signal) {
      synthesisSignal = signal; yield new Uint8Array(2);
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
    async recognize(_keywords, events) { emit = events; return { write() {}, end() {}, close() { recognitionClosed = true; } }; },
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
  const requestId = randomUUID(); client.send({ type: 'voice.start', requestId, sampleRate: 24000, format: 'pcm_s16le' });
  await client.next('voice.ready');
  emit({ type: 'speechStart', turnId: 1 });
  await client.next('voice.event', frame => (frame.event as { type: string }).type === 'speechStart');
  assert.equal(synthesisSignal.aborted, false);
  emit({ type: 'speechComplete', turnId: 1, transcript: '[noise]' });
  emit({ type: 'speechStart', turnId: 2 });
  emit({ type: 'speechComplete', turnId: 2, transcript: 'the meeting starts at six' });
  await delay(50);
  assert.equal(synthesisSignal.aborted, false); assert.equal(client.frames.some(frame => frame.type === 'voice.interruption'), false);
  emit({ type: 'speechStart', turnId: 3 }); emit({ type: 'speechComplete', turnId: 3, transcript: 'Stop.' });
  const interruption = await client.next('voice.interruption'); assert.equal(interruption.requestId, requestId);
  await client.next('turn.accepted', frame => (frame.turn as { userText: string }).userText === 'Stop.');
  assert.equal(synthesisSignal.aborted, true); assert.equal(recognitionClosed, false);
  emit({ type: 'speechStart', turnId: 4 }); emit({ type: 'speechComplete', turnId: 4, transcript: 'Open David.' });
  await client.next('turn.accepted', frame => (frame.turn as { userText: string }).userText === 'Open David.');
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
  assert.deepEqual(snapshots, [textContext, voiceContext]);
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
