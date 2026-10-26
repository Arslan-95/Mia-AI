import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import WebSocket from 'ws';
import type { SpeechProvider, RecognitionEvent } from '../src/speech/providers.js';
import { testApp } from './helpers.js';

type Frame = Record<string, unknown> & { type: string };
async function waitFor<T>(probe: () => T | undefined, timeout = 6000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = probe(); if (result !== undefined) return result;
    await delay(10);
  }
  throw new Error('Timed out waiting for a realtime frame');
}
async function connect(url: string) {
  const socket = new WebSocket(url);
  const frames: Frame[] = [];
  socket.on('message', (data) => { frames.push(JSON.parse(data.toString()) as Frame); });
  await once(socket, 'open');
  return { socket, frames, send: (value: unknown) => socket.send(JSON.stringify(value)),
    next: (type: string, predicate: (frame: Frame) => boolean = () => true) => waitFor(() => frames.find((frame) => frame.type === type && predicate(frame))),
    async close() { if (socket.readyState === WebSocket.OPEN) { socket.close(); await once(socket, 'close'); } } };
}

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
  const auth = await context.app.inject({ method: 'POST', url: '/v1/auth/register', payload: {
    email: 'realtime@example.com', username: 'realtime', displayName: 'Realtime', password: 'A-strong-test-password',
  } });
  assert.equal(auth.statusCode, 201, auth.body);
  const identity = auth.json() as { token: string; user: { id: string } };
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
  const registration = await context.app.inject({ method: 'POST', url: '/v1/auth/register', payload: {
    email: 'interrupt@example.com', username: 'interrupt', displayName: 'Interrupt', password: 'A-strong-test-password',
  } });
  const token = (registration.json() as { token: string }).token;
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
