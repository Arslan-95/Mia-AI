import type { Sql } from './db/database.js';

export async function publish(sql: Sql, userId: string, type: string, payload: unknown): Promise<void> {
  await sql.query(`INSERT INTO events(user_id, type, payload)
    SELECT owner.id, $2, $3::jsonb FROM
      (SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE) owner`,
    [userId, type, JSON.stringify(payload)]);
}

export async function listEvents(sql: Sql, userId: string, after = '0', limit = 100) {
  return sql.query<{ id: string; type: string; payload: unknown; createdAt: Date }>(
    `SELECT id::text, type, payload, created_at AS "createdAt" FROM events
     WHERE user_id = $1 AND id > $2::bigint ORDER BY id LIMIT $3`, [userId, after, limit]);
}
