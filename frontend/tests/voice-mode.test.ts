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
import type { Contact, Message, ServerEvent, Turn } from '../src/types';
import { pressGesture } from './pressability';

// Run the real hook, API and conversation loop. Only OS audio, secure storage
// and the socket transport are substituted, so React lifecycle races execute.
const root = fileURLToPath(new URL('../', import.meta.url).toString()).replaceAll('\\', '/');
const sources: Record<string, string> = {
  'react-native': `const n = globalThis.__miaNative;
    export const AccessibilityInfo = { isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }), announceForAccessibility: text => n.announcements.push(text) };
    export const Vibration = { vibrate: () => { n.vibrations++; } };
    export const Keyboard = { dismiss() {}, isVisible: () => false, addListener: (name, callback) => {
      n.keyboardHandlers.set(name, callback); return { remove() { n.keyboardHandlers.delete(name); } };
    } };
    export const Platform = { OS: 'ios' };
    export const useWindowDimensions = () => ({ width: 390, height: 844, scale: 3, fontScale: 1 });
    export const PanResponder = { create: handlers => { n.backGesture = handlers; return { panHandlers: {} }; } };
    export const Easing = { inOut: value => value, sin: x => x, linear: x => x };
    const animation = () => ({ start(callback) { if (callback) { const finish = () => callback({ finished: true }); if (n.holdAnimation) n.finishAnimation = finish; else finish(); } }, stop() {} });
    export const Animated = { add: () => 0, Value: class { setValue() {} stopAnimation() {} interpolate() { return 0; } }, View: 'AnimatedView', loop: animation, sequence: animation, timing: animation, spring: animation };
    export const ActivityIndicator='ActivityIndicator', KeyboardAvoidingView='KeyboardAvoidingView', Pressable='Pressable', StatusBar='StatusBar', Text='Text', View='View', ScrollView='ScrollView', TextInput='TextInput', FlatList='FlatList', Switch='Switch';
    export const StyleSheet = { create: value => value };
    export const Linking = { openSettings: async () => {} };
    export const findNodeHandle = () => null;
    export const AppState = { currentState: 'active', addEventListener: (_, handler) => {
      n.appStateHandlers.add(handler); n.appState = state => { AppState.currentState = state; for (const callback of n.appStateHandlers) callback(state); };
      return { remove() { n.appStateHandlers.delete(handler); } };
    } };`,
  'react-native-safe-area-context': `export const SafeAreaProvider='SafeAreaProvider', SafeAreaView='SafeAreaView'; export const useSafeAreaInsets = () => globalThis.__miaNative.insets;`,
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
      apiVersion: 3,
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
    appStateHandlers: new Set<(state: string) => void>(), announcements: [] as string[], vibrations: 0,
    keyboardHandlers: new Map<string, () => void>(), insets: { top: 47, bottom: 34, left: 0, right: 0 },
    backGesture: null as Record<string, (...args: any[]) => any> | null, holdAnimation: false, finishAnimation: null as (() => void) | null,
    savedContacts: [] as Contact[],
    history: [] as Message[],
    holdPeopleSearch: false,
    peopleSearches: [] as { query: string; signal: AbortSignal; resolve(value: Response): void; reject(error: Error): void }[],
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
    if (path.startsWith('/v1/users?query=')) {
      if (n.holdPeopleSearch) return new Promise((resolve, reject) => {
        n.peopleSearches.push({ query: decodeURIComponent(path.split('query=')[1]!), signal: init!.signal!, resolve, reject });
      });
      return response([chat.recipient]);
    }
    if (path === '/v1/contacts' && method === 'POST') { const contact = { ...chat.recipient, name: 'Anna', contactId: 'contact-anna' }; if (!n.savedContacts.length) n.savedContacts.push(contact); return response(contact); }
    if (path === '/v1/contacts') return response(n.savedContacts);
    if (path.startsWith('/v1/chats/anna/messages')) return response(n.history);
    if (path === '/v1/chats/anna/read') return response({});
    if (path === '/v1/drafts') return response([]);
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
    n, get mia(): Mia { return renderApp ? renderer.root.findAll(node => typeof node.props.mia?.saveAiMode === 'function')[0]!.props.mia : mia; }, get tree() { return renderer.root; }, wait,
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
    assert.deepEqual(h.n.turns[0]?.context, { route: '/chats', revision: 0, voice: { enabled: true, microphoneMuted: false, revision: 1 } });
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

test('voice activation requires Settings confirmation; exit requires a five-second hold and vibrates, while taps and accessibility escape preserve it', async () => {
  const h = await mount(false, true);
  try {
    const pressable = (label: string) => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === label)[0]!;
    const overlay = () => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel?.startsWith('Mia voice mode.'))[0]!;
    assert.deepEqual(h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityRole === 'tab').map(node => node.props.accessibilityLabel), ['Chats', 'People', 'Settings']);
      assert.equal(pressable('Mia voice mode'), undefined, 'no dock launcher');
      assert.equal(pressable('Enable voice mode'), undefined, 'activation is absent outside Settings');
      await act(async () => { pressable('Settings').props.onPress(); });
      await act(async () => { pressable('Enable voice mode').props.onPress(); });
      assert.equal(h.mia.aiMode, false, 'one tap must not activate');
      await act(async () => { pressable('Keep voice mode off').props.onPress(); });
      assert.equal(h.mia.aiMode, false);
      await act(async () => { pressable('Enable voice mode').props.onPress(); });
      await act(async () => { pressable('Enable voice mode now').props.onPress(); });
      await h.wait(() => !!h.n.capture);
      const blocked = h.tree.findAll(node => node.type === 'SafeAreaView' as any && node.props.pointerEvents === 'none')[0]!;
      assert.equal(blocked.props.accessibilityElementsHidden, true);
      assert.equal(blocked.props.importantForAccessibility, 'no-hide-descendants');
      assert.ok(h.tree.findAll(node => node.props.accessibilityViewIsModal === true).length);
      await act(async () => { await overlay().props.onPress(); });
      await h.wait(() => h.n.capture === null);
      assert.equal(overlay().props.accessibilityState.checked, false);
      assert.equal(h.n.preferences.get('mia.ai_mode'), 'true');
      await act(async () => { await overlay().props.onPress(); });
      await h.wait(() => !!h.n.capture);
      assert.equal(overlay().props.accessibilityState.checked, true);
      const exit = () => pressable('Hold for 5 seconds to exit voice mode');
      await act(async () => { exit().props.onPress(); overlay().props.onAccessibilityEscape(); });
      assert.equal(h.mia.aiMode, true); assert.ok(h.n.announcements.length >= 2);
      const aborted = pressGesture(overlay().props);
      await act(async () => { aborted.begin(); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); aborted.release(); });
      aborted.dispose();
      assert.equal(h.mia.aiMode, true, 'the previous short hold must not exit');
      assert.equal(h.mia.microphoneMuted, false, 'release must not become a mic tap');
      assert.equal(h.n.vibrations, 0);
      await act(async () => { exit().props.onPressIn(); h.n.appState('background'); });
      await act(async () => { h.n.appState('active'); });
      await h.wait(() => !!h.n.capture);
      const fullHold = pressGesture(exit().props);
      await act(async () => { fullHold.begin(); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 4800)); });
      assert.equal(h.mia.aiMode, true, 'less than five seconds must preserve mode');
      assert.equal(h.n.vibrations, 0);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
      await h.wait(() => h.n.capture === null);
      assert.equal(overlay(), undefined);
      assert.equal(h.n.preferences.get('mia.ai_mode'), 'false');
      assert.equal(h.n.vibrations, 1);
      fullHold.dispose();
  } finally { await h.close(); }
});

test('native touch releases preserve mic state after aborted holds, while short taps and VoiceOver activation still toggle input', async () => {
  const h = await mount(true, true);
  const gestures: ReturnType<typeof pressGesture>[] = [];
  try {
    await h.wait(() => !!h.n.capture);
    const orb = () => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel?.startsWith('Mia voice mode.'))[0]!;
    const gesture = () => { const value = pressGesture(orb().props); gestures.push(value); return value; };
    for (const muted of [false, true]) {
      assert.equal(h.mia.microphoneMuted, muted);
      const hold = gesture();
      await act(async () => { hold.begin(); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); hold.move(30, 10); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); hold.release(); });
      assert.equal(h.mia.microphoneMuted, muted, 'an aborted hold must preserve the current input state');
      assert.equal(h.mia.aiMode, true); assert.equal(h.n.vibrations, 0);
      const tap = gesture();
      await act(async () => { tap.begin(); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); tap.release(); });
      assert.equal(h.mia.microphoneMuted, !muted, 'short physical taps still work');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    }
    const cancelled = gesture();
    await act(async () => { cancelled.begin(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); cancelled.cancel(); });
    assert.equal(h.mia.microphoneMuted, false);
    await act(async () => { gesture().activate(); });
    assert.equal(h.mia.microphoneMuted, true, 'accessibility activation without a physical touch sequence still works');
    assert.equal(h.mia.aiMode, true); assert.equal(h.n.vibrations, 0);
  } finally { for (const gesture of gestures) gesture.dispose(); await h.close(); }
});

test('muting releases the microphone across navigation and foreground changes; unmuting resumes in the current context', async () => {
  const h = await mount(true);
  try {
    await h.wait(() => !!h.n.capture);
    await act(async () => { await h.mia.toggleMicrophone(); });
    assert.equal(h.mia.microphoneMuted, true); assert.equal(h.mia.aiMode, true);
    assert.equal(h.mia.voicePhase, 'paused'); assert.equal(h.n.capture, null);
    await act(async () => { await h.mia.navigate('people'); h.n.appState('background'); });
    await act(async () => { h.n.appState('active'); });
    assert.equal(h.n.capture, null);
    await act(async () => { await h.mia.toggleMicrophone(); });
    await h.wait(() => !!h.n.capture);
    await h.say(); await h.wait(() => !!h.n.playback);
    assert.equal(h.n.turns.at(-1)?.context?.route, '/contacts');
    await act(async () => { await h.mia.toggleMicrophone(); });
    assert.ok(h.n.playback, 'muting must preserve the spoken reply'); assert.equal(h.n.capture, null);
    await act(async () => { h.n.playback!(); });
    await h.wait(() => h.mia.voicePhase === 'paused');
    assert.equal(h.n.capture, null);
  } finally { await h.close(); }
});

test('muting during transcription cancels the request without sending a turn', async () => {
  const h = await mount(true);
  try {
    await h.wait(() => !!h.n.capture); h.n.holdRecognition = true; await h.say();
    await act(async () => { await h.mia.toggleMicrophone(); });
    assert.equal(h.n.recognitionCancelled, true); assert.equal(h.n.turns.length, 0);
    assert.equal(h.mia.aiMode, true); assert.equal(h.mia.microphoneMuted, true);
  } finally { await h.close(); }
});

test('rapid microphone taps gate input without stopping the speaker graph or opening Expo audio', async () => {
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    const stops = h.n.nativeStops, starts = h.n.nativeStarts;
    let first!: Promise<void>; let second!: Promise<void>;
    await act(async () => { first = h.mia.toggleMicrophone(); second = h.mia.toggleMicrophone(); });
    await act(async () => { await Promise.all([first, second]); });
    await h.wait(() => !!h.n.nativePCM);
    assert.equal(h.mia.microphoneMuted, false); assert.equal(h.n.audioConflicts, 0);
    await act(async () => { await h.mia.toggleMicrophone(); });
    assert.ok(h.n.nativePCM); assert.equal(h.n.nativeSession, true);
    const packets = h.n.pcmPackets;
    await act(async () => { h.n.nativePCM!(new Uint8Array(3840)); });
    assert.equal(h.n.pcmPackets, packets, 'muted input is neither sent nor buffered');
    assert.equal(h.n.nativeStops, stops); assert.equal(h.n.nativeStarts, starts);
  } finally { h.n.holdNativeStop = false; h.n.releaseNativeStop?.(); await h.close(); }
});

test('native mute preserves pending work and playback; Stop reply preserves mode and restarts only recognition', async () => {
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    const stream = h.n.frames.find(frame => frame.type === 'voice.start')!;
    const turn: Turn = { id: 'mute-work', sessionId: 'assistant', userId: 'user', generation: 1, userText: 'Explain messages',
      assistantText: null, status: 'running', clientTurnId: 'client-mute-work', context: stream.context as any };
    h.n.turns.push(turn);
    await act(async () => { h.n.frame({ type: 'voice.interruption', requestId: stream.requestId, clientTurnId: turn.clientTurnId }); h.n.frame({ type: 'turn.accepted', turn }); });
    const stops = h.n.nativeStops, stopRequests = h.n.requests.filter(r => r.path.endsWith('/stop')).length;
    await act(async () => { await h.mia.toggleMicrophone(); });
    assert.equal(h.mia.voicePhase, 'thinking'); assert.equal(turn.status, 'running');
    assert.equal(h.n.requests.filter(r => r.path.endsWith('/stop')).length, stopRequests);
    turn.status = 'completed'; turn.assistantText = 'I can help with messages.';
    await h.wait(() => !!h.n.playback);
    assert.equal(h.mia.voicePhase, 'speaking'); assert.equal(h.mia.microphoneMuted, true);
    const packets = h.n.pcmPackets; await act(async () => { h.n.nativePCM!(new Uint8Array(3840)); });
    assert.equal(h.n.pcmPackets, packets); assert.equal(h.n.nativeStops, stops);
    await act(async () => { await h.mia.toggleMicrophone(); });
    assert.ok(h.n.playback, 'unmuting does not cancel the reply');
    await act(async () => { await h.mia.stopAssistantReply(); });
    assert.equal(h.n.playback, null); assert.equal(h.mia.aiMode, true); assert.equal(h.n.nativeStops, stops);
    assert.ok(h.n.frames.filter(f => f.type === 'voice.start').length >= 3);
  } finally { await h.close(); }
});

test('a confirmed agent exit reports the actual off state and finishes its reply before releasing audio', async () => {
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    const stream = h.n.frames.find(frame => frame.type === 'voice.start')!;
    const turn: Turn = { id: 'exit-turn', sessionId: 'assistant', userId: 'user', generation: 1, userText: 'Back to the messenger',
      assistantText: null, status: 'running', clientTurnId: 'client-exit', context: stream.context as any };
    h.n.turns.push(turn);
    await act(async () => { h.n.frame({ type: 'voice.interruption', requestId: stream.requestId, clientTurnId: turn.clientTurnId }); h.n.frame({ type: 'turn.accepted', turn }); });
    const stops = h.n.nativeStops;
    await act(async () => { await h.n.event({ id: 'exit-action', type: 'device.action_requested', createdAt: new Date().toISOString(), payload: {
      sessionId: 'assistant', turnId: turn.id, actionId: 'exit-action', kind: 'set_voice_mode', payload: { enabled: false }, context: turn.context,
    } }, Date.now() - 1000); });
    const feedback = h.n.requests.find(r => r.path === '/v1/device-actions/exit-action/result')!.body;
    assert.equal(feedback.success, true); assert.equal(feedback.result.voice.enabled, false);
    assert.equal(h.mia.aiMode, false); assert.equal(h.n.preferences.get('mia.ai_mode'), 'false');
    assert.equal(h.n.nativeStops, stops); assert.equal(turn.status, 'running');
    turn.status = 'completed'; turn.assistantText = 'Voice mode is off.';
    await h.wait(() => !!h.n.playback); assert.ok(h.n.nativePCM);
    await act(async () => { h.n.playback!(); });
    await h.wait(() => h.n.nativePCM === null);
    assert.equal(h.mia.voicePhase, 'off');
  } finally { await h.close(); }
});

test('an old voice action cannot override a newer microphone choice', async () => {
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM); const stream = h.n.frames.find(f => f.type === 'voice.start')!;
    const turn: Turn = { id: 'stale-control', sessionId: 'assistant', userId: 'user', generation: 1, userText: 'Explain', assistantText: null,
      status: 'running', clientTurnId: 'client-stale', context: stream.context as any };
    h.n.turns.push(turn);
    await act(async () => { h.n.frame({ type: 'voice.interruption', requestId: stream.requestId, clientTurnId: turn.clientTurnId }); h.n.frame({ type: 'turn.accepted', turn }); });
    await act(async () => { await h.mia.toggleMicrophone(); });
    await act(async () => { await h.n.event({ id: 'stale-action', type: 'device.action_requested', createdAt: new Date().toISOString(), payload: {
      sessionId: 'assistant', turnId: turn.id, actionId: 'stale-action', kind: 'set_voice_mode', payload: { enabled: false }, context: turn.context,
    } }, Date.now() - 1000); });
    assert.equal(h.n.requests.find(r => r.path === '/v1/device-actions/stale-action/result')!.body.success, false);
    assert.equal(h.mia.aiMode, true); assert.equal(h.mia.microphoneMuted, true);
  } finally { await h.close(); }
});

test('a late confirmed exit after playback finished releases audio instead of waiting for a nonexistent farewell', async () => {
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM); const stream = h.n.frames.find(f => f.type === 'voice.start')!;
    const turn: Turn = { id: 'late-exit', sessionId: 'assistant', userId: 'user', generation: 1, userText: 'Exit', assistantText: 'Okay.',
      status: 'completed', clientTurnId: 'client-late-exit', context: stream.context as any };
    h.n.turns.push(turn);
    await act(async () => { h.n.frame({ type: 'voice.interruption', requestId: stream.requestId, clientTurnId: turn.clientTurnId }); h.n.frame({ type: 'turn.accepted', turn }); });
    await h.wait(() => !!h.n.playback); await act(async () => { h.n.playback!(); });
    await h.wait(() => h.mia.voicePhase !== 'speaking');
    await act(async () => { await h.n.event({ id: 'late-exit-action', type: 'device.action_requested', createdAt: new Date().toISOString(), payload: {
      sessionId: 'assistant', turnId: turn.id, actionId: 'late-exit-action', kind: 'set_voice_mode', payload: { enabled: false }, context: turn.context,
    } }, Date.now() - 1000); });
    await h.wait(() => h.n.nativePCM === null);
    assert.equal(h.mia.aiMode, false); assert.equal(h.mia.voicePhase, 'off');
  } finally { await h.close(); }
});

test('confirmed controls in one agent turn can chain without treating their own revision as a manual override', async () => {
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM); const stream = h.n.frames.find(f => f.type === 'voice.start')!;
    const turn: Turn = { id: 'control-chain', sessionId: 'assistant', userId: 'user', generation: 1, userText: 'Mute and leave', assistantText: null,
      status: 'running', clientTurnId: 'client-chain', context: stream.context as any };
    h.n.turns.push(turn);
    await act(async () => { h.n.frame({ type: 'voice.interruption', requestId: stream.requestId, clientTurnId: turn.clientTurnId }); h.n.frame({ type: 'turn.accepted', turn }); });
    for (const [actionId, kind, payload] of [['chain-mute', 'set_microphone_muted', { muted: true }], ['chain-exit', 'set_voice_mode', { enabled: false }]] as const) {
      await act(async () => { await h.n.event({ id: actionId, type: 'device.action_requested', createdAt: new Date().toISOString(), payload: {
        sessionId: 'assistant', turnId: turn.id, actionId, kind, payload, context: turn.context,
      } }, Date.now() - 1000); });
      assert.equal(h.n.requests.find(r => r.path === `/v1/device-actions/${actionId}/result`)!.body.success, true);
    }
    assert.equal(h.mia.aiMode, false);
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
      // During playback the echo gate holds 200 ms while deciding.
      for (let packet = 0; packet < 3; packet++) h.n.nativePCM!(new Uint8Array(3840));
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
    await h.wait(() => h.n.requests.some(request => request.path.startsWith('/v1/users?query=')));
    assert.ok(h.n.requests.some(request => request.path === `/v1/users?query=${encodeURIComponent('+1 (202) 555-0101')}`));
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Add Anna and open chat')[0]!.props.onPress(); });
    await h.wait(() => h.n.requests.some(request => request.path === '/v1/contacts' && request.method === 'POST'));
    assert.equal(h.n.requests.find(request => request.path === '/v1/contacts' && request.method === 'POST')?.body.userId, 'recipient');
    await h.wait(() => h.n.requests.some(request => request.path.startsWith('/v1/chats/anna/messages')));
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Back')[0]!.props.onPress(); });
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'People')[0]!.props.onPress(); });
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Anna, @anna')[0]!.props.onPress(); });
    await h.wait(() => h.mia.activeChatId === 'anna');
    assert.equal(h.n.requests.filter(request => request.path === '/v1/contacts' && request.method === 'POST').length, 1, 'opening a saved contact does not add it again');
    assert.equal(h.n.captures, 0, 'searching contacts must not activate the voice assistant');
  } finally { await h.close(); }
});

test('shared search stays full width and clears local chat filtering with reserved space for its clear action', async () => {
  const h = await mount(false, true);
  try {
    const input = (label: string) => h.tree.findAll(node => node.type === 'TextInput' as any && node.props.accessibilityLabel === label)[0]!;
    const button = (label: string) => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === label)[0]!;
    const style = (value: any): Record<string, any> => Array.isArray(value) ? Object.assign({}, ...value.filter(Boolean).map(style)) : value ?? {};
    assert.equal(button('Search chats'), undefined);
    assert.equal(button('Clear search chats'), undefined);
    await act(async () => { input('Search chats').props.onFocus(); });
    assert.equal(style(input('Search chats').props.style).flex, 1);
    await act(async () => { input('Search chats').props.onChangeText('nobody'); });
    assert.equal(h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Anna. No messages yet').length, 0);
    assert.ok(style(input('Search chats').props.style).paddingRight >= 44);
    await act(async () => { input('Search chats').props.onBlur(); });
    await act(async () => { button('Clear search chats').props.onPress(); });
    assert.equal(input('Search chats').props.value, '');
    assert.equal(button('Clear search chats'), undefined);
    assert.equal(button('Search chats'), undefined);
    assert.equal(h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Anna. No messages yet').length, 1);
    assert.equal(h.n.requests.some(request => request.path.startsWith('/v1/users?query=')), false, 'local filtering never uses the network');
  } finally { await h.close(); }
});

test('People debounces input, aborts superseded searches, and clears results without stale replies or errors', async t => {
  const h = await mount(false, true);
  const field = () => h.tree.findAll(node => node.type === 'TextInput' as any && node.props.accessibilityLabel === 'Find by phone number or username')[0]!;
  const type = async (value: string) => act(async () => { field().props.onChangeText(value); });
  const tick = async (ms: number) => act(async () => { t.mock.timers.tick(ms); });
  try {
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'People')[0]!.props.onPress(); });
    t.mock.timers.enable({ apis: ['setTimeout'] }); h.n.holdPeopleSearch = true;
    await type('a'); await tick(400);
    assert.equal(h.n.peopleSearches.length, 0);
    await type('an'); await tick(200); await type('ann'); await tick(200); await type('anna'); await tick(299);
    assert.equal(h.n.peopleSearches.length, 0);
    await tick(1); assert.equal(h.n.peopleSearches.length, 1); assert.equal(h.n.peopleSearches[0]!.query, 'anna');
    assert.equal(field().props.accessibilityState.busy, true);
    const style = Object.assign({}, ...field().props.style.filter(Boolean));
    assert.ok(style.paddingRight >= 72, 'reserve both spinner and clear button space');
    await type('bob'); assert.equal(h.n.peopleSearches[0]!.signal.aborted, true);
    await act(async () => { h.n.peopleSearches[0]!.resolve(Response.json([{ id: 'old', username: 'anna', displayName: 'Old result' }])); });
    assert.equal(h.tree.findAll(node => node.props.accessibilityLabel === 'Add Old result and open chat').length, 0);
    await tick(300); assert.equal(h.n.peopleSearches.length, 2);
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Clear find by phone number or username')[0]!.props.onPress(); });
    assert.equal(h.n.peopleSearches[1]!.signal.aborted, true); assert.equal(field().props.value, '');
    await act(async () => { h.n.peopleSearches[1]!.reject(new Error('Aborted old request')); });
    assert.equal(h.mia.error, ''); assert.equal(field().props.accessibilityState.busy, false);
    await tick(500); assert.equal(h.n.peopleSearches.length, 2, 'clearing must not schedule an empty request');
    await type('carol'); await tick(300);
    await act(async () => { h.n.peopleSearches[2]!.resolve(Response.json([{ id: 'new', username: 'carol', displayName: 'Carol' }])); });
    assert.ok(h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Add Carol and open chat').length);
    await type(' carol '); await tick(500); assert.equal(h.n.peopleSearches.length, 3, 'surrounding whitespace does not trigger duplicate requests or clear matching results');
    await type('dave'); await tick(300);
    await act(async () => { h.n.peopleSearches[3]!.reject(new Error('Current network error')); });
    assert.ok(h.mia.error); assert.equal(field().props.accessibilityState.busy, false);
    await type('pending');
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Chats')[0]!.props.onPress(); });
    await tick(500); assert.equal(h.n.peopleSearches.length, 4, 'leaving the screen cancels a pending debounce');
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'People')[0]!.props.onPress(); });
    await type('leaving'); await tick(300); assert.equal(h.n.peopleSearches.length, 5);
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Chats')[0]!.props.onPress(); });
    assert.equal(h.n.peopleSearches[4]!.signal.aborted, true, 'leaving also aborts an in-flight request');
    const error = h.mia.error;
    await act(async () => { h.n.peopleSearches[4]!.reject(new Error('Late failure after navigation')); });
    assert.equal(h.mia.error, error);
  } finally { await h.close(); t.mock.timers.reset(); }
});

test('edge swipe returns from chat, preserves input, and restores the inset-aware dock; partial and vertical drags stay in chat', async () => {
  const h = await mount(false, true);
  const tabs = () => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityRole === 'tab');
  const style = (value: any): Record<string, any> => Array.isArray(value) ? Object.assign({}, ...value.filter(Boolean).map(style)) : value ?? {};
  const edge = { x0: 0, moveX: 138, dx: 130, dy: 2, vx: .2, numberActiveTouches: 1 };
  try {
    const safe = h.tree.findAll(node => node.type === 'SafeAreaView' as any && node.props.edges)[0]!;
    assert.deepEqual(safe.props.edges, ['top', 'left', 'right']);
    assert.ok(h.tree.findAll(node => node.type === 'View' as any && style(node.props.style).paddingBottom === h.n.insets.bottom).length);
    await act(async () => { await h.mia.navigate('chats', 'anna'); });
    assert.equal(tabs().length, 0);
    const input = () => h.tree.findAll(node => node.type === 'TextInput' as any && node.props.accessibilityLabel === 'Message Anna')[0]!;
    await act(async () => { input().props.onChangeText('Keep this unsent text.'); });
    assert.equal(h.tree.findAll(node => node.props.accessibilityLabel === 'Save for later').length, 0);
    assert.ok(h.tree.findAll(node => node.type === 'View' as any && style(node.props.style).paddingBottom === 34).length);
    await act(async () => { h.n.keyboardHandlers.get('keyboardWillShow')!(); });
    assert.ok(h.tree.findAll(node => node.type === 'View' as any && style(node.props.style).paddingBottom === 8).length, 'composer does not reserve the home-indicator inset above the keyboard');
    const back = h.n.backGesture!;
    assert.equal(back.onMoveShouldSetPanResponderCapture!(null, edge), true);
    assert.equal(back.onMoveShouldSetPanResponderCapture!(null, { ...edge, moveX: 250 }), false, 'x0 is still zero before responder grant');
    assert.equal(back.onMoveShouldSetPanResponderCapture!(null, { ...edge, dx: 15, dy: 100 }), false);
    assert.equal(back.onMoveShouldSetPanResponderCapture!(null, { ...edge, numberActiveTouches: 2 }), false);
    await act(async () => { back.onPanResponderGrant!(); back.onPanResponderMove!(null, { ...edge, dx: 40 }); back.onPanResponderRelease!(null, { ...edge, dx: 40 }); });
    assert.equal(h.mia.activeChatId, 'anna');
    await act(async () => { back.onPanResponderGrant!(); back.onPanResponderMove!(null, edge); back.onPanResponderRelease!(null, edge); });
    await h.wait(() => h.mia.activeChatId === null);
    assert.equal(tabs().length, 3); assert.equal(h.mia.composers.anna, 'Keep this unsent text.');
  } finally { await h.close(); }
});

test('a finishing back animation cannot navigate after voice mode takes over', async () => {
  const h = await mount(false, true);
  try {
    await act(async () => { await h.mia.navigate('chats', 'anna'); });
    const back = h.n.backGesture!;
    h.n.holdAnimation = true;
    await act(async () => { back.onPanResponderGrant!(); back.onPanResponderRelease!(null, { dx: 130, vx: .2 }); });
    assert.ok(h.n.finishAnimation);
    await act(async () => { await h.mia.saveAiMode(true); });
    assert.equal(back.onMoveShouldSetPanResponderCapture!(null, { x0: 0, moveX: 138, dx: 130, dy: 2, numberActiveTouches: 1 }), false);
    await act(async () => { h.n.finishAnimation!(); });
    assert.equal(h.mia.activeChatId, 'anna'); assert.equal(h.mia.aiMode, true);
  } finally { await h.close(); }
});

test('the lowest visible footer owns the home-indicator inset during recording, preview and keyboard changes', async () => {
  const h = await mount(false, true);
  const style = (value: any): Record<string, any> => Array.isArray(value) ? Object.assign({}, ...value.filter(Boolean).map(style)) : value ?? {};
  const composer = () => h.tree.findAll(node => node.type === 'View' as any && node.props.testID === 'message-composer-area')[0]!;
  const audio = () => h.tree.findAll(node => node.type === 'View' as any && node.props.testID === 'audio-controls')[0];
  try {
    await act(async () => { await h.mia.navigate('chats', 'anna'); });
    assert.equal(style(composer().props.style).paddingBottom, 34);
    await act(async () => { await h.mia.startRecording(); });
    assert.equal(style(composer().props.style).paddingBottom, 8);
    assert.equal(style(audio()!.props.style).paddingBottom, 34);
    await act(async () => { h.n.keyboardHandlers.get('keyboardWillShow')!(); });
    assert.equal(style(audio()!.props.style).paddingBottom, 0);
    await act(async () => { h.n.keyboardHandlers.get('keyboardWillHide')!(); await h.mia.finishRecording(); });
    assert.ok(h.mia.recording); assert.equal(style(audio()!.props.style).paddingBottom, 34);
    await act(async () => { await h.mia.navigate('chats'); });
    assert.equal(style(audio()!.props.style).paddingBottom, 0, 'the main dock owns the bottom inset now');
    await act(async () => { await h.mia.discardRecording(); await h.mia.navigate('chats', 'anna'); });
    assert.equal(audio(), undefined); assert.equal(style(composer().props.style).paddingBottom, 34);
  } finally { await h.close(); }
});

test('chat entry starts at the latest message and restores a native initial offset only within the current app session', async () => {
  const history: Message[] = [
    { id: 'm2', chatId: 'anna', senderId: 'recipient', kind: 'text', text: 'Latest', mediaId: null, createdAt: '2026-10-29T12:01:00Z' },
    { id: 'm1', chatId: 'anna', senderId: 'recipient', kind: 'text', text: 'Earlier', mediaId: null, createdAt: '2026-10-29T12:00:00Z' },
  ];
  const h = await mount(false, true);
  const timeline = () => h.tree.findAll(node => node.type === 'FlatList' as any)[0]!;
  try {
    h.n.history = history;
    await act(async () => { await h.mia.navigate('chats', 'anna'); });
    assert.equal(timeline().props.inverted, true);
    assert.deepEqual(timeline().props.data.map((m: Message) => m.id), ['m2', 'm1']);
    assert.deepEqual(timeline().props.contentOffset, { x: 0, y: 0 });
    await act(async () => { timeline().props.onScrollBeginDrag(); timeline().props.onScroll({ nativeEvent: { contentOffset: { y: 250 } } }); });
    await act(async () => { await h.mia.navigate('people'); });
    h.n.history = [{ ...history[0]!, id: 'm3', text: 'Arrived while away', createdAt: '2026-10-29T12:02:00Z' }, ...history];
    await act(async () => { await h.mia.navigate('chats', 'anna'); });
    assert.deepEqual(timeline().props.contentOffset, { x: 0, y: 250 });
    assert.deepEqual(timeline().props.data.map((m: Message) => m.id), ['m2', 'm1'], 'restore the previous content before inserting unseen messages');
    await act(async () => { timeline().props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } }); });
    assert.equal(h.mia.chatScrollPositions.read('user', 'anna').offset, 250, 'layout events cannot erase a saved offset');
    await act(async () => { timeline().props.onContentSizeChange(390, 2000); });
    assert.deepEqual(timeline().props.data.map((m: Message) => m.id), ['m3', 'm2', 'm1']);
    await act(async () => { timeline().props.onScroll({ nativeEvent: { contentOffset: { y: 250 } } }); h.mia.setComposer('Still here'); });
    assert.deepEqual(timeline().props.contentOffset, { x: 0, y: 250 }, 'typing does not issue a different scroll offset');
  } finally { await h.close(); }
  const restarted = await mount(false, true);
  try {
    restarted.n.history = history;
    await act(async () => { await restarted.mia.navigate('chats', 'anna'); });
    assert.deepEqual(restarted.tree.findAll(node => node.type === 'FlatList' as any)[0]!.props.contentOffset, { x: 0, y: 0 });
  } finally { await restarted.close(); }
});
