import { v1, type protos } from '@google-cloud/text-to-speech';
import type { Config } from '../config.js';
import { throwIfAborted } from '../errors.js';

export type GoogleSpeechStream = (text: string, prompt: string, signal: AbortSignal) => AsyncIterable<Uint8Array>;

export function createGoogleSpeechStream(config: Config) {
  if (config.googleTtsModel === 'standard' || config.googleTtsAuth !== 'adc') return;
  let client: v1.TextToSpeechClient | undefined;
  return {
    async *synthesize(text: string, prompt: string, signal: AbortSignal) {
      throwIfAborted(signal);
      client ??= new v1.TextToSpeechClient();
      const rpc = client.streamingSynthesize({ timeout: 90_000, ...(config.googleTtsProject
        ? { otherArgs: { headers: { 'x-goog-user-project': config.googleTtsProject } } } : {}) });
      const cancel = () => rpc.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        let batch = Buffer.allocUnsafe(12_000);
        let buffered = 0;
        rpc.write({ streamingConfig: {
          voice: { languageCode: 'en-US', name: config.googleTtsVoice, modelName: config.googleTtsModel },
          streamingAudioConfig: { audioEncoding: 'PCM', sampleRateHertz: 24_000 },
        } });
        rpc.end({ input: { text, prompt } });
        for await (const response of rpc as AsyncIterable<protos.google.cloud.texttospeech.v1.IStreamingSynthesizeResponse>) {
          throwIfAborted(signal);
          const audio = response.audioContent;
          if (!audio?.length) continue;
          const pcm = typeof audio === 'string' ? Buffer.from(audio, 'base64') : audio;
          // One batch is 250 ms of playable audio. It avoids a database
          // generation check and a websocket frame for every tiny RPC packet.
          for (let offset = 0; offset < pcm.length;) {
            const size = Math.min(batch.length - buffered, pcm.length - offset);
            batch.set(pcm.subarray(offset, offset + size), buffered);
            offset += size;
            buffered += size;
            if (buffered === batch.length) {
              yield batch;
              batch = Buffer.allocUnsafe(12_000);
              buffered = 0;
            }
          }
        }
        if (buffered) yield batch.subarray(0, buffered);
      } finally {
        signal.removeEventListener('abort', cancel);
        if (!rpc.readableEnded && !signal.aborted) cancel();
      }
    },
    async close() { await client?.close(); },
  };
}
