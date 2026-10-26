import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { readConfig } from '../src/config.js';
import { CloudSpeechProvider, type RecognitionEvent } from '../src/speech/providers.js';
import { inspectWav } from '../src/media.js';
import { wav } from './helpers.js';

test('speech adapters use Meta multipart transcription and aligned ElevenLabs PCM streams', async () => {
  const config = readConfig({ META_API_KEY: 'meta-test', ELEVENLABS_API_KEY: 'tts-test', ELEVENLABS_VOICE_ID: 'voice-test' });
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
    assert.ok(String(url).endsWith('/voice-test/stream?output_format=pcm_24000'));
    assert.equal(new Headers(init?.headers).get('xi-api-key'), 'tts-test');
    assert.equal((JSON.parse(String(init?.body)) as { model_id: string }).model_id, 'eleven_flash_v2_5');
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6])); controller.close();
    } }));
  };
  const speech = new CloudSpeechProvider(config, fetcher);
  assert.equal(await speech.transcribe(wav(), new AbortController().signal), 'Seven works for me.');
  const chunks: Uint8Array[] = [];
  for await (const chunk of speech.synthesize('Hello.', new AbortController().signal)) {
    assert.equal(chunk.byteLength % 2, 0); chunks.push(chunk);
  }
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3, 4, 5, 6]));
  const broken = new CloudSpeechProvider(config, async () => new Response(new Uint8Array([1, 2, 3])));
  await assert.rejects(async () => {
    for await (const _chunk of broken.synthesize('Hello.', new AbortController().signal)) { /* Consume the stream. */ }
  }, { code: 'INVALID_TTS_AUDIO' });
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
        socket.send(JSON.stringify({ type: 'speechStart', turnId: 1 }));
        socket.send(JSON.stringify({ type: 'transcript', transcript: 'hello', final: false }));
        socket.send(JSON.stringify({ type: 'speechComplete', turnId: 1, transcript: 'Hello.' }));
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
