import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { build } from 'esbuild';
import type { Mia } from '../src/useMia';
import type { Recording } from '../src/audio/types';
import type { Frame } from '../src/realtime';
import type { ServerEvent, Turn } from '../src/types';

// Run the real hook, API and conversation loop. Only OS audio, secure storage
// and the socket transport are substituted, so React lifecycle races execute.
const root = fileURLToPath(new URL('../', import.meta.url).toString()).replaceAll('\\', '/');
const sources: Record<string, string> = {
  'react-native': `const n = globalThis.__miaNative;
    export const AccessibilityInfo = { isScreenReaderEnabled: async () => false };
    export const ActivityIndicator='ActivityIndicator', KeyboardAvoidingView='KeyboardAvoidingView', Pressable='Pressable', StatusBar='StatusBar', Text='Text', View='View', ScrollView='ScrollView', TextInput='TextInput', FlatList='FlatList', Switch='Switch';
    export const StyleSheet = { create: value => value };
    export const Linking = { openSettings: async () => {} };
    export const findNodeHandle = () => null;
    export const AppState = { currentState: 'active', addEventListener: (_, handler) => { n.appState = handler; return { remove() {} }; } };`,
  'react-native-safe-area-context': `export const SafeAreaProvider='SafeAreaProvider', SafeAreaView='SafeAreaView';`,
  '@expo/vector-icons/Ionicons': `export default 'Icon';`,
  'expo-crypto': `export { randomUUID } from 'node:crypto';`,
  './storage': `const n = globalThis.__miaNative;
    export const preferences = { get: async key => n.preferences.get(key) ?? null, set: async (key, value) => { n.preferences.set(key, value); } };
    export const sessionStorage = { read: async () => n.session, write: async value => { n.session = value; } };`,
  './audio/engine': `import { CancelledError, UserFacingError } from '${root}/src/errors';
    const n = globalThis.__miaNative;
    export class Engine {
      constructor() { n.engine = this; }
      async captureCommand(signal) {
        n.captures++;
        if (n.permissionDenied) throw new UserFacingError('Microphone access is off. Enable it in your iPhone settings to record.');
        return new Promise((resolve, reject) => {
          const cancel = () => { n.capture = null; reject(new CancelledError()); };
          signal.addEventListener('abort', cancel, { once: true });
          n.capture = value => { signal.removeEventListener('abort', cancel); n.capture = null; resolve(value); };
        });
      }
      async start() { n.noteRecording = true; }
      async finish() { n.noteRecording = false; return { uri: 'file:///note.wav', durationMs: 1000 }; }
      async stop() { if (n.nativeSession) n.audioConflicts++; n.playback?.(); n.playback = null; n.noteRecording = false; }
      async playPcm() { n.playbacks++; await new Promise(resolve => { n.playback = resolve; }); }
      async play(_, __, started) { started?.(); await this.playPcm(); }
      async disposeRecording(recording) { n.deleted.push(recording.uri); }
    }`,
  '../../modules/mia-voice': `const n = globalThis.__miaNative;
    const listeners = new Map();
    let heldStop;
    const native = {
      apiVersion: 2,
      addListener(name, callback) { listeners.set(name, callback); return { remove() { if (listeners.get(name) === callback) listeners.delete(name); } }; },
      async start() {
        const revision = ++n.nativeRevision; n.nativeStarts++;
        if (n.holdNativeStart) await new Promise(resolve => { n.releaseNativeStart = resolve; });
        if (revision !== n.nativeRevision) throw { code: 'CANCELLED' };
        n.nativeSession = true;
        n.nativePCM = bytes => listeners.get('pcm')?.({ audio: Buffer.from(bytes).toString('base64') });
      },
      async stop() {
        n.nativeRevision++; n.nativeStops++; n.nativePCM = null;
        await native.stopPlayback();
        if (n.holdNativeStop) {
          heldStop ??= new Promise(resolve => { n.releaseNativeStop = () => { heldStop = null; resolve(); }; });
          await heldStop;
        }
        n.nativeSession = false;
      },
      async stopPlayback() { const reject = n.nativeReject; n.nativeReject = null; if (reject) { n.playback = null; reject({ code: 'CANCELLED' }); } },
      async play() { n.playbacks++; await new Promise((resolve, reject) => { n.nativeReject = reject; n.playback = () => { n.nativeReject = null; resolve(); }; }); },
    };
    export default n.nativeAvailable ? native : null;`,
  './realtime': `const n = globalThis.__miaNative;
    export class Realtime {
      constructor(_, __, event, frame, status) { n.event = event; n.frame = frame; n.connection = status; }
      async connect() { n.connection('Connected'); }
      dispose() {}
      sendAudio() { n.pcmPackets++; return true; }
      send(frame) {
        n.frames.push(frame);
        if (frame.type === 'voice.start' && !n.holdASR) queueMicrotask(() => n.frame({ type: 'voice.ready', requestId: frame.requestId }));
        if (frame.type === 'speech.request') queueMicrotask(() => {
          if (n.failSpeech) { n.frame({ type: 'speech.failed', requestId: frame.requestId }); return; }
          n.frame({ type: 'speech.chunk', requestId: frame.requestId, sequence: 0, audio: 'AAA=' });
          n.frame({ type: 'speech.completed', requestId: frame.requestId, chunks: 1, totalBytes: 2 });
        });
        return true;
      }
    }`,
};
const bundle = build({
  stdin: { contents: `export { useMia } from './src/useMia'; export { default as App } from './src/App';`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
  define: { 'process.env.EXPO_PUBLIC_API_URL': JSON.stringify('http://mia.test') },
  plugins: [{ name: 'native-test', setup(build) {
    build.onResolve({ filter: /^(react-native|react-native-safe-area-context|@expo\/vector-icons\/Ionicons|expo-crypto|\.\/storage|\.\/audio\/engine|\.\.\/\.\.\/modules\/mia-voice|\.\/realtime)$/ }, args => ({ path: args.path, namespace: 'native-test' }));
    build.onLoad({ filter: /.*/, namespace: 'native-test' }, args => ({ contents: sources[args.path], resolveDir: root }));
  } }],
});
const realFetch = globalThis.fetch;
const realFormData = globalThis.FormData;
const session = { token: 'token', expiresAt: '2099-01-01', user: { id: 'user', username: 'me', displayName: 'Me', phoneNumber: '+15550000000', profileComplete: true } };
const assistantSession = { id: 'assistant', generation: 0, activeChatId: null };
const chat = { id: 'anna', recipient: { id: 'recipient', username: 'anna', displayName: 'Anna' }, unreadCount: 0, lastMessage: null };

async function mount(mode = false, renderApp = false, nativeAvailable = false) {
  const code = (await bundle).outputFiles[0]!.text;
  const n = {
    session, preferences: new Map([['mia.ai_mode', String(mode)]]), captures: 0, playbacks: 0, deleted: [] as string[],
    frames: [] as Frame[], requests: [] as { path: string; method: string; body: any }[], turns: [] as Turn[],
    capture: null as ((recording: Recording | null) => void) | null, playback: null as (() => void) | null,
    appState: (_state: string) => {}, event: async (_event: ServerEvent, _time: number, _replayed?: boolean) => {}, frame: (_frame: Frame) => {},
    connection: (_status: string) => {}, offline: false, holdHealth: false, healthHeld: false, healthCancelled: false,
    noteRecording: false, complete: true, text: 'Open Anna', holdRecognition: false, recognitionCancelled: false, failSpeech: false, permissionDenied: false, dropAcceptedTurn: false,
    nativeAvailable, nativeStarts: 0, nativeStops: 0, nativePCM: null as ((bytes: Uint8Array) => void) | null,
    nativeReject: null as ((reason: unknown) => void) | null, pcmPackets: 0,
    nativeRevision: 0, nativeSession: false, audioConflicts: 0, holdNativeStart: false, holdNativeStop: false,
    releaseNativeStart: null as (() => void) | null, releaseNativeStop: null as (() => void) | null,
    holdASR: false,
  };
  (globalThis as any).__miaNative = n;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.FormData = class { append() {} } as unknown as typeof FormData;
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace('http://mia.test', ''); const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    n.requests.push({ path, method, body });
    if (n.offline) throw new Error('Network unavailable');
    const response = (body: unknown) => Response.json(body);
    if (path === '/v1/me') return response(session.user);
    if (path === '/health/ready') {
      if (n.holdHealth) {
        n.healthHeld = true;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { n.healthCancelled = true; reject(new Error('aborted')); }, { once: true });
        });
      }
      return response({ capabilities: { agent: true, speechRecognition: true, speechSynthesis: true } });
    }
    if (path === '/v1/chats') return response(method === 'POST' ? { id: chat.id } : [chat]);
    if (path.startsWith('/v1/users?query=')) return response([chat.recipient]);
    if (path === '/v1/contacts' && method === 'POST') return response({ ...chat.recipient, name: 'Anna', contactId: 'contact-anna' });
    if (path === '/v1/contacts' || path === '/v1/drafts' || path.startsWith('/v1/chats/anna/messages')) return response([]);
    if (path === '/v1/assistant/sessions') return response(assistantSession);
    if (path === '/v1/assistant/sessions/assistant') return response({ turns: n.turns });
    if (path.endsWith('/stop')) {
      n.turns.forEach(turn => { if (turn.status === 'running' || turn.status === 'queued') turn.status = 'interrupted'; });
      return response({ sessionId: 'assistant', stopped: true, generation: 1 });
    }
    if (path === '/v1/media') return response({ id: 'media' });
    if (path === '/v1/speech/transcriptions') {
      if (n.holdRecognition) return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { n.recognitionCancelled = true; reject(new Error('aborted')); }, { once: true });
      });
      return response({ text: n.text });
    }
    if (path.endsWith('/turns') && method === 'POST') {
      const turn: Turn = { id: `turn-${n.turns.length}`, sessionId: 'assistant', userId: 'user', generation: n.turns.length + 1,
        userText: body.text, assistantText: n.complete ? 'Anna’s conversation is open.' : null, clientTurnId: body.clientTurnId,
        status: n.complete ? 'completed' : 'running', context: body.context };
      n.turns.push(turn);
      if (n.dropAcceptedTurn) { n.dropAcceptedTurn = false; throw new Error('Response lost after accepting the turn'); }
      return response({ turn });
    }
    if (path.includes('/turns/')) return response(n.turns.at(-1));
    if (path.startsWith('/v1/device-actions/')) return response({});
    throw new Error(`Unexpected API call: ${method} ${path}`);
  };
  const module = { exports: {} as { useMia: () => Mia; App: React.ComponentType } };
  new Function('require', 'module', 'exports', code)(createRequire(import.meta.url), module, module.exports);
  let mia!: Mia; let renderer!: ReactTestRenderer;
  function Host() { mia = module.exports.useMia(); return null; }
  function AppHost() { return React.createElement(module.exports.App); }
  await act(async () => { renderer = create(React.createElement(renderApp ? AppHost : Host)); });
  const wait = async (predicate: () => boolean) => {
    const end = Date.now() + 3000;
    while (!predicate() && Date.now() < end) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(predicate(), `Timed out: phase=${mia?.voicePhase}, error=${mia?.error}`);
  };
  await wait(() => renderApp ? n.requests.some(request => request.path === '/v1/assistant/sessions/assistant') : !!mia.assistantSession);
  return {
    n, get mia() { return mia; }, get tree() { return renderer.root; }, wait,
    async say() { assert.ok(n.capture); await act(async () => { n.capture!({ uri: 'file:///command.wav', durationMs: 2400 }); }); },
    async close() { await act(async () => { renderer.unmount(); }); globalThis.fetch = realFetch; globalThis.FormData = realFormData; delete (globalThis as any).__miaNative; },
  };
}

test('ai_mode starts one global conversation, speaks automatically and keeps listening after a reply and tab navigation', async () => {
  const h = await mount();
  try {
    assert.equal(h.n.captures, 0);
    await act(async () => { await h.mia.saveAiMode(true); });
    await h.wait(() => !!h.n.capture);
    assert.equal(h.mia.tab, 'chats');
    await h.say(); await h.wait(() => h.n.playbacks === 1);
    assert.equal(h.mia.voicePhase, 'speaking'); assert.equal(h.n.captures, 1);
    assert.deepEqual(h.n.turns[0]?.context, { route: '/chats', revision: 0 });
    await act(async () => { h.n.playback!(); });
    await h.wait(() => h.n.captures === 2);
    await act(async () => { await h.mia.navigate('people'); });
    await h.wait(() => !!h.n.capture);
    assert.equal(h.mia.tab, 'people'); assert.equal(h.mia.aiMode, true);
    h.n.text = 'Find David'; await h.say(); await h.wait(() => h.n.playbacks === 2);
    assert.equal(h.n.turns[1]?.context?.route, '/contacts');
    await act(async () => { await h.mia.saveAiMode(false); });
    assert.equal(h.n.capture, null); assert.equal(h.mia.voicePhase, 'off');
    assert.equal(h.n.preferences.get('mia.ai_mode'), 'false');
  } finally { await h.close(); }
});

test('disabling ai_mode while recognizing cancels the request and never submits a turn', async () => {
  const h = await mount(true);
  try {
    await h.wait(() => !!h.n.capture); h.n.holdRecognition = true; await h.say();
    assert.equal(h.mia.voicePhase, 'transcribing');
    await act(async () => { await h.mia.saveAiMode(false); });
    assert.equal(h.n.recognitionCancelled, true); assert.equal(h.n.turns.length, 0);
    assert.deepEqual(h.n.deleted, ['file:///command.wav']); assert.equal(h.mia.voicePhase, 'off');
    assert.equal(h.mia.voiceFault, false); assert.equal(h.mia.error, '');
  } finally { await h.close(); }
});

test('voice commands retain the open chat and a server open_chat action does not switch to an assistant page', async () => {
  const h = await mount(true);
  try {
    await act(async () => { await h.mia.navigate('chats', 'anna'); });
    await h.wait(() => !!h.n.capture); h.n.complete = false; await h.say();
    const turn = h.n.turns[0]!;
    assert.equal(turn.context?.route, '/chat/anna');
    await act(async () => {
      await h.n.event({ id: 'action', type: 'device.action_requested', createdAt: new Date().toISOString(), payload: {
        actionId: 'open', turnId: turn.id, kind: 'open_chat', payload: { chatId: 'anna' }, context: turn.context,
      } }, 0);
    });
    await h.wait(() => h.n.requests.some(request => request.path === '/v1/device-actions/open/result'));
    assert.equal(h.mia.tab, 'chats'); assert.equal(h.mia.activeChatId, 'anna'); assert.equal(h.mia.aiMode, true);
    turn.status = 'completed'; turn.assistantText = 'Anna’s conversation is open.';
    await h.wait(() => h.n.playbacks === 1);
    await act(async () => { h.n.playback!(); }); await h.wait(() => !!h.n.capture);
    assert.equal(h.mia.voicePhase, 'listening');
  } finally { await h.close(); }
});

test('backgrounding releases the microphone and returning resumes the enabled voice mode', async () => {
  const h = await mount(true);
  try {
    await h.wait(() => !!h.n.capture);
    await act(async () => { h.n.appState('background'); });
    assert.equal(h.n.capture, null); assert.equal(h.mia.voicePhase, 'paused'); assert.equal(h.mia.aiMode, true);
    await act(async () => { h.n.appState('active'); });
    await h.wait(() => !!h.n.capture); assert.equal(h.mia.voicePhase, 'listening');
  } finally { await h.close(); }
});

test('recording a voice note suspends command capture through preview and discard', async () => {
  const h = await mount(true);
  try {
    await h.wait(() => !!h.n.capture);
    await act(async () => { await h.mia.startRecording(); });
    assert.equal(h.n.capture, null); assert.equal(h.mia.audioState, 'recording');
    await act(async () => { await h.mia.finishRecording(); });
    assert.ok(h.mia.recording); assert.equal(h.n.capture, null);
    await act(async () => { await h.mia.discardRecording(); });
    await h.wait(() => !!h.n.capture); assert.equal(h.mia.aiMode, true);
  } finally { await h.close(); }
});

test('leaving a live voice-note recording resumes the enabled assistant in the new view', async () => {
  const h = await mount(true);
  try {
    await h.wait(() => !!h.n.capture);
    await act(async () => { await h.mia.startRecording(); });
    await act(async () => { await h.mia.navigate('people'); });
    await h.wait(() => !!h.n.capture);
    assert.equal(h.mia.audioState, 'idle'); assert.equal(h.mia.voicePhase, 'listening');
    assert.equal(h.mia.tab, 'people'); assert.equal(h.mia.aiMode, true);
  } finally { await h.close(); }
});

test('a failed spoken response stops with a retry control and can resume without a separate assistant screen', async () => {
  const h = await mount(true);
  try {
    await h.wait(() => !!h.n.capture); h.n.failSpeech = true;
    await h.say(); await h.wait(() => h.mia.voiceFault);
    assert.equal(h.mia.voicePhase, 'waiting'); assert.equal(h.n.capture, null); assert.equal(h.mia.aiMode, true);
    h.n.failSpeech = false;
    await act(async () => { await h.mia.resumeAssistant(); });
    await h.wait(() => !!h.n.capture);
    assert.equal(h.mia.voiceFault, false); assert.equal(h.mia.error, '');
    assert.equal(h.mia.tab, 'chats');
  } finally { await h.close(); }
});

test('a temporary network failure automatically returns to listening without replaying the failed spoken request', async () => {
  const h = await mount(true);
  try {
    await h.wait(() => !!h.n.capture); h.n.offline = true; await h.say();
    await h.wait(() => h.mia.voiceFault);
    assert.equal(h.mia.voicePhase, 'waiting'); assert.equal(h.mia.aiMode, true); assert.equal(h.n.capture, null);
    h.n.offline = false;
    await h.wait(() => !!h.n.capture);
    assert.equal(h.mia.voiceFault, false); assert.equal(h.mia.error, '');
    assert.equal(h.n.turns.length, 0, 'reconnection must not repeat a possibly accepted command');
    h.n.text = 'Read my conversation'; await h.say(); await h.wait(() => h.n.playbacks === 1);
    assert.equal(h.n.turns.length, 1); assert.equal(h.n.turns[0]?.userText, 'Read my conversation');
  } finally { await h.close(); }
});

test('a socket disconnection during speech returns to listening after reconnection without replaying the reply', async () => {
  const h = await mount(true);
  try {
    await h.wait(() => !!h.n.capture); await h.say(); await h.wait(() => h.n.playbacks === 1);
    await act(async () => { h.n.connection('Offline · reconnecting'); });
    assert.equal(h.mia.voicePhase, 'waiting'); assert.equal(h.n.capture, null); assert.equal(h.mia.aiMode, true);
    await act(async () => { h.n.connection('Connected'); });
    await h.wait(() => !!h.n.capture);
    assert.equal(h.mia.voicePhase, 'listening'); assert.equal(h.n.turns.length, 1); assert.equal(h.n.playbacks, 1);
  } finally { await h.close(); }
});

test('turning off during automatic recovery aborts the health request and cannot reopen the microphone', async () => {
  const h = await mount(true);
  try {
    await h.wait(() => !!h.n.capture); h.n.offline = true; await h.say();
    await h.wait(() => h.mia.voiceFault); h.n.offline = false; h.n.holdHealth = true;
    await h.wait(() => h.n.healthHeld);
    await act(async () => { await h.mia.saveAiMode(false); });
    assert.equal(h.n.healthCancelled, true); assert.equal(h.n.capture, null); assert.equal(h.mia.voicePhase, 'off');
  } finally { await h.close(); }
});

test('losing a turn acknowledgement stops the accepted task and recovers without sending the same utterance again', async () => {
  const h = await mount(true);
  try {
    await h.wait(() => !!h.n.capture); h.n.complete = false; h.n.dropAcceptedTurn = true;
    await h.say(); await h.wait(() => h.mia.voiceFault);
    assert.equal(h.n.turns.length, 1); assert.equal(h.n.turns[0]?.status, 'interrupted');
    await h.wait(() => !!h.n.capture);
    assert.equal(h.n.turns.length, 1);
    assert.equal(h.n.requests.filter(request => request.path.endsWith('/turns') && request.method === 'POST').length, 1);
    assert.equal(h.mia.aiMode, true); assert.equal(h.mia.voicePhase, 'listening');
  } finally { await h.close(); }
});

test('microphone permission failures remain actionable without automatically reopening the permission flow', async () => {
  const h = await mount();
  try {
    h.n.permissionDenied = true;
    await act(async () => { await h.mia.saveAiMode(true); });
    await h.wait(() => h.mia.voiceFault);
    const checks = h.n.requests.filter(request => request.path === '/health/ready').length;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2200)); });
    assert.equal(h.mia.voicePhase, 'error'); assert.equal(h.n.captures, 1);
    assert.equal(h.n.requests.filter(request => request.path === '/health/ready').length, checks);
  } finally { await h.close(); }
});

test('the real application shows one round Mia control between the two left and two right tabs on every screen', async () => {
  const h = await mount(false, true);
  try {
    const controls = () => h.tree.findAll(node => node.type === 'Pressable' as any && (node.props.accessibilityRole === 'tab' || node.props.accessibilityRole === 'switch'));
    assert.deepEqual(controls().map(node => node.props.accessibilityRole), ['tab', 'tab', 'switch', 'tab', 'tab']);
    assert.deepEqual(controls().filter(node => node.props.accessibilityRole === 'tab').map(node => node.props.accessibilityLabel), ['Chats', 'People', 'Drafts', 'Settings']);
    const orb = controls()[2]!;
    const ring = orb.props.style({ pressed: false })[0];
    assert.equal(ring.width, ring.height); assert.equal(ring.borderRadius, ring.width / 2);
    await act(async () => { orb.props.onPress(); }); await h.wait(() => !!h.n.capture);
    for (const label of ['People', 'Drafts', 'Settings', 'Chats']) {
      await act(async () => { controls().find(node => node.props.accessibilityLabel === label)!.props.onPress(); });
      await h.wait(() => !!h.n.capture);
      assert.equal(controls()[2]!.props.accessibilityState.checked, true);
      assert.equal(controls().length, 5);
    }
    await act(async () => { controls()[2]!.props.onPress(); });
    await h.wait(() => h.n.capture === null);
    assert.equal(controls()[2]!.props.accessibilityState.checked, false);
  } finally { await h.close(); }
});

test('replaying a backlog of service events does not fan out into per-event HTTP requests or interrupt listening', async () => {
  const h = await mount(true);
  try {
    await h.wait(() => !!h.n.capture);
    const before = h.n.requests.length; const connectedAt = Date.now();
    await act(async () => {
      for (let index = 0; index < 118; index++) await h.n.event({ id: String(index),
        type: index % 2 ? 'assistant.stopped' : 'assistant.audio_cancelled',
        createdAt: new Date(connectedAt - 10000).toISOString(), payload: { sessionId: 'assistant' },
      }, connectedAt, true);
    });
    assert.ok(h.n.requests.length - before <= 5, `${h.n.requests.length - before} requests while replaying service events`);
    assert.equal(h.mia.voicePhase, 'listening'); assert.equal(h.mia.aiMode, true);
  } finally { await h.close(); }
});

test('the native voice graph keeps capture running through playback and stops only the old reply after confirmed words', async () => {
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    assert.equal(h.n.captures, 0, 'native continuous mode must not open the file recorder');
    let requestId = h.n.frames.find(frame => frame.type === 'voice.start')!.requestId;
    const makeTurn = (id: string): Turn => ({ id, sessionId: 'assistant', userId: 'user', generation: 1, userText: 'Open Anna',
      assistantText: 'Here is Anna’s conversation.', status: 'completed', clientTurnId: `client-${id}`, context: { route: '/chats', revision: 0 } });
    const first = makeTurn('first'); h.n.turns.push(first);
    await act(async () => {
      h.n.frame({ type: 'voice.interruption', requestId, clientTurnId: first.clientTurnId });
      h.n.frame({ type: 'turn.accepted', turn: first });
    });
    await h.wait(() => h.n.playbacks === 1);
    assert.equal(h.mia.voicePhase, 'speaking'); assert.ok(h.n.nativePCM);
    await act(async () => { h.n.frame({ type: 'voice.closed', requestId }); });
    requestId = h.n.frames.filter(frame => frame.type === 'voice.start').at(-1)!.requestId;
    assert.equal(h.n.nativeStarts, 1); assert.ok(h.n.playback, 'recognition rotation must not cut off the reply');
    await act(async () => {
      h.n.nativePCM!(new Uint8Array([0, 0]));
      h.n.frame({ type: 'voice.event', requestId, event: { type: 'speechStart', turnId: 2 } });
      h.n.frame({ type: 'voice.event', requestId, event: { type: 'transcript', transcript: '[noise]', final: false } });
    });
    assert.equal(h.n.pcmPackets, 1); assert.ok(h.n.playback, 'noise or VAD onset alone must not stop playback');
    const second = makeTurn('second'); h.n.turns.push(second);
    const stops = h.n.nativeStops;
    await act(async () => { h.n.frame({ type: 'voice.interruption', requestId, clientTurnId: second.clientTurnId }); });
    assert.equal(h.n.playback, null); assert.ok(h.n.nativePCM); assert.equal(h.n.nativeStops, stops);
    await act(async () => { h.n.frame({ type: 'turn.accepted', turn: second }); });
    await h.wait(() => h.n.playbacks === 2);
    assert.equal(h.n.nativeStarts, 1, 'barge-in must preserve the capture graph and the beginning of the utterance');
    await act(async () => { await h.mia.saveAiMode(false); });
    assert.equal(h.n.nativePCM, null); assert.equal(h.mia.voicePhase, 'off');
  } finally { await h.close(); }
});

test('unmount never reconfigures Expo audio while the native graph is still shutting down', async () => {
  const h = await mount(true, false, true);
  await h.wait(() => !!h.n.nativePCM);
  h.n.holdNativeStop = true;
  try {
    await h.close();
    assert.equal(h.n.audioConflicts, 0, 'component cleanup must respect native session ownership');
    assert.ok(h.n.nativeSession, 'hold shutdown open to exercise the overlap');
  } finally {
    h.n.holdNativeStop = false; h.n.releaseNativeStop?.();
  }
});

test('voice-note playback cancels pending native startup before opening Expo audio', async () => {
  const h = await mount(false, false, true);
  try {
    h.n.holdNativeStart = true;
    await act(async () => { await h.mia.saveAiMode(true); });
    await h.wait(() => !!h.n.releaseNativeStart);
    const stops = h.n.nativeStops;
    let playback!: Promise<void>;
    await act(async () => { playback = h.mia.playMedia('note', () => {}); });
    await h.wait(() => !!h.n.playback);
    assert.ok(h.n.nativeStops > stops, 'pending native acquisition must be cancelled even before active=true');
    h.n.holdNativeStart = false;
    await act(async () => { h.n.releaseNativeStart?.(); });
    assert.equal(h.n.nativeSession, false, 'a late permission result cannot start native audio over a voice note');
    await act(async () => { h.n.playback?.(); await playback; });
    assert.equal(h.n.audioConflicts, 0);
  } finally { h.n.holdNativeStart = false; h.n.releaseNativeStart?.(); await h.close(); }
});

test('native Listening requires actual input and ASR renewal cannot remain stuck after a lost ready frame', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    assert.equal(h.mia.voicePhase, 'waiting', 'a started engine alone does not prove microphone input');
    await act(async () => { h.n.nativePCM!(new Uint8Array([0, 0])); });
    assert.equal(h.mia.voicePhase, 'listening');
    const requestId = h.n.frames.find(frame => frame.type === 'voice.start')!.requestId;
    h.n.holdASR = true;
    await act(async () => { h.n.frame({ type: 'voice.closed', requestId }); });
    assert.equal(h.mia.voicePhase, 'waiting', 'renewal must not claim recognition is listening before ready');
    for (let i = 0; i < 2; i++) {
      await act(async () => { t.mock.timers.tick(7000); h.n.nativePCM!(new Uint8Array([0, 0])); });
      assert.equal(h.mia.voiceFault, false, 'input is alive while ASR renewal is pending');
    }
    await act(async () => { t.mock.timers.tick(1000); });
    assert.equal(h.mia.voiceFault, true); assert.equal(h.n.nativePCM, null);
    assert.equal(h.mia.aiMode, true);
  } finally { await h.close(); t.mock.timers.reset(); }
});

test('lost native input automatically rebuilds capture without repeating a command or requiring another tap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    await act(async () => { h.n.nativePCM!(new Uint8Array([0, 0])); });
    assert.equal(h.mia.voicePhase, 'listening');
    const starts = h.n.nativeStarts;
    await act(async () => { t.mock.timers.tick(8000); });
    assert.equal(h.mia.voiceFault, true); assert.equal(h.mia.voicePhase, 'waiting');
    assert.equal(h.n.nativePCM, null); assert.equal(h.mia.aiMode, true);
    await act(async () => { t.mock.timers.tick(2000); });
    assert.equal(h.n.nativeStarts, starts + 1); assert.equal(h.mia.voiceFault, false);
    assert.ok(h.n.nativePCM); assert.equal(h.mia.voicePhase, 'waiting');
    await act(async () => { h.n.nativePCM!(new Uint8Array([0, 0])); });
    assert.equal(h.mia.voicePhase, 'listening'); assert.equal(h.n.turns.length, 0);
    assert.equal(h.n.audioConflicts, 0);
  } finally { await h.close(); t.mock.timers.reset(); }
});

test('People submits a formatted phone number, presents the result and adds the selected person', async () => {
  const h = await mount(false, true);
  try {
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'People')[0]!.props.onPress(); });
    const input = h.tree.findAll(node => node.type === 'TextInput' as any && node.props.accessibilityLabel === 'Find by phone number or username')[0]!;
    await act(async () => { input.props.onChangeText('+1 (202) 555-0101'); });
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Search people')[0]!.props.onPress(); });
    await h.wait(() => h.n.requests.some(request => request.path.startsWith('/v1/users?query=')));
    assert.ok(h.n.requests.some(request => request.path === `/v1/users?query=${encodeURIComponent('+1 (202) 555-0101')}`));
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Add & chat')[0]!.props.onPress(); });
    await h.wait(() => h.n.requests.some(request => request.path === '/v1/contacts' && request.method === 'POST'));
    assert.equal(h.n.requests.find(request => request.path === '/v1/contacts' && request.method === 'POST')?.body.userId, 'recipient');
    await h.wait(() => h.n.requests.some(request => request.path.startsWith('/v1/chats/anna/messages')));
    assert.equal(h.n.captures, 0, 'searching contacts must not activate the voice assistant');
  } finally { await h.close(); }
});
