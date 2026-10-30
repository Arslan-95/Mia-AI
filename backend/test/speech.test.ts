import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { readConfig } from '../src/config.js';
import { CloudSpeechProvider, type RecognitionEvent } from '../src/speech/providers.js';
import { inspectWav } from '../src/media.js';
import { wav } from './helpers.js';

function synthesizedWav(pcm = Buffer.from([1, 2, 3, 4, 5, 6]), rate = 24_000) {
  const audio = Buffer.concat([wav(0), pcm]);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.writeUInt32LE(rate, 24); audio.writeUInt32LE(rate * 2, 28);
  audio.writeUInt32LE(pcm.length, 40);
  return audio;
}

async function spokenAudio(provider: CloudSpeechProvider, text = 'Hello.', signal = new AbortController().signal) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of provider.synthesize(text, signal)) {
    assert.equal(chunk.byteLength % 2, 0);
    assert.ok(chunk.byteLength <= 12_000);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

test('speech adapters use Meta transcription and Google API-key synthesis without leaking WAV headers', async () => {
  const config = readConfig({ META_API_KEY: 'meta-test', GOOGLE_TTS_API_KEY: 'tts-test' });
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).includes('/asr/transcribe')) {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer meta-test');
      assert.ok(init?.body instanceof FormData);
      const request = init.body.get('request');
      assert.ok(request instanceof Blob);
      const settings = JSON.parse(await request.text()) as Record<string, unknown>;
      assert.equal(settings.mode, 'PUSH_TO_TALK');
      assert.equal(settings.model, 'muse-voice-transcribe-1.0');
      return Response.json({ transcript: ' Seven works for me. ' });
    }
    assert.equal(String(url), 'https://texttospeech.googleapis.com/v1/text:synthesize');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'tts-test');
    assert.ok(!String(url).includes('tts-test'));
    assert.deepEqual(JSON.parse(String(init?.body)), { input: { ssml: '<speak><google:style name="calm">Hello.</google:style></speak>' },
      voice: { languageCode: 'en-US', name: 'en-US-Neural2-F' },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24_000 } });
    return Response.json({ audioContent: synthesizedWav().toString('base64') });
  };
  const speech = new CloudSpeechProvider(config, fetcher);
  assert.equal(speech.synthesisConfigured, true);
  assert.equal(await speech.transcribe(wav(), new AbortController().signal), 'Seven works for me.');
  assert.deepEqual(await spokenAudio(speech), Buffer.from([1, 2, 3, 4, 5, 6]));
});

test('calm delivery treats source markup as literal text and budgets escaped SSML chunks', async () => {
  const source = 'Hi <Ben> & "friends" 👩‍💻. '.repeat(800).trim();
  const parts: string[] = [];
  const provider = new CloudSpeechProvider(readConfig({ GOOGLE_TTS_API_KEY: 'tts-test' }), async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: { ssml: string; text?: string } };
    assert.equal(body.input.text, undefined);
    assert.ok(Buffer.byteLength(body.input.ssml, 'utf8') <= 4800, 'the limit includes entities and wrapper tags');
    assert.ok(body.input.ssml.startsWith('<speak><google:style name="calm">'));
    assert.ok(body.input.ssml.endsWith('</google:style></speak>'));
    assert.equal(body.input.ssml.includes('<Ben>'), false);
    const encoded = body.input.ssml.replace(/^<speak><google:style name="calm">|<\/google:style><\/speak>$/g, '');
    assert.equal(encoded.includes('\uFFFD'), false);
    parts.push(encoded.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    return Response.json({ audioContent: synthesizedWav().toString('base64') });
  });
  await spokenAudio(provider, source);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(' '), source);
  assert.ok(parts.every(part => part.endsWith('.')), 'whole sentences stay together when they fit');
});

test('Neural2 can return to its original delivery without interpreting source markup', async () => {
  const source = '<break time="10s"/> & goodbye.';
  const provider = new CloudSpeechProvider(readConfig({ GOOGLE_TTS_API_KEY: 'tts-test', GOOGLE_TTS_STYLE: 'none' }), async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: unknown };
    assert.deepEqual(body.input, { text: source });
    return Response.json({ audioContent: synthesizedWav().toString('base64') });
  });
  await spokenAudio(provider, source);
});

test('Google TTS rejects missing credentials, provider errors and malformed audio', async () => {
  let requests = 0;
  const missing = new CloudSpeechProvider(readConfig({}), async () => { requests++; return Response.json({}); });
  assert.equal(missing.synthesisConfigured, false);
  await assert.rejects(() => spokenAudio(missing), { code: 'TTS_UNAVAILABLE' });
  assert.equal(requests, 0);
  const config = readConfig({ GOOGLE_TTS_API_KEY: 'tts-test' });
  const brokenBodies = [
    {}, { audioContent: 'not base64' }, { audioContent: Buffer.from([1, 2, 3]).toString('base64') },
    { audioContent: synthesizedWav(Buffer.from([1, 2, 3])).toString('base64') },
    { audioContent: synthesizedWav(Buffer.from([1, 2]), 16_000).toString('base64') },
  ];
  for (const body of brokenBodies) {
    const provider = new CloudSpeechProvider(config, async () => Response.json(body));
    await assert.rejects(() => spokenAudio(provider), { code: 'INVALID_TTS_AUDIO' });
  }
  const provider = new CloudSpeechProvider(config, async () => Response.json({ error: 'private provider detail' }, { status: 403 }));
  await assert.rejects(() => spokenAudio(provider), { code: 'TTS_UNAVAILABLE', message: 'Speech synthesis is temporarily unavailable.' });
});

test('Google TTS splits long Unicode text within the byte limit and respects the configured voice', async () => {
  const parts: string[] = [];
  const source = 'Hello 👋 '.repeat(1200).trim();
  const provider = new CloudSpeechProvider(readConfig({ GOOGLE_TTS_API_KEY: 'tts-test', GOOGLE_TTS_VOICE: 'en-US-Chirp3-HD-Aoede' }), async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: { text: string }; voice: { name: string } };
    assert.ok(Buffer.byteLength(body.input.text, 'utf8') <= 4800);
    assert.ok(!body.input.text.includes('\uFFFD'));
    assert.equal(body.voice.name, 'en-US-Chirp3-HD-Aoede');
    parts.push(body.input.text);
    return Response.json({ audioContent: synthesizedWav().toString('base64') });
  });
  const output = await spokenAudio(provider, source);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(' '), source);
  assert.equal(output.length, parts.length * 6);
});

test('Google TTS cancels pending requests and stops producing buffered speech after interruption', async () => {
  const config = readConfig({ GOOGLE_TTS_API_KEY: 'tts-test' });
  const cancelled = new AbortController();
  cancelled.abort();
  let requests = 0;
  const unused = new CloudSpeechProvider(config, async () => { requests++; return Response.json({}); });
  await assert.rejects(() => spokenAudio(unused, 'Hello.', cancelled.signal), { name: 'AbortError' });
  assert.equal(requests, 0);
  const pending = new AbortController();
  const waiting = new CloudSpeechProvider(config, async (_url, init) => {
    assert.ok(init?.signal);
    const signal = init.signal;
    pending.abort();
    signal.throwIfAborted();
    throw new Error('Expected cancellation');
  });
  await assert.rejects(() => spokenAudio(waiting, 'Hello.', pending.signal), { name: 'AbortError' });
  const buffered = new AbortController();
  const provider = new CloudSpeechProvider(config, async () => {
    requests++;
    return Response.json({ audioContent: synthesizedWav(Buffer.alloc(24_000)).toString('base64') });
  });
  const stream = provider.synthesize('Hello. '.repeat(1000), buffered.signal)[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value?.length, 12_000);
  buffered.abort();
  await assert.rejects(() => stream.next(), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('Meta realtime recognizer authenticates in its handshake, streams PCM and ends cleanly', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const events: RecognitionEvent[] = [];
  let failures = 0;
  let finish: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  server.on('connection', (socket) => {
    let initialized = false;
    socket.on('message', (data, binary) => {
      if (!initialized) {
        const handshake = JSON.parse(data.toString()) as Record<string, unknown>;
        assert.deepEqual(handshake.authorization, { accessToken: 'Bearer test-secret' });
        assert.equal(handshake.audioEncoding, 'PCM_24KHZ');
        assert.equal(handshake.mode, 'ENDPOINTING');
        initialized = true; socket.send(JSON.stringify({ sessionId: 'provider-session' })); return;
      }
      if (binary) {
        assert.equal(Array.isArray(data) ? Buffer.concat(data).byteLength : data.byteLength, 3840);
        socket.send(JSON.stringify({ type: 'speechStart', turnId: 1, audioProcessedMs: 40 }));
        socket.send(JSON.stringify({ type: 'transcript', transcript: 'hello', final: false, audioProcessedMs: 80 }));
        socket.send(JSON.stringify({ type: 'speechComplete', turnId: 1, transcript: 'Hello.', audioProcessedMs: 80 }));
        return;
      }
      assert.equal((JSON.parse(data.toString()) as { type: string }).type, 'endStream');
      socket.close(); finish?.();
    });
  });
  const provider = new CloudSpeechProvider(readConfig({ META_API_KEY: 'test-secret' }), fetch,
    () => new WebSocket(`ws://127.0.0.1:${address.port}`));
  const stream = await provider.recognize(['Anna'], (event) => {
    events.push(event);
    if (event.type === 'speechComplete') stream.end();
  }, () => { failures++; }, new AbortController().signal);
  stream.write(Buffer.alloc(3840));
  await completed;
  assert.deepEqual(events.map((event) => event.type), ['speechStart', 'transcript', 'speechComplete']);
  assert.deepEqual(events.map((event) => event.audioProcessedMs), [40, 80, 80]);
  assert.equal(failures, 0);
  stream.close();
});

test('invalid recording containers and unsupported formats are rejected', async () => {
  assert.throws(() => inspectWav(Buffer.alloc(100)), { code: 'INVALID_AUDIO' });
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  assert.throws(() => inspectWav(stereo), { code: 'INVALID_AUDIO' });
  const tooLong = wav(121_000);
  assert.throws(() => inspectWav(tooLong), { code: 'INVALID_AUDIO' });
  const truncated = wav().subarray(0, 100);
  assert.throws(() => inspectWav(truncated), { code: 'INVALID_AUDIO' });
});
