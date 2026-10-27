import WebSocket from 'ws';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError, throwIfAborted } from '../errors.js';
import { inspectWav } from '../media.js';
import { synthesizeGoogleSpeech } from './google-tts.js';

export type RecognitionEvent =
  | { type: 'speechStart'; turnId: number }
  | { type: 'speechEnd'; turnId: number }
  | { type: 'speechComplete'; turnId: number; transcript: string }
  | { type: 'transcript'; transcript: string; final: boolean };
export interface RecognitionStream { write(audio: Buffer): void; end(): void; close(): void }
export interface SpeechProvider {
  readonly recognitionConfigured: boolean;
  readonly synthesisConfigured: boolean;
  transcribe(audio: Buffer, signal: AbortSignal): Promise<string>;
  recognize(keywords: string[], onEvent: (event: RecognitionEvent) => void,
    onFailure: () => void, signal: AbortSignal): Promise<RecognitionStream>;
  synthesize(text: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

const recognitionEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('speechStart'), turnId: z.int().nonnegative() }),
  z.object({ type: z.literal('speechEnd'), turnId: z.int().nonnegative() }),
  z.object({ type: z.literal('speechComplete'), turnId: z.int().nonnegative(), transcript: z.string().max(8000) }),
  z.object({ type: z.literal('transcript'), transcript: z.string().max(8000), final: z.boolean() }),
]);

export class CloudSpeechProvider implements SpeechProvider {
  readonly recognitionConfigured: boolean;
  readonly synthesisConfigured: boolean;
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch,
    private readonly socketFactory: (url: string) => WebSocket = (url) => new WebSocket(url, { maxPayload: 256_000, handshakeTimeout: 10_000 })) {
    this.recognitionConfigured = Boolean(config.metaApiKey);
    this.synthesisConfigured = Boolean(config.googleTtsApiKey);
  }

  async transcribe(audio: Buffer, signal: AbortSignal): Promise<string> {
    if (!this.recognitionConfigured) throw new AppError(503, 'ASR_UNAVAILABLE', 'Speech recognition is not configured yet.');
    const { sampleRate } = inspectWav(audio);
    if (![16_000, 24_000].includes(sampleRate)) throw new AppError(400, 'UNSUPPORTED_SAMPLE_RATE', 'Transcription requires 16 kHz or 24 kHz PCM WAV.');
    const form = new FormData();
    form.set('request', new Blob([JSON.stringify({ model: this.config.metaAsrModel, mode: 'PUSH_TO_TALK',
      audioEncoding: 'WAV', languageBias: ['English'] })], { type: 'application/json' }));
    form.set('audio', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'recording.wav');
    const response = await this.fetcher(`${this.config.metaBaseUrl}/asr/transcribe`, {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      headers: { Authorization: `Bearer ${this.config.metaApiKey}`, Accept: 'application/json' }, body: form,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(503, 'ASR_UNAVAILABLE', 'Speech recognition is temporarily unavailable.');
    }
    return z.object({ transcript: z.string().max(16_000) }).parse(await response.json()).transcript.trim();
  }

  recognize(keywords: string[], onEvent: (event: RecognitionEvent) => void, onFailure: () => void,
    signal: AbortSignal): Promise<RecognitionStream> {
    if (!this.recognitionConfigured) return Promise.reject(new AppError(503, 'ASR_UNAVAILABLE', 'Speech recognition is not configured yet.'));
    throwIfAborted(signal);
    const url = new URL(`${this.config.metaBaseUrl}/asr/realtime`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.socketFactory(url.toString());
    return new Promise((resolve, reject) => {
      let ready = false;
      let closed = false;
      let ending = false;
      const timeout = setTimeout(() => fail(), 10_000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else if (socket.readyState === WebSocket.OPEN) socket.close();
      };
      const fail = () => {
        if (closed) return;
        if (ready) onFailure(); else reject(new AppError(503, 'ASR_UNAVAILABLE', 'The speech connection failed.'));
        close();
      };
      const abort = () => {
        if (!ready) reject(signal.reason ?? new Error('Recognition cancelled'));
        close();
      };
      signal.addEventListener('abort', abort, { once: true });
      socket.on('error', fail);
      socket.on('close', () => {
        if (!closed) {
          if (!ready) reject(new AppError(503, 'ASR_UNAVAILABLE', 'The speech connection closed.'));
          else if (!ending) onFailure();
          close();
        }
      });
      socket.on('open', () => {
        if (signal.aborted) { abort(); return; }
        socket.send(JSON.stringify({ authorization: { accessToken: `Bearer ${this.config.metaApiKey}` },
          model: this.config.metaAsrModel, audioEncoding: 'PCM_24KHZ', mode: 'ENDPOINTING',
          partialMode: 'CUMULATIVE', languageBias: ['English'], keywords: keywords.slice(0, 40), emitAudioProgress: false }));
      });
      socket.on('message', (data, binary) => {
        if (closed || binary) return;
        try {
          const value = JSON.parse(data.toString()) as Record<string, unknown>;
          if (value.type === 'error') { fail(); return; }
          if (!ready && typeof value.sessionId === 'string') {
            ready = true;
            clearTimeout(timeout);
            resolve({
              write: (audio) => {
                throwIfAborted(signal);
                if (closed || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 512_000) {
                  throw new AppError(503, 'ASR_BACKPRESSURE', 'The speech connection cannot accept audio.');
                }
                socket.send(audio);
              },
              end: () => {
                ending = true;
                if (!closed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'endStream' }));
              },
              close,
            });
            return;
          }
          const event = recognitionEventSchema.safeParse(value);
          if (ready && event.success) onEvent(event.data);
        } catch { fail(); }
      });
      if (signal.aborted) abort();
    });
  }

  async *synthesize(text: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    if (!this.synthesisConfigured) throw new AppError(503, 'TTS_UNAVAILABLE', 'Speech synthesis is not configured yet.');
    yield* synthesizeGoogleSpeech(this.config, this.fetcher, text, signal);
  }
}
