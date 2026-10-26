import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MediaService } from '../media.js';
import type { SpeechProvider } from '../speech/providers.js';

export function registerSpeechRoutes(app: FastifyInstance, media: MediaService, speech: SpeechProvider) {
  app.post('/v1/speech/transcriptions', { preHandler: app.rateLimit({ max: 15, timeWindow: '1 minute' }) }, async (request, reply) => {
    const { mediaId } = z.object({ mediaId: z.uuid() }).strict().parse(request.body);
    const controller = new AbortController();
    const disconnected = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.once('close', disconnected);
    try {
      const recording = await media.read(request.user.id, mediaId);
      return { mediaId, text: await speech.transcribe(recording.audio, controller.signal) };
    } finally { reply.raw.removeListener('close', disconnected); }
  });
}
