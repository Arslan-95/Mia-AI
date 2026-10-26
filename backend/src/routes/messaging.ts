import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth.js';
import type { MessagingService } from '../messaging.js';
import type { MediaService } from '../media.js';
import { AppError } from '../errors.js';
import { listEvents } from '../events.js';
import type { Database } from '../db/database.js';

export const id = z.uuid();
const idParams = z.object({ id });
const username = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{2,29}$/);
const text = z.string().trim().min(1).max(8000);
export const contentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text }).strict(),
  z.object({ kind: z.literal('voice'), mediaId: id, text: text.optional() }).strict(),
]);
const cursor = z.string().regex(/^\d{1,19}$/).refine((value) => BigInt(value) <= 9223372036854775807n);
export const eventQuery = z.object({ after: cursor.default('0') });

export function registerMessagingRoutes(app: FastifyInstance, deps: {
  auth: AuthService; messaging: MessagingService; media: MediaService; db: Database;
}) {
  const { auth, messaging, media, db } = deps;
  app.post('/v1/auth/otp/request', { config: { public: true },
    preHandler: app.rateLimit({ max: 8, timeWindow: '1 minute' }) }, async (request, reply) => {
    const { phoneNumber } = z.object({ phoneNumber: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'Enter an international phone number with country code.') }).strict().parse(request.body);
    return reply.code(202).send(await auth.requestCode(phoneNumber));
  });
  app.post('/v1/auth/otp/verify', { config: { public: true },
    preHandler: app.rateLimit({ max: 20, timeWindow: '1 minute' }) }, async (request) => {
    const { challengeId, code } = z.object({ challengeId: id, code: z.string().regex(/^\d{6}$/) }).strict().parse(request.body);
    return auth.verifyCode(challengeId, code);
  });
  app.post('/v1/auth/logout', async (request, reply) => {
    await auth.logout(request.headers.authorization);
    return reply.code(204).send();
  });
  app.get('/v1/me', async (request) => request.user);
  app.patch('/v1/me', async (request) => {
    const input = z.object({ username, displayName: z.string().trim().min(1).max(80) }).strict().parse(request.body);
    return auth.updateProfile(request.user.id, input.username, input.displayName);
  });
  app.get('/v1/users', async (request) => {
    const { query } = z.object({ query: z.string().trim().min(2).max(30) }).parse(request.query);
    return messaging.searchUsers(request.user.id, query);
  });
  app.get('/v1/contacts', async (request) => {
    const { query } = z.object({ query: z.string().trim().max(100).default('') }).parse(request.query);
    return messaging.contacts(request.user.id, query);
  });
  app.post('/v1/contacts', async (request, reply) => {
    const input = z.object({ userId: id, name: z.string().trim().min(1).max(80).optional() }).strict().parse(request.body);
    return reply.code(201).send(await messaging.addContact(request.user.id, input.userId, input.name));
  });
  app.get('/v1/chats', async (request) => messaging.chats(request.user.id));
  app.post('/v1/chats', async (request, reply) => {
    const { recipientId } = z.object({ recipientId: id }).strict().parse(request.body);
    return reply.code(201).send(await messaging.createDirectChat(request.user.id, recipientId));
  });
  app.get('/v1/chats/:id/messages', async (request) => {
    const { id: chatId } = idParams.parse(request.params);
    const { limit, before } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: id.optional() }).parse(request.query);
    return messaging.messages(request.user.id, chatId, limit, before);
  });
  app.post('/v1/chats/:id/messages', async (request, reply) => {
    const { id: chatId } = idParams.parse(request.params);
    const input = z.object({ clientMessageId: id, content: contentSchema }).strict().parse(request.body);
    return reply.code(201).send(await messaging.send(request.user.id, chatId, input.content, input.clientMessageId));
  });
  app.post('/v1/chats/:id/read', async (request, reply) => {
    const { id: chatId } = idParams.parse(request.params);
    const { messageId } = z.object({ messageId: id }).strict().parse(request.body);
    await messaging.markRead(request.user.id, chatId, messageId);
    return reply.code(204).send();
  });
  app.get('/v1/drafts', async (request) => messaging.drafts(request.user.id));
  app.post('/v1/drafts', async (request, reply) => {
    const { recipientId, content } = z.object({ recipientId: id, content: contentSchema }).strict().parse(request.body);
    return reply.code(201).send(await messaging.createDraft(request.user.id, recipientId, content));
  });
  app.patch('/v1/drafts/:id', async (request) => {
    const { id: draftId } = idParams.parse(request.params);
    const { version, content } = z.object({ version: z.int().positive(), content: contentSchema }).strict().parse(request.body);
    return messaging.updateDraft(request.user.id, draftId, version, content);
  });
  app.post('/v1/drafts/:id/review', async (request) => {
    const { id: draftId } = idParams.parse(request.params);
    const { version } = z.object({ version: z.int().positive() }).strict().parse(request.body);
    return messaging.reviewDraft(request.user.id, draftId, version);
  });
  app.post('/v1/drafts/:id/confirm', async (request) => {
    const { id: draftId } = idParams.parse(request.params);
    const { version } = z.object({ version: z.int().positive() }).strict().parse(request.body);
    return messaging.confirmDraft(request.user.id, draftId, version);
  });
  app.delete('/v1/drafts/:id', async (request) => {
    const { id: draftId } = idParams.parse(request.params);
    const { version } = z.object({ version: z.int().positive() }).strict().parse(request.body);
    return messaging.discardDraft(request.user.id, draftId, version);
  });
  app.post('/v1/media', async (request, reply) => {
    const file = await request.file();
    if (!file) throw new AppError(400, 'AUDIO_REQUIRED', 'A WAV recording is required.');
    const audio = await file.toBuffer();
    return reply.code(201).send(await media.upload(request.user.id, audio));
  });
  app.get('/v1/media/:id', async (request, reply) => {
    const { id: mediaId } = idParams.parse(request.params);
    const result = await media.read(request.user.id, mediaId);
    return reply.type(result.mimeType).header('X-Audio-Duration-Ms', result.durationMs).send(result.audio);
  });
  app.get('/v1/events', async (request) => {
    const { after } = eventQuery.parse(request.query);
    return listEvents(db, request.user.id, after);
  });
}
