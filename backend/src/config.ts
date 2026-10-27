import { resolve } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  DATABASE_URL: z.url().default('postgresql://mia:mia_local_password@localhost:54329/mia'),
  CORS_ORIGINS: z.string().default('http://localhost:8081'),
  MEDIA_DIRECTORY: z.string().default('.data/media'),
  DEV_OTP_CODE: z.preprocess((value) => value === '' ? undefined : value,
    z.string().regex(/^\d{6}$/, 'DEV_OTP_CODE must contain exactly six digits.').optional()),
  META_API_KEY: z.string().default(''),
  META_BASE_URL: z.url().default('https://api.meta.ai/v1'),
  META_MODEL: z.string().min(1).default('muse-spark-1.3'),
  META_ASR_MODEL: z.string().min(1).default('muse-voice-transcribe-1.0'),
  GOOGLE_TTS_API_KEY: z.string().trim().default(''),
  GOOGLE_TTS_VOICE: z.string().regex(/^en-US-[A-Za-z0-9-]+$/).default('en-US-Neural2-F'),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const input = schema.parse(env);
  if (input.NODE_ENV === 'production' && !input.META_BASE_URL.startsWith('https://')) {
    throw new Error('META_BASE_URL must use HTTPS in production');
  }
  return {
    environment: input.NODE_ENV,
    host: input.HOST,
    port: input.PORT,
    databaseUrl: input.DATABASE_URL,
    corsOrigins: input.CORS_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean),
    mediaDirectory: resolve(input.MEDIA_DIRECTORY),
    developmentOtpCode: input.DEV_OTP_CODE,
    metaApiKey: input.META_API_KEY,
    metaBaseUrl: input.META_BASE_URL.replace(/\/$/, ''),
    metaModel: input.META_MODEL,
    metaAsrModel: input.META_ASR_MODEL,
    googleTtsApiKey: input.GOOGLE_TTS_API_KEY,
    googleTtsVoice: input.GOOGLE_TTS_VOICE,
    logLevel: input.LOG_LEVEL,
  };
}

export type Config = ReturnType<typeof readConfig>;
