import { createHash, randomUUID } from 'node:crypto';
import type { Database, Sql } from './db/database.js';
import { AppError, conflict, notFound, throwIfAborted } from './errors.js';
import { publish } from './events.js';

export type Profile = { id: string; username: string; displayName: string };
export type Contact = Profile & { contactId: string; name: string };
export type Message = { id: string; chatId: string; senderId: string; kind: 'text' | 'voice';
  text: string | null; mediaId: string | null; createdAt: Date };
export type Draft = { id: string; recipientId: string; kind: 'text' | 'voice'; text: string | null;
  mediaId: string | null; version: number; state: 'editing' | 'ready' | 'sent' | 'discarded';
  reviewedVersion: number | null; messageId: string | null; updatedAt: Date };
type Content = { kind: 'text' | 'voice'; text?: string; mediaId?: string };
const messageColumns = 'id, chat_id AS "chatId", sender_id AS "senderId", kind, text, media_id AS "mediaId", created_at AS "createdAt"';
const draftColumns = 'id, recipient_id AS "recipientId", kind, text, media_id AS "mediaId", version, state, reviewed_version AS "reviewedVersion", message_id AS "messageId", updated_at AS "updatedAt"';

export class MessagingService {
  constructor(private readonly db: Database) {}

  async searchUsers(ownerId: string, query: string) {
    return this.db.query<Profile>(`SELECT id, username, display_name AS "displayName" FROM users
      WHERE id <> $1 AND username LIKE $2 ESCAPE '\\' ORDER BY username LIMIT 20`,
    [ownerId, `${escapeLike(query.toLowerCase())}%`]);
  }

  async contacts(ownerId: string, query = '') {
    return this.db.query<Contact>(`SELECT u.id, u.username, u.display_name AS "displayName", c.id AS "contactId", c.name
      FROM contacts c JOIN users u ON u.id = c.user_id WHERE c.owner_id = $1
      AND (c.name ILIKE $2 ESCAPE '\\' OR u.username ILIKE $2 ESCAPE '\\' OR u.display_name ILIKE $2 ESCAPE '\\')
      ORDER BY c.name, c.id LIMIT 50`, [ownerId, `%${escapeLike(query)}%`]);
  }

  async addContact(ownerId: string, userId: string, name?: string) {
    if (ownerId === userId) throw conflict('You cannot add yourself as a contact.');
    const user = await this.profile(userId);
    return this.db.transaction(async (sql) => {
      const [contact] = await sql.query<{ id: string }>(`INSERT INTO contacts(id, owner_id, user_id, name)
        VALUES ($1,$2,$3,$4) ON CONFLICT(owner_id,user_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [randomUUID(), ownerId, userId, name ?? user.displayName]);
      await publish(sql, ownerId, 'contact.updated', { contactId: contact?.id });
      return { ...user, contactId: contact!.id, name: name ?? user.displayName };
    });
  }

  async contact(ownerId: string, contactId: string) {
    const [contact] = await this.db.query<Contact>(`SELECT u.id,u.username,u.display_name AS "displayName",c.id AS "contactId",c.name
      FROM contacts c JOIN users u ON u.id = c.user_id WHERE c.owner_id = $1 AND c.id = $2`, [ownerId, contactId]);
    if (!contact) throw notFound();
    return contact;
  }

  async profile(userId: string): Promise<Profile> {
    const [user] = await this.db.query<Profile>('SELECT id, username, display_name AS "displayName" FROM users WHERE id = $1', [userId]);
    if (!user) throw notFound();
    return user;
  }

  async directChat(ownerId: string, recipientId: string, sql: Sql = this.db) {
    if (ownerId === recipientId) throw conflict('A direct chat requires another person.');
    const [recipient] = await sql.query('SELECT id FROM users WHERE id = $1', [recipientId]);
    if (!recipient) throw notFound();
    const key = [ownerId, recipientId].sort().join(':');
    await sql.query('INSERT INTO chats(id, direct_key) VALUES ($1,$2) ON CONFLICT(direct_key) DO NOTHING', [randomUUID(), key]);
    const [chat] = await sql.query<{ id: string }>('SELECT id FROM chats WHERE direct_key = $1', [key]);
    if (!chat) throw new Error('Chat creation failed');
    await sql.query('INSERT INTO chat_members(chat_id,user_id) VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING', [chat.id, ownerId, recipientId]);
    return chat;
  }

  async createDirectChat(ownerId: string, recipientId: string) {
    return this.db.transaction((sql) => this.directChat(ownerId, recipientId, sql));
  }

  async chats(ownerId: string, chatId?: string) {
    return this.db.query<{ id: string; recipient: Profile; lastMessage: Message | null; unreadCount: number }>(`
      SELECT c.id, json_build_object('id', u.id, 'username', u.username,
        'displayName', COALESCE(ct.name, u.display_name)) AS recipient,
        (SELECT json_build_object('id',m.id,'senderId',m.sender_id,'kind',m.kind,'text',m.text,'mediaId',m.media_id,'createdAt',m.created_at)
          FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS "lastMessage",
        (SELECT count(*)::integer FROM messages m WHERE m.chat_id = c.id AND m.sender_id <> $1
          AND (own.last_read_message_id IS NULL OR (m.created_at,m.id) >
            (SELECT created_at,id FROM messages WHERE id = own.last_read_message_id))) AS "unreadCount"
      FROM chats c JOIN chat_members own ON own.chat_id = c.id AND own.user_id = $1
      JOIN chat_members other ON other.chat_id = c.id AND other.user_id <> $1
      JOIN users u ON u.id = other.user_id LEFT JOIN contacts ct ON ct.owner_id = $1 AND ct.user_id = u.id
      WHERE ($2::uuid IS NULL OR c.id = $2)
      ORDER BY COALESCE((SELECT max(created_at) FROM messages WHERE chat_id = c.id), c.created_at) DESC,c.id LIMIT 100`, [ownerId, chatId ?? null]);
  }

  async chat(ownerId: string, chatId: string) {
    const [chat] = await this.chats(ownerId, chatId);
    if (!chat) throw notFound();
    return chat;
  }

  async assertMember(ownerId: string, chatId: string, sql: Sql = this.db): Promise<void> {
    const [member] = await sql.query('SELECT 1 FROM chat_members WHERE user_id = $1 AND chat_id = $2', [ownerId, chatId]);
    if (!member) throw notFound();
  }

  async messages(ownerId: string, chatId: string, limit = 30, before?: string) {
    await this.assertMember(ownerId, chatId);
    if (before) {
      const [cursor] = await this.db.query('SELECT id FROM messages WHERE id = $1 AND chat_id = $2', [before, chatId]);
      if (!cursor) throw notFound();
    }
    return this.db.query<Message>(`SELECT ${messageColumns} FROM messages WHERE chat_id = $1
      AND ($3::uuid IS NULL OR (created_at,id) < (SELECT created_at,id FROM messages WHERE id = $3))
      ORDER BY created_at DESC,id DESC LIMIT $2`, [chatId, limit, before ?? null]);
  }

  async message(ownerId: string, messageId: string): Promise<Message> {
    const [message] = await this.db.query<Message>(`SELECT ${messageColumns} FROM messages
      WHERE id = $1 AND chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = $2)`, [messageId, ownerId]);
    if (!message) throw notFound();
    return message;
  }

  async markRead(ownerId: string, chatId: string, messageId: string) {
    return this.db.transaction(async (sql) => {
      await this.assertMember(ownerId, chatId, sql);
      const [message] = await sql.query('SELECT id FROM messages WHERE id = $1 AND chat_id = $2', [messageId, chatId]);
      if (!message) throw notFound();
      await sql.query(`UPDATE chat_members SET last_read_message_id = $3 WHERE chat_id = $1 AND user_id = $2
        AND (last_read_message_id IS NULL OR
          (SELECT (created_at,id) FROM messages WHERE id = last_read_message_id) <
          (SELECT (created_at,id) FROM messages WHERE id = $3))`, [chatId, ownerId, messageId]);
      await publish(sql, ownerId, 'chat.read', { chatId, messageId });
    });
  }

  async send(ownerId: string, chatId: string, content: Content, clientId: string) {
    return this.db.transaction((sql) => this.sendInside(sql, ownerId, chatId, content, clientId));
  }

  private async sendInside(sql: Sql, ownerId: string, chatId: string, content: Content, clientId: string): Promise<Message> {
    await this.assertMember(ownerId, chatId, sql);
    await this.assertContent(ownerId, content, sql);
    const hash = createHash('sha256').update(JSON.stringify([chatId, content.kind, content.text ?? null, content.mediaId ?? null])).digest('hex');
    const [inserted] = await sql.query<Message>(`INSERT INTO messages(id,chat_id,sender_id,kind,text,media_id,client_id,payload_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(sender_id,client_id) DO NOTHING RETURNING ${messageColumns}`,
    [randomUUID(), chatId, ownerId, content.kind, content.text ?? null, content.mediaId ?? null, clientId, hash]);
    if (!inserted) {
      const [existing] = await sql.query<Message & { hash: string }>(`SELECT ${messageColumns}, payload_hash AS hash FROM messages WHERE sender_id = $1 AND client_id = $2`, [ownerId, clientId]);
      if (!existing || existing.hash !== hash) throw conflict('This client message ID was used with different content.');
      const { hash: _, ...message } = existing;
      return message;
    }
    const members = await sql.query<{ userId: string }>('SELECT user_id AS "userId" FROM chat_members WHERE chat_id = $1', [chatId]);
    await sql.query('SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE', [members.map((member) => member.userId)]);
    for (const member of members) await publish(sql, member.userId, 'message.created', inserted);
    return inserted;
  }

  private async assertContent(ownerId: string, content: Content, sql: Sql) {
    if (content.kind === 'text' && (!content.text?.trim() || content.mediaId)) {
      throw new AppError(400, 'INVALID_CONTENT', 'A text message requires text and no recording.');
    }
    if (content.kind === 'voice') {
      const [media] = await sql.query('SELECT id FROM media WHERE id = $1 AND owner_id = $2', [content.mediaId ?? null, ownerId]);
      if (!media) throw notFound();
    }
  }

  async drafts(ownerId: string) {
    return this.db.query<Draft>(`SELECT ${draftColumns} FROM message_drafts WHERE owner_id = $1
      AND state IN ('editing','ready') ORDER BY updated_at DESC LIMIT 20`, [ownerId]);
  }

  async draft(ownerId: string, draftId: string, sql: Sql = this.db, lock = false): Promise<Draft> {
    const [draft] = await sql.query<Draft>(`SELECT ${draftColumns} FROM message_drafts WHERE id = $1 AND owner_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [draftId, ownerId]);
    if (!draft) throw notFound();
    return draft;
  }

  async createDraft(ownerId: string, recipientId: string, content: Content, signal?: AbortSignal) {
    return this.db.transaction(async (sql) => {
      if (ownerId === recipientId) throw conflict('A message requires another person.');
      const [recipient] = await sql.query('SELECT id FROM users WHERE id = $1', [recipientId]);
      if (!recipient) throw notFound();
      await this.assertContent(ownerId, content, sql);
      throwIfAborted(signal);
      const [draft] = await sql.query<Draft>(`INSERT INTO message_drafts(id,owner_id,recipient_id,kind,text,media_id)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${draftColumns}`,
      [randomUUID(), ownerId, recipientId, content.kind, content.text ?? null, content.mediaId ?? null]);
      await publish(sql, ownerId, 'draft.updated', draft);
      return draft!;
    });
  }

  async updateDraft(ownerId: string, draftId: string, version: number, content: Content, signal?: AbortSignal) {
    return this.db.transaction(async (sql) => {
      const current = await this.draft(ownerId, draftId, sql, true);
      if (current.version !== version || ['sent','discarded'].includes(current.state)) throw conflict('The draft changed or is no longer editable.');
      await this.assertContent(ownerId, content, sql);
      throwIfAborted(signal);
      const [draft] = await sql.query<Draft>(`UPDATE message_drafts SET kind = $3,text = $4,media_id = $5,
        version = version + 1,reviewed_version = NULL,state = 'editing',updated_at = now()
        WHERE id = $1 AND owner_id = $2 RETURNING ${draftColumns}`,
      [draftId, ownerId, content.kind, content.text ?? null, content.mediaId ?? null]);
      await publish(sql, ownerId, 'draft.updated', draft);
      return draft!;
    });
  }

  async reviewDraft(ownerId: string, draftId: string, version: number, signal?: AbortSignal) {
    return this.db.transaction(async (sql) => {
      const draft = await this.draft(ownerId, draftId, sql, true);
      if (draft.version !== version || ['sent','discarded'].includes(draft.state)) throw conflict('The draft changed or is no longer editable.');
      throwIfAborted(signal);
      const [reviewed] = await sql.query<Draft>(`UPDATE message_drafts SET state = 'ready',reviewed_version = version,
        updated_at = now() WHERE id = $1 RETURNING ${draftColumns}`, [draftId]);
      await publish(sql, ownerId, 'draft.reviewed', reviewed);
      return reviewed!;
    });
  }

  async discardDraft(ownerId: string, draftId: string, version: number, signal?: AbortSignal) {
    return this.db.transaction(async (sql) => {
      const draft = await this.draft(ownerId, draftId, sql, true);
      if (draft.version !== version || draft.state === 'sent') throw conflict('The draft changed or was already sent.');
      throwIfAborted(signal);
      await sql.query("UPDATE message_drafts SET state = 'discarded',updated_at = now() WHERE id = $1", [draftId]);
      await publish(sql, ownerId, 'draft.discarded', { draftId });
      return { draftId, state: 'discarded' };
    });
  }

  async confirmDraft(ownerId: string, draftId: string, version: number, signal?: AbortSignal) {
    return this.db.transaction(async (sql) => {
      const draft = await this.draft(ownerId, draftId, sql, true);
      if (draft.version !== version) throw conflict('The draft changed. Review the latest version before sending.');
      if (draft.state === 'sent' && draft.messageId) {
        const [message] = await sql.query<Message>(`SELECT ${messageColumns} FROM messages WHERE id = $1`, [draft.messageId]);
        return message!;
      }
      if (draft.state !== 'ready' || draft.reviewedVersion !== version) throw conflict('Review this draft before confirming it.');
      const chat = await this.directChat(ownerId, draft.recipientId, sql);
      throwIfAborted(signal);
      const message = await this.sendInside(sql, ownerId, chat.id, {
        kind: draft.kind, ...(draft.text ? { text: draft.text } : {}), ...(draft.mediaId ? { mediaId: draft.mediaId } : {}),
      }, draft.id);
      await sql.query("UPDATE message_drafts SET state = 'sent',message_id = $2,updated_at = now() WHERE id = $1", [draftId, message.id]);
      await publish(sql, ownerId, 'draft.sent', { draftId, version, messageId: message.id });
      return message;
    });
  }
}

function escapeLike(value: string) { return value.replace(/[\\%_]/g, '\\$&'); }
