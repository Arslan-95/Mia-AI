import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Database, Row, Sql } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

export async function testDatabase(): Promise<Database> {
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

export async function testApp() {
  const db = await testDatabase();
  const directory = await mkdtemp(join(tmpdir(), 'mia-test-'));
  const config = readConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', MEDIA_DIRECTORY: directory });
  const app = await createApp(config, db);
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
