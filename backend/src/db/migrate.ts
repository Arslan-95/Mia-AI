import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readConfig } from '../config.js';
import { PostgresDatabase, type Database } from './database.js';

export async function migrate(database: Database): Promise<void> {
  const directory = fileURLToPath(new URL('../../migrations/', import.meta.url));
  await database.transaction(async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(476193821)');
    await sql.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await sql.query<{ name: string }>('SELECT name FROM schema_migrations')).map((row) => row.name));
    for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      if (applied.has(name)) continue;
      await sql.query(await readFile(resolve(directory, name), 'utf8'));
      await sql.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const database = new PostgresDatabase(readConfig().databaseUrl);
  try { await migrate(database); console.log('Database migrations applied.'); }
  finally { await database.close(); }
}
