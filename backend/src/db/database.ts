import pg from 'pg';

export type Row = Record<string, unknown>;
export interface Sql {
  query<T extends Row = Row>(sql: string, values?: unknown[]): Promise<T[]>;
}
export interface Database extends Sql {
  transaction<T>(operation: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PostgresDatabase implements Database {
  private readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000, statement_timeout: 15_000 });
    this.pool.on('error', () => { console.error('An idle database connection failed.'); });
  }
  async query<T extends Row = Row>(sql: string, values: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, values)).rows;
  }
  async transaction<T>(operation: (sql: Sql) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation({ query: async <R extends Row>(sql: string, values: unknown[] = []) =>
        (await client.query<R>(sql, values)).rows });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
