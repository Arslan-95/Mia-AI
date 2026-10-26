import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { AuthService, type User } from './auth.js';
import type { Database } from './db/database.js';
import { AppError } from './errors.js';
import { MessagingService } from './messaging.js';
import { MediaService } from './media.js';
import { registerMessagingRoutes } from './routes/messaging.js';

declare module 'fastify' {
  interface FastifyRequest { user: User }
  interface FastifyContextConfig { public?: boolean }
}

export async function createApp(config: Config, db: Database) {
  const app = Fastify({ bodyLimit: 32_768, requestTimeout: 30_000, routerOptions: { maxParamLength: 100 },
    logger: { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] },
    disableRequestLogging: true });
  const auth = new AuthService(db);
  const messaging = new MessagingService(db);
  const media = new MediaService(db, config.mediaDirectory);
  await app.register(cors, { origin: config.corsOrigins, credentials: false });
  await app.register(helmet);
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: 12_000_000, files: 1, fields: 0, parts: 1 } });
  app.decorateRequest('user');
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!request.routeOptions.config.public && request.method !== 'OPTIONS') {
      request.user = await auth.authenticate(request.headers.authorization);
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'The request is invalid.',
        fields: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } });
    }
    if (error instanceof AppError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: { code: 'REQUEST_REJECTED', message: 'The request was rejected.' } });
    request.log.error({ requestId: request.id, errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'The route was not found.' } }));
  app.get('/health', { config: { public: true } }, async () => ({ status: 'ok', service: 'mia-backend' }));
  app.get('/health/ready', { config: { public: true } }, async (_request, reply) => {
    try { await db.query('SELECT 1'); }
    catch { return reply.code(503).send({ status: 'unavailable' }); }
    return { status: 'ready', capabilities: { agent: Boolean(config.metaApiKey),
      speechRecognition: Boolean(config.metaApiKey), speechSynthesis: Boolean(config.elevenLabsApiKey && config.elevenLabsVoiceId) } };
  });
  registerMessagingRoutes(app, { auth, messaging, media, db });
  return app;
}
