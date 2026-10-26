import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { listEvents, publish } from '../src/events.js';
import { testDatabase } from './helpers.js';

test('events for one user cannot commit out of cursor order across concurrent writers', async (t) => {
  const db = await testDatabase(); t.after(() => db.close());
  const userId = randomUUID();
  await db.query(`INSERT INTO users(id,email,username,display_name,password_hash)
    VALUES ($1,'events@example.com','events','Events','unused')`, [userId]);
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const first = db.transaction(async (sql) => {
    await publish(sql, userId, 'first', {});
    started?.(); await gate;
  });
  await firstStarted;
  let secondCommitted = false;
  const second = db.transaction(async (sql) => { await publish(sql, userId, 'second', {}); }).then(() => { secondCommitted = true; });
  try {
    await delay(60);
    assert.equal(secondCommitted, false, 'A later event must not overtake an uncommitted event for the same user');
  } finally { release?.(); }
  await Promise.all([first, second]);
  const events = await listEvents(db, userId);
  assert.deepEqual(events.map((event) => event.type), ['first', 'second']);
  const replay = await listEvents(db, userId, events[0]!.id);
  assert.deepEqual(replay.map((event) => event.type), ['second']);
});
