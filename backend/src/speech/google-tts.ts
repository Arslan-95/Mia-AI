import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../config.js';
import { AppError, throwIfAborted } from '../errors.js';
import { inspectWav } from '../media.js';
import { googleSpeechEndpoint, googleSpeechHeaders, type GoogleSpeechHeaders } from './google-auth.js';
import { speechPrompt, type SpeechOptions } from './delivery.js';

const sampleRate = 24_000;
const maxPcmBytes = sampleRate * 2 * 180;
const maxAudioBytes = maxPcmBytes + 65_536;
const maxBase64Length = Math.ceil(maxAudioBytes / 3) * 4;
const maxResponseBytes = maxBase64Length + 1024;
const responseSchema = z.object({ audioContent: z.string().min(1).max(maxBase64Length) });
const invalidAudio = () => new AppError(503, 'INVALID_TTS_AUDIO', 'The speech provider returned invalid audio.');

type ProviderDiagnostic = { providerErrorStatus?: string; providerReason?: string; providerMessage?: string };
export type SpeechAttemptDiagnostic = ProviderDiagnostic & { attempt: number; providerStatus: number };
export type SpeechDiagnosticReporter = (diagnostic: SpeechAttemptDiagnostic) => void | Promise<void>;

async function providerDiagnostic(response: Response, sensitive: string[]): Promise<ProviderDiagnostic> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) return {};
      chunks.push(part.value);
    }
    const parsed = z.object({ error: z.object({ status: z.string().optional(), message: z.string().optional(),
      details: z.array(z.object({ reason: z.string().optional() })).optional() }) }).safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!parsed.success) return {};
    const error = parsed.data.error;
    const identifier = (value?: string) => value && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : undefined;
    let message = error.message ?? '';
    for (const secret of sensitive.filter(Boolean).sort((a, b) => b.length - a.length)) message = message.replaceAll(secret, '[redacted]');
    // Provider messages can echo credentials, source text or delivery prompts.
    message = message.replace(/https?:\/\/\S+/g, '[url]').replace(/[A-Za-z0-9_./+=-]{32,}/g, '[redacted]')
      .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, '[quoted detail]').replace(/[\r\n\t]+/g, ' ').slice(0, 600);
    return { providerErrorStatus: identifier(error.status), providerReason: identifier(error.details?.find(item => identifier(item.reason))?.reason),
      ...(message ? { providerMessage: message } : {}) };
  } catch { return {}; }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export class SpeechSynthesisError extends AppError {
  constructor(code: string, readonly providerStatus: number | undefined, readonly attempts: number, readonly diagnostic?: ProviderDiagnostic) {
    super(503, code, 'Speech synthesis is temporarily unavailable.');
  }
}

// Retry only before a segment is yielded. The phone buffers the entire request
// before playback, so these retries cannot repeat words the user already heard.
async function requestAudio(fetcher: typeof fetch, body: string, authorize: GoogleSpeechHeaders, signal: AbortSignal, sourceText: string, report?: SpeechDiagnosticReporter) {
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    const headers = await authorize(signal);
    throwIfAborted(signal);
    headers.set('Content-Type', 'application/json'); headers.set('Accept', 'application/json');
    let response: Response;
    try {
      response = await fetcher(googleSpeechEndpoint, { method: 'POST', signal, headers, body });
    } catch {
      throwIfAborted(signal);
      if (attempt === 3) throw new SpeechSynthesisError('TTS_NETWORK_ERROR', undefined, attempt);
      await delay(300 * attempt, undefined, { signal });
      continue;
    }
    throwIfAborted(signal);
    if (response.ok) {
      try { return await readAudio(response, signal); }
      catch (error) {
        throwIfAborted(signal);
        if (error instanceof AppError) throw error;
        if (attempt === 3) throw new SpeechSynthesisError('TTS_NETWORK_ERROR', response.status, attempt);
        await delay(300 * attempt, undefined, { signal });
        continue;
      }
    }
    const input = (JSON.parse(body) as { input: Record<string, string> }).input;
    const sensitive = [sourceText, ...Object.values(input), ...headers.values()];
    const diagnostic = await providerDiagnostic(response, sensitive);
    throwIfAborted(signal);
    // Diagnostics must never turn a recoverable provider failure into a failed request.
    try { await report?.({ ...diagnostic, attempt, providerStatus: response.status }); } catch { /* Speech can still retry. */ }
    throwIfAborted(signal);
    // This provider can return 400 for a request that succeeds unchanged on
    // the next call. Give it the same bounded retry policy as 429 and 5xx.
    const retryable = response.status === 400 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 3) {
      const code = response.status === 429 ? 'TTS_RATE_LIMITED'
        : [401, 403].includes(response.status) ? 'TTS_AUTH_UNAVAILABLE'
        : response.status === 400 ? 'TTS_REQUEST_REJECTED' : 'TTS_UNAVAILABLE';
      throw new SpeechSynthesisError(code, response.status, attempt, diagnostic);
    }
    // Respect a short Retry-After without exceeding the overall request budget.
    const retryAfter = Number(response.headers.get('retry-after'));
    await delay(Math.max(300 * attempt, Number.isFinite(retryAfter) ? Math.min(Math.max(0, retryAfter * 1000), 3000) : 0), undefined, { signal });
  }
}

const escapeSsml = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);

function* textParts(text: string, maximumBytes: number, encode: (text: string) => string) {
  let remaining = text.trim();
  while (remaining) {
    if (Buffer.byteLength(encode(remaining), 'utf8') <= maximumBytes) { yield remaining; return; }
    let length = 0;
    let bytes = 0;
    let wordBoundary = 0;
    for (const character of remaining) {
      const size = Buffer.byteLength(encode(character), 'utf8');
      if (bytes + size > maximumBytes) break;
      bytes += size;
      length += character.length;
      if (/\s/u.test(character)) wordBoundary = length;
    }
    // Prefer whole sentences so a styled chunk does not interrupt their delivery.
    const sentence = [...remaining.slice(0, length).matchAll(/[.!?…]["'”’)]*\s+/gu)].at(-1);
    const sentenceBoundary = sentence ? sentence.index + sentence[0].length : 0;
    const end = sentenceBoundary > length / 2 ? sentenceBoundary : wordBoundary > length / 2 ? wordBoundary : length;
    yield remaining.slice(0, end).trim();
    remaining = remaining.slice(end).trimStart();
  }
}

async function readAudio(response: Response, signal: AbortSignal) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (!response.body) throw invalidAudio();
  for await (const chunk of response.body) {
    throwIfAborted(signal);
    bytes += chunk.byteLength;
    if (bytes > maxResponseBytes) throw invalidAudio();
    chunks.push(chunk);
  }
  throwIfAborted(signal);
  try {
    const { audioContent } = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const audio = Buffer.from(audioContent, 'base64');
    if (audio.length > maxAudioBytes || audio.toString('base64') !== audioContent) throw invalidAudio();
    const result = inspectWav(audio, 180_000);
    if (result.sampleRate !== sampleRate) throw invalidAudio();
    return result.pcm;
  } catch { throw invalidAudio(); }
}

export async function* synthesizeGoogleSpeech(config: Config, fetcher: typeof fetch,
  text: string, signal: AbortSignal, authorize: GoogleSpeechHeaders = googleSpeechHeaders(config), options: SpeechOptions = {}, report?: SpeechDiagnosticReporter): AsyncIterable<Uint8Array> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
  throwIfAborted(requestSignal);
  let total = 0;
  const gemini = config.googleTtsModel !== 'standard';
  const styled = !gemini && config.googleTtsStyle !== 'none' && ['en-US-Neural2-F', 'en-US-Neural2-J'].includes(config.googleTtsVoice);
  const opening = `<speak><google:style name="${config.googleTtsStyle}">`;
  const closing = '</google:style></speak>';
  const encode = styled ? escapeSsml : (text: string) => text;
  const maximumBytes = gemini ? 4000 : 4800 - (styled ? Buffer.byteLength(opening + closing, 'utf8') : 0);
  const prompt = speechPrompt(config.googleTtsPrompt, options);
  if (gemini && Buffer.byteLength(prompt, 'utf8') > 4000) throw new AppError(503, 'TTS_PROMPT_LIMIT', 'The speech delivery configuration is too long.');
  for (const part of textParts(text, maximumBytes, encode)) {
    throwIfAborted(requestSignal);
    const pcm = await requestAudio(fetcher, JSON.stringify({ input: gemini ? { text: part, prompt } : styled ? { ssml: opening + encode(part) + closing } : { text: part },
        voice: { languageCode: 'en-US', name: config.googleTtsVoice, ...(gemini ? { modelName: config.googleTtsModel } : {}) },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: sampleRate } }), authorize, requestSignal, part, report);
    total += pcm.length;
    if (total > maxPcmBytes) throw new AppError(503, 'TTS_LIMIT', 'The spoken response exceeded its duration limit.');
    for (let offset = 0; offset < pcm.length; offset += 12_000) {
      throwIfAborted(requestSignal);
      yield pcm.subarray(offset, Math.min(offset + 12_000, pcm.length));
    }
  }
  if (total === 0) throw invalidAudio();
}
