import { z } from 'zod';
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
  text: string, signal: AbortSignal, authorize: GoogleSpeechHeaders = googleSpeechHeaders(config), options: SpeechOptions = {}): AsyncIterable<Uint8Array> {
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
    const headers = await authorize(requestSignal);
    throwIfAborted(requestSignal);
    headers.set('Content-Type', 'application/json'); headers.set('Accept', 'application/json');
    const response = await fetcher(googleSpeechEndpoint, {
      method: 'POST', signal: requestSignal,
      headers,
      body: JSON.stringify({ input: gemini ? { text: part, prompt } : styled ? { ssml: opening + encode(part) + closing } : { text: part },
        voice: { languageCode: 'en-US', name: config.googleTtsVoice, ...(gemini ? { modelName: config.googleTtsModel } : {}) },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: sampleRate } }),
    });
    throwIfAborted(requestSignal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(503, 'TTS_UNAVAILABLE', 'Speech synthesis is temporarily unavailable.');
    }
    const pcm = await readAudio(response, requestSignal);
    total += pcm.length;
    if (total > maxPcmBytes) throw new AppError(503, 'TTS_LIMIT', 'The spoken response exceeded its duration limit.');
    for (let offset = 0; offset < pcm.length; offset += 12_000) {
      throwIfAborted(requestSignal);
      yield pcm.subarray(offset, Math.min(offset + 12_000, pcm.length));
    }
  }
  if (total === 0) throw invalidAudio();
}
