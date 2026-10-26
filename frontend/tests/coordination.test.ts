import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresentationLease, isLiveAction, mergeMessages } from '../src/coordination';
import { floatToPcm, pcmWav } from '../src/audio/wav';
import type { Message } from '../src/types';
test('switching conversation revokes pending acceptance and all older device presentations', () => {
  const lease = new PresentationLease(); const first = lease.begin('anna');
  lease.accept('anna', 'turn-anna'); assert.equal(lease.owns('turn-anna'), true);
  lease.revoke(); lease.accept('anna', 'turn-anna');
  assert.equal(lease.current(first), false); assert.equal(lease.owns('turn-anna'), false);
  lease.begin('david'); lease.accept('anna', 'turn-anna'); assert.equal(lease.owns('turn-anna'), false);
  lease.accept('david', 'turn-david'); assert.equal(lease.owns('turn-david'), true);
});
test('history replay cannot run device actions and expired actions are ignored', () => {
  const now = Date.now(); const event = { id: '1', type: 'device.action_requested', payload: {}, createdAt: new Date(now - 5000).toISOString() };
  assert.equal(isLiveAction(event, now), false);
  assert.equal(isLiveAction({ ...event, createdAt: new Date(now).toISOString() }, now - 1), true);
  assert.equal(isLiveAction({ ...event, createdAt: new Date(now - 19000).toISOString() }, now - 20000), false);
});
test('paginated messages merge and deduplicate without losing newer live messages', () => {
  const message = (id: string, time: string) => ({ id, createdAt: time, chatId: 'a' }) as Message;
  const newest = message('c', '2026-10-27T03:00:00Z'); const old = message('a', '2026-10-27T01:00:00Z'); const middle = message('b', '2026-10-27T02:00:00Z');
  assert.deepEqual(mergeMessages([newest, middle], [old, middle]).map(m => m.id), ['c', 'b', 'a']);
});
test('voice notes encode signed mono Int16 little endian WAV within backend contract', () => {
  const pcm = floatToPcm(new Float32Array([-1, 0, 1, 2])); const bytes = pcmWav(pcm); const view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF'); assert.equal(view.getUint32(4, true) + 8, bytes.length);
  assert.equal(view.getUint16(20, true), 1); assert.equal(view.getUint16(22, true), 1); assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(24, true), 24000); assert.equal(view.getUint32(40, true), 8);
  assert.equal(view.getInt16(44, true), -32768); assert.equal(view.getInt16(48, true), 32767); assert.equal(view.getInt16(50, true), 32767);
  assert.throws(() => pcmWav(new Uint8Array(3)));
});
