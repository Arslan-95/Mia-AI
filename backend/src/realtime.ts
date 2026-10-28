import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { z } from 'zod';
import type { AuthService, User } from './auth.js';
import type { AssistantRuntime } from './agents/runtime.js';
import type { Database } from './db/database.js';
import type { Config } from './config.js';
import { AppError, throwIfAborted } from './errors.js';
import { listEvents } from './events.js';
import { MessagingService } from './messaging.js';
import type { RecognitionEvent, RecognitionStream, SpeechProvider } from './speech/providers.js';
import { eventQuery } from './routes/messaging.js';
import { assertContextAccess, clientContextSchema, deviceResultSchema, type ClientContext } from './agents/context.js';
import { PlaybackEcho, WordBargeInGate } from './speech/barge-in.js';
import { AcousticEvidence } from './speech/acoustic-evidence.js';

const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), after: eventQuery.shape.after }).strict(),
  z.object({ type: z.literal('turn'), clientTurnId: z.uuid(), text: z.string().trim().min(1).max(8000), context: clientContextSchema.optional() }).strict(),
  z.object({ type: z.literal('assistant.stop') }).strict(),
  z.object({ type: z.literal('voice.start'), requestId: z.uuid(), sampleRate: z.literal(24000), format: z.literal('pcm_s16le'), context: clientContextSchema.optional(), inputProcessing: z.literal('aec-residual-v1').optional() }).strict(),
  z.object({ type: z.literal('voice.end') }).strict(),
  z.object({ type: z.literal('voice.cancel') }).strict(),
  z.object({ type: z.literal('voice.context'), context: clientContextSchema }).strict(),
  z.object({ type: z.literal('speech.playback'), turnId: z.uuid(), playing: z.boolean() }).strict(),
  z.object({ type: z.literal('speech.request'), requestId: z.uuid(), turnId: z.uuid() }).strict(),
  z.object({ type: z.literal('speech.cancel') }).strict(),
  z.object({ type: z.literal('device.result'), actionId: z.uuid(), success: z.boolean(),
    result: deviceResultSchema.default({}) }).strict(),
  z.object({ type: z.literal('ping') }).strict(),
]);

export function registerRealtime(app: FastifyInstance, deps: {
  db: Database; auth: AuthService; assistant: AssistantRuntime; speech: SpeechProvider; config: Config;
}) {
  const { db, auth, assistant, speech, config } = deps;
  const connections = new Map<string, Set<WebSocket>>();
  app.addHook('preClose', async () => {
    for (const sockets of connections.values()) for (const socket of sockets) socket.close(1001, 'Server restarting');
  });
  app.get('/v1/realtime', { websocket: true, config: { public: true } }, (socket, request) => {
    // SocketRocket/React Native supplies the API's own HTTP(S) origin even
    // though this is a native client. Browser origins still require an exact
    // allowlist match or the same origin as this request; never use '*'.
    const origin = request.headers.origin;
    let sameOrigin = false;
    if (origin && request.headers.host) {
      try { sameOrigin = origin === new URL(`${request.protocol}://${request.headers.host}`).origin; }
      catch { /* Malformed origins/hosts do not bypass the allowlist. */ }
    }
    if (origin && !sameOrigin && !config.corsOrigins.includes(origin)) {
      request.log.warn({ code: 'WS_ORIGIN_REJECTED' }, 'Realtime connection rejected');
      socket.close(1008, 'Origin is not allowed'); return;
    }
    let user: User | undefined;
    let token = '';
    let sessionId = '';
    let cursor = '0';
    let authenticating = false;
    let stopped = false;
    let unwatchSession: (() => void) | undefined;
    let reading = false;
    let alive = true;
    let queue = Promise.resolve();
    let speechQueue = Promise.resolve();
    let recognition: RecognitionStream | undefined;
    let recognitionController: AbortController | undefined;
    let recognitionId: string | undefined;
    let voiceStartedAt = 0;
    let voiceGeneration: number | undefined;
    let voiceContext: ClientContext | undefined;
    let receivedBytes = 0;
    let voiceTimer: ReturnType<typeof setTimeout> | undefined;
    let voiceEndTimer: ReturnType<typeof setTimeout> | undefined;
    let synthesis: AbortController | undefined;
    let synthesisGeneration: number | undefined;
    let controls = 0;
    let voiceEpoch = 0;
    let speechEpoch = 0;
    let windowStarted = Date.now();
    const lifetime = new AbortController();
    const requestedSpeech = new Set<string>();
    const starts: number[] = [];
    const finalTranscripts = new Map<number, string>();
    const utteranceContexts = new Map<number, ClientContext | undefined>();
    const completedSpeech = new Set<number>();
    const wordGate = new WordBargeInGate();
    const stableWords = new Map<number, ReturnType<typeof setTimeout>>();
    let latestSpeechTurn: number | undefined;
    const acoustic = new AcousticEvidence();
    let needsAudioEvidence = false;
    const playback = new PlaybackEcho();

    const send = (value: unknown) => {
      if (stopped || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 1_000_000) { socket.close(1013, 'Reconnect and replay events'); return; }
      socket.send(JSON.stringify(value));
    };
    const failure = (error: unknown) => send({ type: 'error', error: error instanceof AppError
      ? { code: error.code, message: error.message } : { code: 'INVALID_REQUEST', message: 'The request could not be processed.' } });
    const cancelSpeech = () => { synthesis?.abort(); synthesis = undefined; synthesisGeneration = undefined; };
    const cancelVoice = () => {
      recognitionId = undefined;
      voiceGeneration = undefined;
      voiceContext = undefined;
      acoustic.reset(); needsAudioEvidence = false;
      for (const timer of stableWords.values()) clearTimeout(timer);
      stableWords.clear();
      recognitionController?.abort(); recognitionController = undefined;
      recognition?.close(); recognition = undefined;
      if (voiceTimer) clearTimeout(voiceTimer);
      if (voiceEndTimer) clearTimeout(voiceEndTimer);
      starts.length = 0; finalTranscripts.clear(); utteranceContexts.clear(); completedSpeech.clear(); wordGate.clear(); latestSpeechTurn = undefined;
    };
    const authTimeout = setTimeout(() => { if (!user) socket.close(1008, 'Authentication timed out'); }, 5000);
    const poll = setInterval(() => { void replay(); }, 250);
    const heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false; socket.ping();
      if (user) void validateSession();
    }, 20_000);
    socket.on('pong', () => { alive = true; });
    socket.on('error', () => socket.close());
    const cleanup = () => {
      stopped = true; lifetime.abort(); cancelVoice(); cancelSpeech();
      unwatchSession?.(); unwatchSession = undefined;
      clearTimeout(authTimeout); clearInterval(poll); clearInterval(heartbeat);
      if (user) {
        const group = connections.get(user.id); group?.delete(socket);
        if (group?.size === 0) connections.delete(user.id);
      }
    };
    const revoke = () => { cleanup(); socket.close(1008, 'Session expired'); };
    socket.on('close', cleanup);

    async function validateSession() {
      if (!user || stopped) return false;
      try { await auth.authenticate(`Bearer ${token}`); return !stopped; }
      catch { revoke(); return false; }
    }

    async function replay() {
      if (!user || reading || stopped) return;
      reading = true;
      try {
        if (!await validateSession()) return;
        const events = await listEvents(db, user.id, cursor);
        for (const event of events) {
          if (event.type === 'assistant.stopped') {
            const payload = event.payload as { sessionId: string; generation: number };
            if (payload.sessionId === sessionId && voiceGeneration !== undefined && payload.generation > voiceGeneration) cancelVoice();
          }
          if (synthesis && ['assistant.accepted', 'assistant.interrupted', 'assistant.audio_cancelled'].includes(event.type)) {
            const session = await assistant.state.requireSession(user.id, sessionId);
            if (synthesisGeneration !== undefined && session.generation !== synthesisGeneration) cancelSpeech();
          }
          send({ type: 'event', event });
          cursor = event.id;
        }
      } catch { socket.close(1011, 'Event delivery failed'); }
      finally { reading = false; }
    }

    async function interruptRecognizedWord(id: string, speechId: number, signal: AbortSignal) {
      cancelSpeech();
      send({ type: 'voice.interruption', requestId: id, speechTurnId: speechId, clientTurnId: speechTurnId(id, speechId) });
      const interrupted = await assistant.interrupt(user!.id, sessionId, signal, 'speech');
      voiceGeneration = interrupted.generation;
    }
    function scheduleStableWord(id: string, speechId: number, signal: AbortSignal) {
      clearTimeout(stableWords.get(speechId)); stableWords.delete(speechId);
      const due = wordGate.due(speechId);
      if (due === undefined) return;
      stableWords.set(speechId, setTimeout(() => {
        stableWords.delete(speechId);
        speechQueue = speechQueue.then(async () => {
          if (!user || recognitionId !== id || stopped || signal.aborted || !await validateSession() || signal.aborted) return;
          if (wordGate.confirmStable(speechId, Date.now())) await interruptRecognizedWord(id, speechId, signal);
        }).catch((error: unknown) => { if (!signal.aborted) { failure(error); cancelVoice(); } });
      }, Math.max(0, due - Date.now())));
    }
    function onRecognition(id: string, event: RecognitionEvent, signal: AbortSignal) {
      // Database work below can delay this event while newer PCM arrives.
      // Assess audio at event receipt, not against a later utterance's audio.
      const receivedAt = Date.now();
      const audioAt = Math.min(event.audioProcessedMs ?? acoustic.position, acoustic.position);
      const audible = acoustic.hasSpeech(audioAt);
      const echo = playback.at(receivedAt);
      speechQueue = speechQueue.then(async () => {
        if (!user || recognitionId !== id || stopped || signal.aborted) return;
        if (!await validateSession() || signal.aborted) return;
        if (event.type === 'speechStart') {
          if (starts.includes(event.turnId) || completedSpeech.has(event.turnId)) return;
          if (starts.length >= 8) throw new AppError(503, 'ASR_OVERFLOW', 'Too many unfinished speech turns. Please reconnect.');
          starts.push(event.turnId);
          utteranceContexts.set(event.turnId, voiceContext ? { ...voiceContext } : undefined);
          latestSpeechTurn = event.turnId; wordGate.start(event.turnId, needsAudioEvidence, audible); wordGate.hear(event.turnId, echo);
        }
        const speechId = event.type === 'speechComplete' ? event.turnId : event.type === 'transcript' ? latestSpeechTurn : undefined;
        if (speechId !== undefined) wordGate.hear(speechId, echo);
        if (speechId !== undefined && (event.type === 'transcript' || event.type === 'speechComplete')
          && wordGate.observe(speechId, event.transcript, event.type === 'speechComplete' || event.final, receivedAt, audible)) {
          // VAD/speechStart alone never stops Mia. Cancel only after the
          // recognizer confirms a stable word or a final lexical utterance.
          await interruptRecognizedWord(id, speechId, signal);
        }
        if (speechId !== undefined) scheduleStableWord(id, speechId, signal);
        throwIfAborted(signal);
        send({ type: 'voice.event', requestId: id, event });
        if (event.type !== 'speechComplete' || completedSpeech.has(event.turnId)) return;
        if (!starts.includes(event.turnId)) throw new AppError(503, 'INVALID_SPEECH_TURN', 'The speech turn has no start event.');
        finalTranscripts.set(event.turnId, wordGate.userText(event.turnId, event.transcript));
        acoustic.consumeThrough(audioAt);
        clearTimeout(stableWords.get(event.turnId)); stableWords.delete(event.turnId);
        wordGate.finish(event.turnId);
        if (starts.some((turnId) => !finalTranscripts.has(turnId))) return;
        const transcripts: string[] = [];
        let lastTurnId = event.turnId;
        let utteranceContext = utteranceContexts.get(lastTurnId);
        while (starts.length && finalTranscripts.has(starts[0]!)) {
          const turnId = starts.shift()!;
          const text = finalTranscripts.get(turnId)!;
          finalTranscripts.delete(turnId); completedSpeech.add(turnId);
          if (completedSpeech.size > 256) throw new AppError(503, 'VOICE_SESSION_LIMIT', 'Start a new speech session.');
          if (text) transcripts.push(text);
          lastTurnId = turnId; utteranceContext = utteranceContexts.get(turnId); utteranceContexts.delete(turnId);
        }
        if (transcripts.length) {
          const result = await assistant.submit(user.id, sessionId, speechTurnId(id, lastTurnId), transcripts.join(' '), signal, utteranceContext);
          send({ type: 'turn.accepted', ...result });
        }
      }).catch((error: unknown) => { if (!signal.aborted) { failure(error); cancelVoice(); } });
    }

    async function synthesize(turnId: string, requestId: string) {
      cancelSpeech();
      const controller = new AbortController();
      synthesis = controller;
      const signal = AbortSignal.any([controller.signal, lifetime.signal]);
      try {
        const turn = await assistant.state.turn(user!.id, sessionId, turnId);
        const session = await assistant.state.requireSession(user!.id, sessionId);
        throwIfAborted(signal);
        if (turn.status !== 'completed' || !turn.assistantText || turn.generation !== session.generation) {
          throw new AppError(409, 'STALE_SPEECH', 'This response is not current.');
        }
        synthesisGeneration = turn.generation;
        playback.remember(turnId, turn.assistantText);
        send({ type: 'speech.started', requestId, turnId, format: 'pcm_s16le', sampleRate: 24000, channels: 1 });
        let sequence = 0;
        let totalBytes = 0;
        for await (const bytes of speech.synthesize(turn.assistantText, signal)) {
          throwIfAborted(signal);
          const current = await assistant.state.requireSession(user!.id, sessionId);
          throwIfAborted(signal);
          if (current.generation !== turn.generation) { controller.abort(); break; }
          totalBytes += bytes.byteLength;
          send({ type: 'speech.chunk', requestId, turnId, sequence: sequence++, audio: Buffer.from(bytes).toString('base64') });
        }
        if (!signal.aborted) send({ type: 'speech.completed', requestId, turnId, chunks: sequence, totalBytes });
      } catch (error) {
        if (!signal.aborted) send({ type: 'speech.failed', requestId, turnId,
          code: error instanceof AppError ? error.code : 'TTS_UNAVAILABLE' });
      } finally {
        if (signal.aborted) send({ type: 'speech.cancelled', requestId, turnId });
        if (synthesis === controller) { synthesis = undefined; synthesisGeneration = undefined; }
      }
    }

    async function handle(value: unknown) {
      const frame = frameSchema.parse(value);
      if (frame.type === 'auth') {
        if (user || authenticating) throw new AppError(409, 'ALREADY_AUTHENTICATED', 'This connection already has an identity.');
        authenticating = true;
        try {
          const authenticated = await auth.authenticate(`Bearer ${frame.token}`);
          if (stopped) return;
          const session = await assistant.state.session(authenticated.id);
          if (stopped) return;
          const group = connections.get(authenticated.id) ?? new Set<WebSocket>();
          if (group.size >= 3) throw new AppError(429, 'CONNECTION_LIMIT', 'Too many active connections.');
          user = authenticated; token = frame.token; sessionId = session.id;
          group.add(socket); connections.set(user.id, group);
          unwatchSession = auth.watchSession(token, revoke);
          if (!await validateSession()) return;
          const [latest] = await db.query<{ id: string }>('SELECT COALESCE(max(id),0)::text AS id FROM events WHERE user_id = $1', [user.id]);
          cursor = BigInt(frame.after) > BigInt(latest!.id) ? '0' : frame.after;
          clearTimeout(authTimeout);
          send({ type: 'ready', sessionId, after: cursor, replayThrough: latest!.id, protocolVersion: 1 });
          await replay();
        } catch (error) { failure(error); cleanup(); socket.close(1008, 'Authentication failed'); }
        finally { authenticating = false; }
        return;
      }
      if (!user) { socket.close(1008, 'Authenticate first'); return; }
      if (!await validateSession()) return;
      if (frame.type === 'ping') { send({ type: 'pong' }); return; }
      if (frame.type === 'turn') {
        cancelSpeech(); cancelVoice();
        send({ type: 'turn.accepted', ...await assistant.submit(user.id, sessionId, frame.clientTurnId, frame.text, undefined, frame.context) });
      } else if (frame.type === 'assistant.stop') {
        cancelSpeech();
        send({ type: 'assistant.stopped', ...await assistant.interrupt(user.id, sessionId) });
      } else if (frame.type === 'voice.cancel') {
        cancelVoice(); send({ type: 'voice.cancelled' });
      } else if (frame.type === 'voice.context') {
        await assertContextAccess(db, user.id, frame.context);
        voiceContext = frame.context;
      } else if (frame.type === 'speech.playback') {
        // Tracked on receipt in the message handler, outside this queue.
      } else if (frame.type === 'voice.end') {
        recognition?.end();
        voiceEndTimer = setTimeout(() => { cancelVoice(); send({ type: 'voice.closed' }); }, 10_000);
      } else if (frame.type === 'voice.start') {
        cancelVoice();
        await assertContextAccess(db, user.id, frame.context ?? null);
        recognitionId = frame.requestId;
        needsAudioEvidence = frame.inputProcessing === 'aec-residual-v1';
        voiceContext = frame.context;
        const controller = new AbortController(); recognitionController = controller;
        const contacts = await new MessagingService(db).contacts(user.id);
        try {
          voiceGeneration = (await assistant.state.requireSession(user.id, sessionId)).generation;
          const stream = await speech.recognize(contacts.map((contact) => contact.name),
            (event) => onRecognition(frame.requestId, event, controller.signal),
            () => { if (recognitionId === frame.requestId) { send({ type: 'voice.failed', requestId: frame.requestId, code: 'ASR_UNAVAILABLE' }); cancelVoice(); } },
            AbortSignal.any([controller.signal, lifetime.signal]));
          if (stopped || recognitionId !== frame.requestId) { stream.close(); return; }
          recognition = stream; voiceStartedAt = Date.now(); receivedBytes = 0;
          voiceTimer = setTimeout(() => { const requestId = recognitionId; cancelVoice(); send({ type: 'voice.closed', requestId }); }, 300_000);
          send({ type: 'voice.ready', requestId: frame.requestId, sampleRate: 24000, format: 'pcm_s16le' });
        } catch (error) {
          const cancelled = controller.signal.aborted;
          cancelVoice(); if (!cancelled) throw error;
        }
      } else if (frame.type === 'speech.cancel') {
        cancelSpeech();
      } else if (frame.type === 'speech.request') {
        if (requestedSpeech.has(frame.requestId)) throw new AppError(409, 'DUPLICATE_SPEECH', 'That speech request was already handled.');
        requestedSpeech.add(frame.requestId);
        if (requestedSpeech.size > 64) requestedSpeech.delete(requestedSpeech.values().next().value!);
        void synthesize(frame.turnId, frame.requestId);
      } else if (frame.type === 'device.result') {
        send({ type: 'device.result_accepted', action: await assistant.state.acknowledgeAction(user.id, frame.actionId, frame.success, frame.result) });
      }
    }

    socket.on('message', (data, binary) => {
      if (stopped) return;
      if (binary) {
        try {
          if (!user || !recognition) throw new AppError(409, 'VOICE_NOT_READY', 'Wait for voice.ready before streaming PCM.');
          const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
          receivedBytes += bytes.length;
          if (!bytes.length || bytes.length > 8192 || bytes.length % 2
            || receivedBytes > 96_000 + (Date.now() - voiceStartedAt) * 60) {
            throw new AppError(400, 'INVALID_AUDIO_FRAME', 'Send realtime mono 24 kHz Int16 PCM in small ordered frames.');
          }
          acoustic.observe(bytes);
          recognition.write(bytes);
        } catch (error) { failure(error); cancelVoice(); }
        return;
      }
      if (Date.now() - windowStarted > 60_000) { windowStarted = Date.now(); controls = 0; }
      if (++controls > 180) { socket.close(1008, 'Too many requests'); return; }
      let value: z.infer<typeof frameSchema>;
      try { value = frameSchema.parse(JSON.parse(data.toString())); }
      catch (error) { failure(error); return; }
      // Mia's echo reaches recognition right after this frame. Record it now,
      // not behind ASR startup or database work queued for earlier frames.
      if (value.type === 'speech.playback' && user) {
        if (value.playing) playback.start(value.turnId, Date.now()); else playback.stop(value.turnId, Date.now());
      }
      if (['turn', 'voice.cancel', 'assistant.stop'].includes(value.type)) { voiceEpoch++; cancelVoice(); }
      if (['turn', 'speech.cancel', 'assistant.stop'].includes(value.type)) { speechEpoch++; cancelSpeech(); }
      const queuedVoiceEpoch = voiceEpoch;
      const queuedSpeechEpoch = speechEpoch;
      queue = queue.then(async () => {
        if (stopped || value.type === 'voice.start' && queuedVoiceEpoch !== voiceEpoch
          || value.type === 'speech.request' && queuedSpeechEpoch !== speechEpoch) return;
        await handle(value);
      }).catch(failure);
    });
  });
}

function speechTurnId(requestId: string, turnId: number) {
  const bytes = createHash('sha256').update(`${requestId}:${turnId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
