import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AssistantRuntime } from '../agents/runtime.js';

export function registerAssistantRoutes(app: FastifyInstance, assistant: AssistantRuntime) {
  const params = z.object({ sessionId: z.uuid() });
  app.post('/v1/assistant/sessions', async (request, reply) => reply.code(201).send(await assistant.state.session(request.user.id)));
  app.get('/v1/assistant/sessions/:sessionId', async (request) => {
    const { sessionId } = params.parse(request.params);
    return { session: await assistant.state.requireSession(request.user.id, sessionId),
      turns: await assistant.state.history(request.user.id, sessionId) };
  });
  app.post('/v1/assistant/sessions/:sessionId/turns', {
    preHandler: app.rateLimit({ max: 20, timeWindow: '1 minute' }),
  }, async (request, reply) => {
    const { sessionId } = params.parse(request.params);
    const { clientTurnId, text } = z.object({ clientTurnId: z.uuid(), text: z.string().trim().min(1).max(8000) }).strict().parse(request.body);
    const result = await assistant.submit(request.user.id, sessionId, clientTurnId, text);
    return reply.code(result.duplicate ? 200 : 202).send(result);
  });
  app.post('/v1/assistant/sessions/:sessionId/stop', async (request) => {
    const { sessionId } = params.parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    return assistant.interrupt(request.user.id, sessionId);
  });
  app.get('/v1/assistant/sessions/:sessionId/turns/:turnId', async (request) => {
    const { sessionId, turnId } = params.extend({ turnId: z.uuid() }).parse(request.params);
    return assistant.state.turn(request.user.id, sessionId, turnId);
  });
  app.post('/v1/device-actions/:actionId/result', async (request) => {
    const { actionId } = z.object({ actionId: z.uuid() }).parse(request.params);
    const { success, result } = z.object({ success: z.boolean(),
      result: z.object({ message: z.string().max(500).optional(), mediaId: z.uuid().optional() }).strict().default({}) }).strict().parse(request.body);
    return assistant.state.acknowledgeAction(request.user.id, actionId, success, result);
  });
}
