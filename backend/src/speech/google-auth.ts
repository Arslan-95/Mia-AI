import { GoogleAuth } from 'google-auth-library';
import type { Config } from '../config.js';
import { AppError, throwIfAborted } from '../errors.js';

export const googleSpeechEndpoint = 'https://texttospeech.googleapis.com/v1/text:synthesize';
export type GoogleSpeechHeaders = (signal: AbortSignal) => Promise<Headers>;

/** ADC refreshes short-lived tokens; credentials never enter the client or URL. */
export function googleSpeechHeaders(config: Config, credentials?: Pick<GoogleAuth, 'getRequestHeaders'>): GoogleSpeechHeaders {
  const auth = credentials ?? new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    ...(config.googleTtsProject ? { quotaProjectId: config.googleTtsProject } : {}) });
  return async signal => {
    throwIfAborted(signal);
    if (config.googleTtsAuth === 'api-key') {
      if (!config.googleTtsApiKey) throw new AppError(503, 'TTS_UNAVAILABLE', 'Speech synthesis is not configured yet.');
      return new Headers({ 'x-goog-api-key': config.googleTtsApiKey });
    }
    // Do not hold a cancelled voice turn open while ADC discovers/refreshes credentials.
    return new Promise<Headers>((resolve, reject) => {
      const cancel = () => { reject(signal.reason ?? new Error('Speech cancelled')); };
      signal.addEventListener('abort', cancel, { once: true });
      void auth.getRequestHeaders(googleSpeechEndpoint).then(value => {
        throwIfAborted(signal);
        resolve(new Headers(value));
      }).catch(() => {
        if (signal.aborted) cancel();
        else reject(new AppError(503, 'TTS_AUTH_UNAVAILABLE', 'Speech synthesis needs Google Cloud authorization.'));
      }).finally(() => signal.removeEventListener('abort', cancel));
    });
  };
}
