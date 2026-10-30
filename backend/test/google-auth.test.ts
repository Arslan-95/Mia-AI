import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../src/config.js';
import { googleSpeechEndpoint, googleSpeechHeaders } from '../src/speech/google-auth.js';

test('standard API-key speech does not discover Google account credentials', async () => {
  let lookups = 0;
  const authorize = googleSpeechHeaders(readConfig({ GOOGLE_TTS_API_KEY: 'server-key' }), {
    getRequestHeaders: async () => { lookups++; throw new Error('No ADC should be read.'); },
  });
  const headers = await authorize(new AbortController().signal);
  assert.equal(headers.get('x-goog-api-key'), 'server-key');
  assert.equal(headers.has('authorization'), false); assert.equal(lookups, 0);
});

test('ADC speech requests current headers for each synthesis and preserves the quota project', async () => {
  let calls = 0;
  const authorize = googleSpeechHeaders(readConfig({ GOOGLE_TTS_MODEL: 'gemini-3.1-flash-tts-preview' }), {
    getRequestHeaders: async url => {
      assert.equal(url, googleSpeechEndpoint);
      return new Headers({ authorization: `Bearer token-${++calls}`, 'x-goog-user-project': 'speech-project' });
    },
  });
  const signal = new AbortController().signal;
  const first = await authorize(signal), next = await authorize(signal);
  assert.equal(first.get('authorization'), 'Bearer token-1');
  assert.equal(next.get('authorization'), 'Bearer token-2');
  assert.equal(next.get('x-goog-user-project'), 'speech-project');
  assert.equal(next.has('x-goog-api-key'), false);
});

test('a cancelled ADC discovery rejects immediately and cannot return late credentials', async () => {
  let finishCredentials!: (headers: Headers) => void;
  const credentials = new Promise<Headers>(resolve => { finishCredentials = resolve; });
  const controller = new AbortController();
  const authorize = googleSpeechHeaders(readConfig({ GOOGLE_TTS_MODEL: 'gemini-3.1-flash-tts-preview' }), {
    getRequestHeaders: () => credentials,
  });
  const pending = authorize(controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  finishCredentials(new Headers({ authorization: 'Bearer late-token' }));
  await Promise.resolve();
});

test('ADC failures expose neither credential paths nor provider details', async () => {
  const authorize = googleSpeechHeaders(readConfig({ GOOGLE_TTS_MODEL: 'gemini-3.1-flash-tts-preview' }), {
    getRequestHeaders: async () => { throw new Error('private credential contents and path'); },
  });
  await assert.rejects(() => authorize(new AbortController().signal), {
    code: 'TTS_AUTH_UNAVAILABLE', message: 'Speech synthesis needs Google Cloud authorization.',
  });
});
