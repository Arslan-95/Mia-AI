import { readConfig } from '../config.js';
import { AppError } from '../errors.js';
import { CloudSpeechProvider } from './providers.js';

const config = readConfig();
if (!config.googleTtsApiKey) {
  console.error('Set GOOGLE_TTS_API_KEY in backend/.env before checking speech synthesis.');
  process.exitCode = 1;
} else {
  try {
    let bytes = 0;
    const provider = new CloudSpeechProvider(config);
    for await (const chunk of provider.synthesize('Hello, I am Mia.', AbortSignal.timeout(30_000))) bytes += chunk.byteLength;
    console.info(`Google TTS succeeded: ${config.googleTtsVoice}, 24 kHz mono PCM, ${bytes} bytes.`);
  } catch (error) {
    console.error(`Google TTS check failed: ${error instanceof AppError ? error.code : 'TTS_REQUEST_FAILED'}. Check API access, key restrictions and billing.`);
    process.exitCode = 1;
  }
}
