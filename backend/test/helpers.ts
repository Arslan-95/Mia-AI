import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Database, Row, Sql } from '../src/db/database.js';
import { PostgresDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import assert from 'node:assert/strict';
import type { User } from '../src/auth.js';

export async function phoneSignIn(app: FastifyInstance, phoneNumber: string, username?: string) {
  const challenge = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phoneNumber } });
  assert.equal(challenge.statusCode, 202, challenge.body);
  const result = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify',
    payload: { challengeId: challenge.json().challengeId, code: '123456' } });
  assert.equal(result.statusCode, 200, result.body);
  const session = result.json() as { token: string; expiresAt: string; user: User };
  if (username) {
    const profile = await app.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${session.token}` },
      payload: { username, displayName: username } });
    assert.equal(profile.statusCode, 200, profile.body);
    session.user = profile.json() as User;
  }
  return session;
}

export async function testDatabase(): Promise<Database> {
  if (process.env.TEST_DATABASE_URL) {
    const admin = new PostgresDatabase(process.env.TEST_DATABASE_URL);
    const schema = `mia_test_${randomUUID().replaceAll('-', '')}`;
    if (!/^mia_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid test schema');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const database = new PostgresDatabase(url.toString());
    const close = async () => {
      await database.close();
      try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await admin.close(); }
    };
    try { await migrate(database); }
    catch (error) { await close(); throw error; }
    return { query: database.query.bind(database), transaction: database.transaction.bind(database), close };
  }
  const pg = new PGlite();
  const sqlFor = (connection: Pick<PGlite, 'query' | 'exec'>): Sql => ({
    async query<T extends Row>(sql: string, values: unknown[] = []): Promise<T[]> {
      if (!values.length) {
        const results = await connection.exec(sql);
        return (results.at(-1)?.rows ?? []) as T[];
      }
      return (await connection.query<T>(sql, values)).rows;
    },
  });
  const db: Database = { ...sqlFor(pg),
    transaction: (operation) => pg.transaction((tx) => operation(sqlFor(tx))),
    close: () => pg.close() };
  await migrate(db);
  return db;
}

export async function testApp(options: Parameters<typeof createApp>[2] = {}) {
  const db = await testDatabase();
  const directory = await mkdtemp(join(tmpdir(), 'mia-test-'));
  const config = readConfig({ NODE_ENV: 'test', DEV_OTP_CODE: '123456', LOG_LEVEL: 'silent', MEDIA_DIRECTORY: directory });
  const app = await createApp(config, db, options);
  await app.ready();
  return { app, db, config, async close() {
    await app.close();
    await db.close();
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('mia-test-')) throw new Error('Unexpected test directory');
    await rm(target, { recursive: true, force: true });
  } };
}

export function wav(durationMs = 1000) {
  const bytes = Math.round(16_000 * durationMs / 1000) * 2;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24); buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(bytes, 40);
  return buffer;
}
