import { z } from 'zod';
import type { Sql } from '../db/database.js';
import { notFound } from '../errors.js';

const roots = new Set(['/chats', '/contacts', '/drafts', '/mia', '/settings']);
const routeSchema = z.string().max(100).refine(route => {
  if (roots.has(route)) return true;
  const match = /^\/(chat|contact|draft)\/([^/]+)$/.exec(route);
  return Boolean(match && z.uuid().safeParse(match[2]).success);
}, 'Use a supported application route.');

export const clientContextSchema = z.object({ route: routeSchema, revision: z.int().nonnegative(),
  previousRoute: routeSchema.optional() }).strict();
export type ClientContext = z.infer<typeof clientContextSchema>;
export const deviceResultSchema = z.object({ message: z.string().max(500).optional(), mediaId: z.uuid().optional(),
  context: clientContextSchema.optional() }).strict();

export function sameContext(left: ClientContext | null, right: ClientContext | null) {
  return left?.route === right?.route && left?.revision === right?.revision && left?.previousRoute === right?.previousRoute;
}

export async function assertContextAccess(sql: Sql, userId: string, context: ClientContext | null) {
  if (!context) return;
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
