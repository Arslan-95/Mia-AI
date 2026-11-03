import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Row } from '../db/database.js';
import { AppError, conflict, notFound } from '../errors.js';
import { MessagingService } from '../messaging.js';

export const memoryInput = z.object({
  contactId: z.uuid().nullable(),
  kind: z.enum(['identity', 'preference', 'relationship', 'context']),
  key: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  value: z.string().trim().min(1).max(1000),
  evidence: z.string().trim().min(1).max(1000),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  memoryId: z.uuid().nullable(),
  version: z.int().positive().nullable(),
}).strict();
export type MemoryInput = z.infer<typeof memoryInput>;
export type Memory = Row & { id: string; contactId: string | null; kind: MemoryInput['kind']; key: string; value: string;
  version: number; sourceTurnId: string | null; expiresAt: Date | null };
// Provenance quotes stay in storage for validation; do not re-inject unrelated
// details in those quotes as remembered facts (including a forgotten name).
const columns = `m.id,m.contact_id AS "contactId",m.kind,m.key,m.value,m.version,
  m.source_turn_id AS "sourceTurnId",m.expires_at AS "expiresAt",m.updated_at AS "updatedAt",
  CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('contactId',c.id,'userId',c.user_id,'name',c.name) END AS contact`;

export class AgentMemory {
  constructor(private readonly db: Database) {}
  async automatic(owner: string) {
    const [row] = await this.db.query<{ automatic: boolean }>('SELECT automatic FROM assistant_memory_settings WHERE owner_id=$1', [owner]);
    return row?.automatic ?? true;
  }
  async setAutomatic(owner: string, enabled: boolean) {
    await this.db.query(`INSERT INTO assistant_memory_settings(owner_id,automatic) VALUES ($1,$2)
      ON CONFLICT(owner_id) DO UPDATE SET automatic=EXCLUDED.automatic`, [owner, enabled]);
    return { automatic: enabled };
  }
  async list(owner: string, options: { contactId?: string; query?: string; after?: string; limit?: number } = {}) {
    const limit = Math.min(options.limit ?? 30, 50);
    const rows = await this.db.query<Memory>(`SELECT ${columns} FROM assistant_memories m LEFT JOIN contacts c ON c.id=m.contact_id
      WHERE m.owner_id=$1 AND (m.expires_at IS NULL OR m.expires_at>now())
      AND ($2::uuid IS NULL OR m.contact_id=$2)
      AND ($3::text IS NULL OR m.value ILIKE $3 ESCAPE '\\' OR m.key ILIKE $3 ESCAPE '\\' OR c.name ILIKE $3 ESCAPE '\\')
      AND ($4::uuid IS NULL OR m.id>$4) ORDER BY m.id LIMIT $5`,
    [owner, options.contactId ?? null, options.query ? `%${options.query.replace(/[\\%_]/g, '\\$&')}%` : null, options.after ?? null, limit + 1]);
    return { memories: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1]!.id : null };
  }
  async get(owner: string, id: string) {
    const [memory] = await this.db.query<Memory>(`SELECT ${columns} FROM assistant_memories m LEFT JOIN contacts c ON c.id=m.contact_id
      WHERE m.owner_id=$1 AND m.id=$2 AND (m.expires_at IS NULL OR m.expires_at>now())`, [owner, id]);
    if (!memory) throw notFound();
    return memory;
  }
  async context(owner: string) {
    const [counts] = await this.db.query<{ total: number }>(`SELECT count(*)::integer AS total FROM assistant_memories
      WHERE owner_id=$1 AND (expires_at IS NULL OR expires_at>now())`, [owner]);
    const memories = await this.db.query<Memory>(`SELECT ${columns} FROM assistant_memories m LEFT JOIN contacts c ON c.id=m.contact_id
      WHERE m.owner_id=$1 AND (m.expires_at IS NULL OR m.expires_at>now())
      ORDER BY CASE WHEN m.contact_id IS NULL THEN 0 ELSE 1 END,m.updated_at DESC,m.id LIMIT 32`, [owner]);
    const forgotten = await this.db.query(`SELECT subject,key,source_turn_id AS "sourceTurnId" FROM assistant_forgotten_memories
      WHERE owner_id=$1 ORDER BY forgotten_at DESC LIMIT 128`, [owner]);
    return { automatic: await this.automatic(owner), total: counts!.total, memories, forgotten };
  }
  async save(owner: string, turnId: string, raw: MemoryInput) {
    const input = memoryInput.parse(raw);
    const [source] = await this.db.query<{ text: string }>(`SELECT t.user_text AS text FROM assistant_turns t
      JOIN assistant_sessions s ON s.id=t.session_id WHERE t.id=$1 AND s.user_id=$2`, [turnId, owner]);
    if (!source || !source.text.normalize('NFKC').includes(input.evidence.normalize('NFKC'))) throw conflict('Memory evidence must quote the current user request.');
    if (input.kind === 'relationship' && !input.contactId) throw conflict('Resolve the person to a saved contact first.');
    if (input.contactId) await new MessagingService(this.db).contact(owner, input.contactId);
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) throw conflict('The memory expiry must be in the future.');
    if (input.kind === 'context' && !input.expiresAt) throw conflict('Temporary context requires an expiry.');
    const subject = input.contactId ?? 'self';
    return this.db.transaction(async sql => {
      // Serialize memory writes for an account.
      await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
      await sql.query('DELETE FROM assistant_memories WHERE owner_id=$1 AND expires_at<=now()', [owner]);
      const [existing] = await sql.query<{ id: string; version: number }>(`SELECT id,version FROM assistant_memories
        WHERE owner_id=$1 AND subject=$2 AND key=$3 FOR UPDATE`, [owner, subject, input.key]);
      if (existing && (input.memoryId !== existing.id || input.version !== existing.version)) throw conflict('Read the existing memory and update its current version.');
      if (!existing && (input.memoryId || input.version)) throw conflict('That memory no longer exists.');
      const [count] = await sql.query<{ count: number }>('SELECT count(*)::integer AS count FROM assistant_memories WHERE owner_id=$1', [owner]);
      if (!existing && count!.count >= 1000) throw new AppError(409, 'MEMORY_LIMIT', 'Remove unused memories before saving another.');
      const id = existing?.id ?? randomUUID();
      await sql.query(`INSERT INTO assistant_memories(id,owner_id,contact_id,subject,kind,key,value,source_turn_id,evidence,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(owner_id,subject,key) DO UPDATE SET kind=EXCLUDED.kind,value=EXCLUDED.value,
          source_turn_id=EXCLUDED.source_turn_id,evidence=EXCLUDED.evidence,expires_at=EXCLUDED.expires_at,
          version=assistant_memories.version+1,updated_at=now()`,
      [id, owner, input.contactId, subject, input.kind, input.key, input.value, turnId, input.evidence, input.expiresAt]);
      await sql.query('DELETE FROM assistant_forgotten_memories WHERE owner_id=$1 AND subject=$2 AND key=$3', [owner, subject, input.key]);
      const [saved] = await sql.query<Memory>(`SELECT ${columns} FROM assistant_memories m LEFT JOIN contacts c ON c.id=m.contact_id
        WHERE m.owner_id=$1 AND m.id=$2`, [owner, id]);
      return saved!;
    });
  }
  async forget(owner: string, id: string, version: number, sourceTurnId: string) {
    return this.db.transaction(async sql => {
      await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
      const [memory] = await sql.query<{ subject: string; key: string; version: number }>(`SELECT subject,key,version
        FROM assistant_memories WHERE owner_id=$1 AND id=$2 FOR UPDATE`, [owner, id]);
      if (!memory) throw notFound();
      if (memory.version !== version) throw conflict('The memory changed. Read it again before removing it.');
      await sql.query(`INSERT INTO assistant_forgotten_memories(owner_id,subject,key,source_turn_id) VALUES ($1,$2,$3,$4)
        ON CONFLICT(owner_id,subject,key) DO UPDATE SET source_turn_id=EXCLUDED.source_turn_id,forgotten_at=now()`,
      [owner, memory.subject, memory.key, sourceTurnId]);
      await sql.query('DELETE FROM assistant_memories WHERE owner_id=$1 AND id=$2', [owner, id]);
      return { forgotten: true };
    });
  }
  async clear(owner: string, sourceTurnId: string) {
    return this.db.transaction(async sql => {
      await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
      await sql.query(`INSERT INTO assistant_forgotten_memories(owner_id,subject,key,source_turn_id)
        SELECT owner_id,subject,key,$2 FROM assistant_memories WHERE owner_id=$1
        ON CONFLICT(owner_id,subject,key) DO UPDATE SET source_turn_id=EXCLUDED.source_turn_id,forgotten_at=now()`, [owner, sourceTurnId]);
      const removed = await sql.query('DELETE FROM assistant_memories WHERE owner_id=$1 RETURNING id', [owner]);
      return { forgotten: removed.length };
    });
  }
}
