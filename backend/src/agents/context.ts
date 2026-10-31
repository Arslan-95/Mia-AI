import { z } from 'zod';
import type { Sql } from '../db/database.js';
import { AppError, notFound } from '../errors.js';

const roots = new Set(['/chats', '/contacts', '/drafts', '/mia', '/settings']);
const routeSchema = z.string().max(100).refine(route => {
  if (roots.has(route)) return true;
  const match = /^\/(chat|contact|draft)\/([^/]+)$/.exec(route);
  return Boolean(match && z.uuid().safeParse(match[2]).success);
}, 'Use a supported application route.');

export const voiceStateSchema = z.object({ enabled: z.boolean(), microphoneMuted: z.boolean(), revision: z.int().nonnegative() }).strict();
export const referenceSchema = z.object({ chatId: z.uuid(), messageId: z.uuid(), revision: z.int().nonnegative(), focus: z.object({ start: z.int().nonnegative(), end: z.int().positive() }).strict().optional() }).strict();
export const voiceNoteSchema = z.object({ id: z.uuid(), recipientId: z.uuid(), durationMs: z.int().nonnegative().max(119000) }).strict();
export const clientContextSchema = z.object({ route: routeSchema, revision: z.int().nonnegative(), voice: voiceStateSchema.optional(),
  voiceNote: voiceNoteSchema.optional(), reference: referenceSchema.optional(), previousRoute: routeSchema.optional() }).strict();
export type ClientContext = z.infer<typeof clientContextSchema>;
export const deviceResultSchema = z.object({ message: z.string().max(500).optional(), mediaId: z.uuid().optional(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).optional(),
  stage: z.enum(['validation', 'execution', 'presentation', 'narration', 'confirmation']).optional(),
  presentationConfirmed: z.boolean().optional(),
  reference: referenceSchema.nullable().optional(), context: clientContextSchema.optional(), voice: voiceStateSchema.optional() }).strict();

export function sameContext(left: ClientContext | null, right: ClientContext | null) {
  const a = left?.reference, b = right?.reference;
  // Match values, not JSON key order after database serialization. Keep every
  // navigation/reference revision boundary; voice controls validate separately.
  return left?.route === right?.route && left?.revision === right?.revision && left?.previousRoute === right?.previousRoute
    && left?.voiceNote?.id === right?.voiceNote?.id && left?.voiceNote?.recipientId === right?.voiceNote?.recipientId && left?.voiceNote?.durationMs === right?.voiceNote?.durationMs
    && a?.chatId === b?.chatId && a?.messageId === b?.messageId && a?.revision === b?.revision
    && a?.focus?.start === b?.focus?.start && a?.focus?.end === b?.focus?.end;
}

export async function assertContextAccess(sql: Sql, userId: string, context: ClientContext | null) {
  if (!context) return;
  if (context.voiceNote && (context.voiceNote.recipientId === userId || !(await sql.query(`SELECT 1 FROM chat_members own
    JOIN chat_members recipient ON recipient.chat_id=own.chat_id WHERE own.user_id=$1 AND recipient.user_id=$2 LIMIT 1`,
    [userId, context.voiceNote.recipientId])).length)) throw notFound();
  if (context.reference) {
    const ref = context.reference;
    const [source] = await sql.query<{ text: string | null }>(`SELECT m.text FROM messages m JOIN chat_members c ON c.chat_id=m.chat_id
      WHERE m.id=$1 AND m.chat_id=$2 AND c.user_id=$3`, [ref.messageId, ref.chatId, userId]);
    if (context.route !== `/chat/${ref.chatId}` || !source) throw notFound();
    if (ref.focus) assertSourceFocus(source.text ?? '', ref.focus);
  }
  // Route parsing is only an authorization boundary. The model interprets the
  // route and the user's meaning, and chooses its own lookup tools.
  const checks: Record<string, string> = {
    chat: 'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
    contact: 'SELECT 1 FROM contacts WHERE id = $1 AND owner_id = $2',
    draft: 'SELECT 1 FROM message_drafts WHERE id = $1 AND owner_id = $2',
  };
  for (const route of new Set([context.route, context.previousRoute].filter((value): value is string => value !== undefined))) {
    const [, kind, id] = route.split('/');
    if (!id) continue;
    const query = checks[kind!];
    if (!query || !(await sql.query(query, [id, userId])).length) throw notFound();
  }
}

export function assertSourceFocus(text: string, focus: { start: number; end: number }) {
  const boundaries = new Set([0, text.length]);
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) boundaries.add(part.index);
  if (focus.start >= focus.end || !boundaries.has(focus.start) || !boundaries.has(focus.end))
    throw new AppError(400, 'INVALID_FOCUS', 'Select exact whole source characters.');
}
