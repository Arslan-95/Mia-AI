import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Realtime } from '../src/realtime';
import type { Session } from '../src/types';
class Socket {
  static OPEN = 1; static instances: Socket[] = []; readyState = 1; sent: string[] = [];
  onopen?: () => void; onclose?: () => void; onerror?: () => void; onmessage?: (event: { data: string }) => void;
  constructor(public url: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(data); } close() { this.readyState = 3; this.onclose?.(); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const session = { user: { id: 'user' }, token: 'token' } as Session;
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
test('realtime waits for ready and persists only successfully processed events, in order', async () => {
  const original = globalThis.WebSocket; globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const persisted: string[] = []; const handled: string[] = []; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const realtime = new Realtime('http://localhost:8082', session, async event => { if (event.id === '2') await gate; handled.push(event.id); }, () => {}, () => {}, { get: async () => '1', set: async (_, value) => { persisted.push(value); } });
  try {
    await realtime.connect(); const socket = Socket.instances.at(-1)!; socket.onopen?.();
    assert.deepEqual(JSON.parse(socket.sent[0]!), { type: 'auth', token: 'token', after: '1' });
    assert.equal(realtime.send({ type: 'assistant.stop' }), false);
    socket.receive({ type: 'ready' }); await settle(); assert.equal(realtime.send({ type: 'assistant.stop' }), true);
    socket.receive({ type: 'event', event: { id: '2' } }); socket.receive({ type: 'event', event: { id: '3' } });
    await settle(); assert.deepEqual(persisted, []); release(); await settle(); assert.deepEqual(handled, ['2', '3']); assert.deepEqual(persisted, ['2', '3']);
  } finally { realtime.dispose(); globalThis.WebSocket = original; }
});
test('failed event handling leaves cursor unchanged for replay', async () => {
  const original = globalThis.WebSocket; globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const persisted: string[] = [];
  const realtime = new Realtime('http://localhost:8082', session, async () => { throw new Error('Temporary failure'); }, () => {}, () => {}, { get: async () => '9', set: async (_, value) => { persisted.push(value); } });
  try { await realtime.connect(); Socket.instances.at(-1)!.receive({ type: 'event', event: { id: '10' } }); await settle(); assert.deepEqual(persisted, []); }
  finally { realtime.dispose(); globalThis.WebSocket = original; }
});

test('the server replay boundary identifies history independently of device clock skew', async () => {
  const original = globalThis.WebSocket; globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const seen: { id: string; replayed?: boolean }[] = [];
  const realtime = new Realtime('http://localhost:8082', session,
    async (event, _connectedAt, replayed) => { seen.push({ id: event.id, replayed }); }, () => {}, () => {},
    { get: async () => '0', set: async () => {} });
  try {
    await realtime.connect(); const socket = Socket.instances.at(-1)!;
    socket.receive({ type: 'ready', replayThrough: '118' });
    socket.receive({ type: 'event', event: { id: '118', createdAt: '2099-01-01T00:00:00Z' } });
    socket.receive({ type: 'event', event: { id: '119', createdAt: '2000-01-01T00:00:00Z' } });
    await settle();
    assert.deepEqual(seen, [{ id: '118', replayed: true }, { id: '119', replayed: false }]);
  } finally { realtime.dispose(); globalThis.WebSocket = original; }
});
