import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { build } from 'esbuild';
import type { Mia } from '../src/useMia';
import type { Recording, PlaybackProgress } from '../src/audio/types';
import type { Frame } from '../src/realtime';
import type { Contact, Draft, Message, MessageReference, ServerEvent, Turn } from '../src/types';
import { pressGesture } from './pressability';

// Run the real hook, API and conversation loop. Only OS audio, secure storage
// and the socket transport are substituted, so React lifecycle races execute.
const root = fileURLToPath(new URL('../', import.meta.url).toString()).replaceAll('\\', '/');
const sources: Record<string, string> = {
  'react-native': `const n = globalThis.__miaNative;
    export const AccessibilityInfo = { isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => n.reducedMotion, addEventListener: (name, callback) => {
      if (name === 'reduceMotionChanged') n.motionHandlers.add(callback);
      return { remove() { n.motionHandlers.delete(callback); } };
    }, announceForAccessibility: text => n.announcements.push(text) };
    export const Vibration = { vibrate: () => { n.vibrations++; } };
    export const Keyboard = { dismiss() {}, isVisible: () => false, addListener: (name, callback) => {
      n.keyboardHandlers.set(name, callback); return { remove() { n.keyboardHandlers.delete(name); } };
    } };
    export const Platform = { OS: 'ios' };
    export const useWindowDimensions = () => n.dimensions;
    export const PanResponder = { create: handlers => { n.backGesture = handlers; return { panHandlers: {} }; } };
    export const Easing = { inOut: value => value, sin: x => x, linear: x => x, bezier: () => x => x };
    const animation = (config, value) => {
      let stopped = false, completed = false;
      return { config, start(callback) { if (callback) {
        const finish = () => { if (stopped || completed) return; completed = true; if (value && config) value.setValue(config.toValue); callback({ finished: true }); };
        if (n.holdAnimation) {
          n.pendingAnimations.push({ config, finish, active: () => !stopped && !completed });
          n.finishAnimation = () => { const pending = n.pendingAnimations.splice(0); for (const item of pending) item.finish(); };
        } else finish();
      } }, stop() { stopped = true; } };
    };
    export const Animated = { add: () => 0, Value: class { constructor(value) { this.value = value; } setValue(value) { this.value = value; } stopAnimation() {} interpolate() { return 0; } }, View: 'AnimatedView', loop: child => {
      const loop = { child, started: false, stopped: false }; n.loops.push(loop);
      return { start() { loop.started = true; }, stop() { loop.stopped = true; } };
    }, sequence: children => ({ ...animation(), children }), timing: (value, config) => { n.animations.push(config); return animation(config, value); }, spring: animation };
    export const ActivityIndicator='ActivityIndicator', KeyboardAvoidingView='KeyboardAvoidingView', Pressable='Pressable', Modal='Modal', StatusBar='StatusBar', Text='Text', View='View', ScrollView='ScrollView', TextInput='TextInput', FlatList='FlatList', Switch='Switch';
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
    export const preferences = { get: async key => {
      if (n.holdStartup && key === 'mia.ai_mode') await new Promise(resolve => { n.releaseStartupMode = resolve; });
      return n.preferences.get(key) ?? null;
    }, set: async (key, value) => { if (n.failPreferences) throw new Error('Storage unavailable'); n.preferences.set(key, value); } };
    export const sessionStorage = { read: async () => {
      if (n.holdStartup) await new Promise(resolve => { n.releaseStartupSession = resolve; });
      return n.session;
    }, write: async value => { n.session = value; } };`,
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
      async start(signal) {
        if (n.holdNoteStart) await new Promise(resolve => { n.releaseNoteStart = resolve; });
        if (signal?.aborted) throw new CancelledError();
        n.noteRecording = true;
      }
      async finish() { n.noteRecording = false; return { uri: 'file:///note.wav', durationMs: 1000 }; }
      async stop() { if (n.nativeSession) n.audioConflicts++; n.playback?.(); n.playback = null; n.noteRecording = false; }
      async playPcm() { n.playbacks++; await new Promise(resolve => { n.playback = resolve; }); }
      async play(_, __, started, progress) { n.playbackProgress = progress; started?.(); await this.playPcm(); }
      async disposeRecording(recording) { n.deleted.push(recording.uri); }
      async savePcm(pcm) { n.savedPcm = pcm; return { uri: 'file:///note.wav', durationMs: pcm.length / 48 }; }
      async readPcm(uri, headers, signal) { if (signal?.aborted) throw new CancelledError(); return new Uint8Array(480000); }
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
  stdin: { contents: `export { useMia } from './src/useMia'; export { default as App } from './src/App'; export { UiProvider, Button } from './src/ui'; export { Reveal } from './src/motion'; export { MessageReferenceCard } from './src/screens/MessageReferenceCard';`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
  define: { 'process.env.EXPO_PUBLIC_API_URL': JSON.stringify('http://mia.test') },
  plugins: [{ name: 'native-test', setup(build) {
    build.onResolve({ filter: /^(react-native|react-native-safe-area-context|@expo\/vector-icons\/Ionicons|expo-crypto|\.\/storage|\.\/audio\/engine|\.\.\/\.\.\/modules\/mia-voice|\.\/realtime)$/ }, args => ({ path: args.path, namespace: 'native-test' }));
    build.onLoad({ filter: /.*/, namespace: 'native-test' }, args => ({ contents: sources[args.path], resolveDir: root }));
  } }],
});
const realFetch = globalThis.fetch;
const realFormData = globalThis.FormData;

test('retained cards allow subsequent reordered-context actions, same-source reuse, replacement and another chat', async () => {
  const h = await mount(true, true, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    const stream = h.n.frames.find(frame => frame.type === 'voice.start')!;
    h.n.referenceSources.push(...['first', 'second'].map(id => ({ id, chatId: 'anna', senderId: 'recipient', kind: 'text' as const,
      text: `The ${id} notebook.`, mediaId: null, createdAt: '2026-10-30T12:00:00Z' })));
    const jsonb = (value: unknown): any => JSON.parse(JSON.stringify(value, (_key, part) => part && typeof part === 'object' && !Array.isArray(part)
      ? Object.fromEntries(Object.keys(part).sort((a, b) => a.length - b.length || a.localeCompare(b)).map(key => [key, part[key]])) : part));
    const accept = async (id: string) => {
      const context = structuredClone(h.n.frames.filter(frame => frame.type === 'voice.context').at(-1)?.context ?? stream.context);
      const turn: Turn = { id, sessionId: 'assistant', userId: 'user', generation: h.n.turns.length + 1, userText: 'A new request.',
        assistantText: null, status: 'running', clientTurnId: `client-${id}`, context: context as any };
      h.n.turns.push(turn);
      await act(async () => { h.n.frame({ type: 'voice.interruption', requestId: stream.requestId, clientTurnId: turn.clientTurnId }); h.n.frame({ type: 'turn.accepted', turn }); });
      return turn;
    };
    const command = async (turn: Turn, id: string, kind: string, payload: Record<string, unknown>, sequence: number, context = jsonb(turn.context)) => {
      await act(async () => { await h.n.event({ id, type: 'device.action_requested', createdAt: new Date().toISOString(), payload: {
        actionId: id, sessionId: 'assistant', turnId: turn.id, kind, payload, sequence: String(sequence), expiresIn: 180000, context,
      } }, 0); });
    };
    const result = (id: string) => h.n.requests.find(request => request.path === `/v1/device-actions/${id}/result`)?.body;
    const layout = async () => {
      const region = h.tree.findAll(node => node.props.testID === 'message-reference-region')[0]!;
      await act(async () => { region.props.onLayout({ nativeEvent: { layout: { width: 390, height: 500 } } }); });
      const card = h.tree.findAll(node => node.type === 'AnimatedView' as any && node.props.testID === 'message-reference-card')[0]!;
      await act(async () => { card.props.onLayout({ nativeEvent: { layout: { width: 358, height: 250 } } }); });
      return card;
    };
    const first = await accept('first-turn');
    await command(first, 'first-card', 'show_message', { chatId: 'anna', messageId: 'first' }, 1);
    await h.wait(() => h.mia.messageReference?.messageId === 'first');
    const original = await layout(); await h.wait(() => !!result('first-card'));
    assert.equal(result('first-card').success, true);

    const followUp = await accept('follow-up');
    assert.ok(followUp.context?.reference);
    assert.notDeepEqual(Object.keys(jsonb(followUp.context).reference), Object.keys(followUp.context!.reference!));
    await command(followUp, 'same-card', 'show_message', { chatId: 'anna', messageId: 'first' }, 2);
    await h.wait(() => !!result('same-card'));
    assert.equal(result('same-card').success, true);
    assert.equal(h.tree.findAll(node => node.type === 'AnimatedView' as any && node.props.testID === 'message-reference-card')[0], original,
      'the same source reuses the displayed card without another entrance');
    await command(followUp, 'replacement', 'show_message', { chatId: 'anna', messageId: 'second' }, 3);
    await h.wait(() => h.mia.messageReference?.messageId === 'second');
    await layout(); await h.wait(() => !!result('replacement'));
    assert.equal(result('replacement').success, true);

    const next = await accept('next-turn');
    await command(next, 'wrong-context', 'open_chat', { chatId: 'ben' }, 4,
      { ...jsonb(next.context), reference: { ...jsonb(next.context).reference, messageId: 'another' } });
    await h.wait(() => !!result('wrong-context'));
    assert.equal(result('wrong-context').success, false);
    assert.equal(result('wrong-context').result.code, 'ACTION_CONTEXT_CHANGED');
    assert.equal(result('wrong-context').result.stage, 'validation');
    assert.equal(h.mia.activeChatId, 'anna');

    h.n.failSpeech = true;
    await command(next, 'speech-failure', 'show_message', { chatId: 'anna', messageId: 'second', narration: 'The notebook.' }, 5);
    await h.wait(() => !!result('speech-failure'));
    const failedSpeech = result('speech-failure');
    assert.equal(failedSpeech.success, false); assert.equal(failedSpeech.result.code, 'TTS_UNAVAILABLE');
    assert.equal(failedSpeech.result.stage, 'narration'); assert.equal(failedSpeech.result.presentationConfirmed, true);
    assert.equal(failedSpeech.result.reference.messageId, 'second'); assert.equal(h.mia.messageReference?.messageId, 'second');

    h.n.failSpeech = false;
    const retainedReference = h.mia.messageReference;
    await command(next, 'skip-notice', 'announce_message_skip', { failedActionId: 'speech-failure', narration: 'I could not read that message. I will continue with the next.' }, 6);
    await h.wait(() => !!h.n.playback);
    assert.equal(result('skip-notice'), undefined, 'the next source must wait for actual warning playback');
    assert.equal(h.mia.messageReference, retainedReference, 'the notice keeps the existing card and its presentation revision');
    await act(async () => { h.n.playback?.(); });
    await h.wait(() => !!result('skip-notice'));
    assert.equal(result('skip-notice').success, true);

    h.n.failSpeech = true;
    await command(next, 'failed-notice', 'announce_message_skip', { failedActionId: 'another-failure', narration: 'I could not finish reading.' }, 7);
    await h.wait(() => !!result('failed-notice'));
    assert.equal(result('failed-notice').success, false);
    assert.equal(result('failed-notice').result.stage, 'narration');
    assert.equal(h.mia.messageReference, retainedReference);

    const region = h.tree.findAll(node => node.props.testID === 'message-reference-region')[0]!;
    await act(async () => { region.props.onLayout({ nativeEvent: { layout: { width: 390, height: 90 } } }); });
    const speechRequests = h.n.frames.filter(frame => frame.type === 'speech.request').length;
    await command(next, 'no-space', 'show_message', { chatId: 'anna', messageId: 'first', narration: 'The notebook.' }, 8);
    await h.wait(() => !!result('no-space'));
    assert.equal(result('no-space').success, false); assert.equal(result('no-space').result.code, 'PRESENTATION_NO_SPACE');
    assert.equal(result('no-space').result.stage, 'presentation'); assert.equal(result('no-space').result.presentationConfirmed, false);
    assert.equal(result('no-space').result.reference, null);
    assert.equal(h.n.frames.filter(frame => frame.type === 'speech.request').length, speechRequests, 'failed presentation never starts narration');
    h.n.savedChats.push({ ...chat, id: 'ben', recipient: { ...chat.recipient, id: 'ben-user', displayName: 'Ben', username: 'ben' } });
    await command(next, 'open-ben', 'open_chat', { chatId: 'ben' }, 9);
    await h.wait(() => !!result('open-ben'));
    assert.equal(result('open-ben').success, true); assert.equal(h.mia.activeChatId, 'ben'); assert.equal(h.mia.messageReference, null);
    assert.equal(result('open-ben').result.context.route, '/chat/ben');
  } finally { await h.close(); }
});

test('exact old references stay passive and retained while source-specific narration and replacements await actual audio completion', async () => {
  const h = await mount(true, true, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    const stream = h.n.frames.find(frame => frame.type === 'voice.start')!;
    const turn: Turn = { id: 'reference-turn', sessionId: 'assistant', userId: 'user', generation: 1, userText: 'Walk me through her two messages.', assistantText: null, status: 'running', clientTurnId: 'reference-client', context: stream.context as any };
    h.n.turns.push(turn);
    await act(async () => { h.n.frame({ type: 'voice.interruption', requestId: stream.requestId, clientTurnId: turn.clientTurnId }); h.n.frame({ type: 'turn.accepted', turn }); });
    h.n.referenceSources.push(...['old-one', 'old-two'].map((id, index) => ({ id, chatId: 'anna', senderId: 'recipient', kind: 'text' as const, text: `Exact source ${index}. ` + 'Long source sentence. '.repeat(40), mediaId: null, createdAt: '2025-10-12T12:00:00.000Z' })));
    const command = async (id: string, kind: string, payload: Record<string, unknown>, sequence: number) => {
      await act(async () => { await h.n.event({ id, type: 'device.action_requested', createdAt: new Date().toISOString(), payload: { actionId: id, turnId: turn.id, sessionId: 'assistant', kind, payload, sequence: String(sequence), expiresIn: 180000, context: turn.context } }, 0); });
    };
    const layout = async () => {
      const region = h.tree.findAll(node => node.type === 'View' as any && node.props.testID === 'message-reference-region')[0]!;
      await act(async () => { region.props.onLayout({ nativeEvent: { layout: { width: 320, height: 380 } } }); });
      const card = h.tree.findAll(node => node.type === 'AnimatedView' as any && node.props.testID === 'message-reference-card')[0]!;
      assert.ok(card); assert.equal(card.props.pointerEvents, 'none'); assert.equal(card.props.accessible, false);
      assert.equal(card.props.importantForAccessibility, 'no-hide-descendants');
      assert.equal(card.findAll(node => node.type === 'Pressable' as any).length, 0);
      await act(async () => { card.props.onLayout({ nativeEvent: { layout: { width: 296, height: 300 } } }); });
    };
    await command('show-first', 'show_message', { chatId: 'anna', messageId: 'old-one', narration: 'The first source discusses your plan.' }, 1);
    await h.wait(() => h.mia.messageReference?.messageId === 'old-one');
    assert.equal(h.mia.activeChatId, 'anna'); assert.deepEqual(h.mia.messages.anna, []);
    assert.equal(h.n.playbacks, 0, 'source reveal alone never reads source text');
    await layout(); await h.wait(() => h.n.playbacks === 1);
    const firstNativeCard = h.tree.findAll(node => node.type === 'AnimatedView' as any && node.props.testID === 'message-reference-card')[0]!;
    assert.equal(h.n.frames.filter(frame => frame.type === 'speech.request')[0]?.actionId, 'show-first');
    assert.equal(h.n.requests.some(r => r.path === '/v1/device-actions/show-first/result'), false, 'speech generation and start are not completion');
    await command('show-second', 'show_message', { chatId: 'anna', messageId: 'old-two', narration: 'The second source adds a time.' }, 2);
    assert.equal(h.mia.messageReference?.messageId, 'old-one');
    await act(async () => { h.n.playback!(); });
    await h.wait(() => h.mia.messageReference?.messageId === 'old-two');
    assert.notEqual(h.tree.findAll(node => node.type === 'AnimatedView' as any && node.props.testID === 'message-reference-card')[0]!, firstNativeCard,
      'an equal-layout source replacement remounts its native measuring view, guaranteeing a fresh initial layout event');
    await layout(); await h.wait(() => h.n.playbacks === 2);
    const firstResult = h.n.requests.find(r => r.path === '/v1/device-actions/show-first/result')!.body;
    assert.equal(firstResult.success, true); assert.equal(firstResult.result.reference.messageId, 'old-one');
    assert.ok(firstResult.result.reference.focus, 'fitting reports truthful actual source excerpt offsets');
    const published = h.n.frames.filter(frame => frame.type === 'voice.context').at(-1)!.context as any;
    assert.equal(published.reference.messageId, 'old-two'); assert.ok(published.reference.focus);
    await act(async () => { h.n.playback!(); });
    await h.wait(() => h.n.requests.some(r => r.path === '/v1/device-actions/show-second/result'));
    assert.equal(h.mia.messageReference?.messageId, 'old-two', 'speech ending never dismisses the card');
    const beforeResize = h.mia.messageReference!.displayFocus!;
    const retainedRegion = h.tree.findAll(node => node.type === 'View' as any && node.props.testID === 'message-reference-region')[0]!;
    await act(async () => { retainedRegion.props.onLayout({ nativeEvent: { layout: { width: 320, height: 270 } } }); });
    const resized = h.tree.findAll(node => node.type === 'AnimatedView' as any && node.props.testID === 'message-reference-card')[0]!;
    await act(async () => { resized.props.onLayout({ nativeEvent: { layout: { width: 296, height: 240 } } }); });
    assert.ok(h.mia.messageReference!.displayFocus!.end < beforeResize.end);
    const resizedContext = h.n.frames.filter(frame => frame.type === 'voice.context').at(-1)!.context as any;
    assert.deepEqual(resizedContext.reference.focus, h.mia.messageReference!.displayFocus, 'retained-card resize publishes actual offsets for continuous ASR');
    const target = h.tree.findAll(node => node.type === 'Pressable' as any && node.props.testID === 'agent-interaction-layer')[0]!;
    assert.match(target.props.accessibilityLabel, /focused excerpt/);
    await act(async () => { await h.mia.toggleMicrophone(); });
    assert.equal(h.mia.messageReference?.messageId, 'old-two');
    await act(async () => { retainedRegion.props.onLayout({ nativeEvent: { layout: { width: 320, height: 90 } } }); });
    assert.equal(h.mia.messageReference, null, 'insufficient visual space safely removes a retained card');
    assert.equal((h.n.frames.filter(frame => frame.type === 'voice.context').at(-1)!.context as any).reference, undefined,
      'continuous ASR cannot keep referring to a source removed by a layout guard');
    await command('dismiss', 'dismiss_message', {}, 3);
    await h.wait(() => h.mia.messageReference === null);
    await h.wait(() => h.n.requests.some(r => r.path === '/v1/device-actions/dismiss/result'));
    await act(async () => { await h.mia.saveAiMode(false); });
    assert.equal(h.mia.messageReference, null);
  } finally { await h.close(); }
});

test('leaving agent mode fences a pending exact-source reveal and replay cannot restore the card', async () => {
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    const stream = h.n.frames.find(frame => frame.type === 'voice.start')!;
    const turn: Turn = { id: 'late-ref', sessionId: 'assistant', userId: 'user', generation: 1, userText: 'Show her message.', assistantText: null, status: 'running', clientTurnId: 'late-ref-client', context: stream.context as any };
    h.n.turns.push(turn);
    await act(async () => { h.n.frame({ type: 'voice.interruption', requestId: stream.requestId, clientTurnId: turn.clientTurnId }); h.n.frame({ type: 'turn.accepted', turn }); });
    h.n.referenceSources.push({ id: 'old', chatId: 'anna', senderId: 'recipient', kind: 'text', text: 'Real source.', mediaId: null, createdAt: new Date().toISOString() });
    const event: ServerEvent = { id: 'late-show', type: 'device.action_requested', createdAt: new Date().toISOString(), payload: { actionId: 'late-show', sessionId: 'assistant', turnId: turn.id, kind: 'show_message', sequence: '1', expiresIn: 180000, context: turn.context, payload: { chatId: 'anna', messageId: 'old' } } };
    await act(async () => { await h.n.event(event, 0); });
    await h.wait(() => !!h.mia.messageReference);
    await act(async () => { await h.mia.saveAiMode(false); });
    assert.equal(h.mia.messageReference, null);
    await act(async () => { h.mia.referencePresented(1); await h.n.event(event, 0, true); });
    assert.equal(h.mia.messageReference, null); assert.equal(h.n.playbacks, 0);
  } finally { await h.close(); }
});

test('shutter replacement finishes the old card first, coalesces requests and acknowledges only fully presented content', async () => {
  const h = await mount(false);
  let probe: ReactTestRenderer | undefined;
  const presented: number[] = [];
  const reference = (id: string, text: string, revision: number): MessageReference => ({
    chatId: 'anna', messageId: id, revision, recipient: { id: 'recipient', username: 'anna', displayName: 'Anna' },
    source: { id, chatId: 'anna', senderId: 'recipient', kind: 'text', text, mediaId: null, createdAt: '2026-10-30T12:00:00Z' },
  });
  const sample = (source: MessageReference | null, dismissalRevision?: number) => React.createElement(h.components.MessageReferenceCard, {
    source, userId: 'user', playback: null, dismissalRevision, onPresented: revision => presented.push(revision),
  });
  const card = () => probe!.root.findAll(node => node.type === 'AnimatedView' as any && node.props.testID === 'message-reference-card')[0]!;
  const text = () => card().findAll(node => node.type === 'Text' as any).map(node => node.props.children).join(' ');
  const measure = async () => { await act(async () => { card().props.onLayout({ nativeEvent: { layout: { width: 296, height: 180 } } }); }); };
  const pending = (duration: number, toValue: number) => h.n.pendingAnimations.filter(item => item.active() && item.config.duration === duration && item.config.toValue === toValue);
  const finish = async (duration: number, toValue: number) => { const batch = pending(duration, toValue); await act(async () => { batch.forEach(item => item.finish()); }); };
  const breathingLoops = () => h.n.loops.filter(loop => loop.child.children?.some((motion: any) => motion.config?.duration === 2000));
  try {
    h.n.holdAnimation = true;
    await act(async () => { probe = create(sample(reference('one', 'First source.', 1))); });
    const region = probe!.root.findAll(node => node.props.testID === 'message-reference-region')[0]!;
    await act(async () => { region.props.onLayout({ nativeEvent: { layout: { width: 320, height: 400 } } }); });
    assert.deepEqual(presented, [], 'measuring and mounting are not a presentation acknowledgement');
    await measure();
    const incoming = pending(650, 1);
    assert.equal(incoming.length, 6);
    assert.ok(incoming.every(item => item.config.useNativeDriver && item.config.isInteraction === false));
    await act(async () => { incoming.slice(0, -1).forEach(item => item.finish()); });
    assert.deepEqual(presented, [], 'narration waits for the last strip');
    assert.equal(breathingLoops().length, 0, 'idle motion must not run over an unfinished entrance');
    await act(async () => { incoming.at(-1)!.finish(); });
    assert.deepEqual(presented, [1]);
    const breath = breathingLoops().at(-1)!;
    assert.equal(breath.started, true); assert.equal(breath.stopped, false);
    assert.deepEqual(breath.child.children.map((motion: any) => [motion.config.toValue, motion.config.duration]), [[1.04, 2000], [1, 2000]]);
    assert.ok(breath.child.children.every((motion: any) => motion.config.useNativeDriver && motion.config.isInteraction === false));
    await act(async () => { h.n.reducedMotion = true; for (const handler of h.n.motionHandlers) handler(true); });
    assert.equal(breath.stopped, true);
    const shell = probe!.root.findAll(node => node.type === 'AnimatedView' as any && node.props.testID === 'message-reference-shutter')[0]!;
    assert.equal(shell.props.style.transform[0].scale.value, 1);
    assert.deepEqual(presented, [1], 'changing idle motion cannot repeat presentation acknowledgement');
    await act(async () => { h.n.reducedMotion = false; for (const handler of h.n.motionHandlers) handler(false); });
    const resumedBreath = breathingLoops().at(-1)!; assert.equal(resumedBreath.stopped, false);

    await act(async () => { probe!.update(sample(reference('two', 'Second source.', 2))); });
    assert.match(text(), /First source/);
    assert.equal(resumedBreath.stopped, true, 'outgoing card stops its idle loop before shutter exit');
    const outgoing = pending(420, 0);
    assert.equal(outgoing.length, 6);
    await act(async () => { probe!.update(sample(reference('three', 'Third source.', 3))); });
    assert.match(text(), /First source/, 'a newer request cannot replace the outgoing snapshot');
    await act(async () => { outgoing.slice(0, -1).forEach(item => item.finish()); });
    assert.match(text(), /First source/);
    await act(async () => { region.props.onLayout({ nativeEvent: { layout: { width: 0, height: 400 } } }); });
    await act(async () => { outgoing.at(-1)!.finish(); });
    assert.equal(probe!.root.findAll(node => node.props.testID === 'message-reference-card').length, 0, 'a temporarily collapsed region waits for geometry');
    await act(async () => { region.props.onLayout({ nativeEvent: { layout: { width: 320, height: 400 } } }); });
    assert.match(text(), /Third source/);
    assert.equal(text().includes('Second source.'), false, 'superseded content is never mounted');
    assert.deepEqual(presented, [1]);
    await measure(); await finish(650, 1);
    assert.deepEqual(presented, [1, 3]);

    await act(async () => { probe!.update(sample(reference('three', 'Other source.', 4))); });
    assert.match(text(), /Third source/, 'equal-length edits also use exit, then entrance');
    await finish(420, 0); await measure(); await finish(650, 1);
    assert.deepEqual(presented, [1, 3, 4]);

    await act(async () => { probe!.update(sample(reference('four', 'Never narrated.', 5))); });
    await finish(420, 0); await measure();
    const cancelledEntrance = pending(650, 1);
    await act(async () => { probe!.update(sample(null, 6)); });
    await act(async () => { cancelledEntrance.forEach(item => item.finish()); });
    assert.deepEqual(presented, [1, 3, 4], 'a cancelled entrance cannot start narration');
    await finish(420, 0);
    assert.equal(probe!.root.findAll(node => node.props.testID === 'message-reference-card').length, 0);
    assert.deepEqual(presented, [1, 3, 4], 'dismissal also waits for its backdrop');
    await finish(220, 0);
    assert.deepEqual(presented, [1, 3, 4, 6]);

    await act(async () => { probe!.update(sample(reference('five', 'Unmounted source.', 7))); });
    await measure();
    await act(async () => { probe!.unmount(); }); probe = undefined;
    await act(async () => { h.n.finishAnimation!(); });
    assert.deepEqual(presented, [1, 3, 4, 6], 'late native callbacks cannot revive an unmounted card');
    assert.ok(breathingLoops().every(loop => loop.stopped), 'unmount must leave no idle loop running');
  } finally { if (probe) await act(async () => { probe!.unmount(); }); await h.close(); }
});

test('shutter switches to a short whole-card fade under Reduce Motion without acknowledging hidden text', async () => {
  const h = await mount(false);
  let probe: ReactTestRenderer | undefined;
  const presented: number[] = [];
  try {
    await act(async () => { h.n.reducedMotion = true; for (const handler of h.n.motionHandlers) handler(true); });
    h.n.holdAnimation = true;
    const source: MessageReference = {
      chatId: 'anna', messageId: 'reduced', revision: 8, recipient: { id: 'recipient', username: 'anna', displayName: 'Anna' },
      source: { id: 'reduced', chatId: 'anna', senderId: 'recipient', kind: 'text', text: 'Still readable.', mediaId: null, createdAt: '2026-10-30T12:00:00Z' },
    };
    await act(async () => { probe = create(React.createElement(h.components.MessageReferenceCard, { source, userId: 'user', playback: null, onPresented: revision => presented.push(revision) })); });
    const region = probe!.root.findAll(node => node.props.testID === 'message-reference-region')[0]!;
    await act(async () => { region.props.onLayout({ nativeEvent: { layout: { width: 320, height: 400 } } }); });
    const card = probe!.root.findAll(node => node.props.testID === 'message-reference-card')[0]!;
    await act(async () => { card.props.onLayout({ nativeEvent: { layout: { width: 296, height: 180 } } }); });
    assert.equal(probe!.root.findAll(node => node.props.testID?.startsWith('message-reference-strip-')).length, 0);
    assert.deepEqual(presented, []);
    const fade = h.n.pendingAnimations.filter(item => item.active() && item.config.duration === 80 && item.config.toValue === 1);
    assert.equal(fade.length, 1);
    await act(async () => { fade[0]!.finish(); });
    assert.deepEqual(presented, [8]);
    assert.equal(h.n.animations.some(animation => animation.duration === 10000), false, 'the contour stays still');
    assert.equal(h.n.animations.some(animation => animation.duration === 2000), false, 'breathing stays disabled under Reduce Motion');
  } finally { if (probe) await act(async () => { probe!.unmount(); }); await h.close(); }
});

test('original recording reports real completion and stop or mute bypass the presentation queue', async () => {
  const h = await mount(true, true, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    const stream = h.n.frames.find(frame => frame.type === 'voice.start')!;
    const turn: Turn = { id: 'original-turn', sessionId: 'assistant', userId: 'user', generation: 1, userText: 'Play her recording.', assistantText: null, status: 'running', clientTurnId: 'original-client', context: stream.context as any };
    h.n.turns.push(turn);
    h.n.referenceSources.push({ id: 'voice-message', chatId: 'anna', senderId: 'recipient', kind: 'voice',
      text: 'This transcript must not replace the voice player.', mediaId: 'voice-source', createdAt: '2026-10-30T12:00:00Z' });
    await act(async () => { h.n.frame({ type: 'voice.interruption', requestId: stream.requestId, clientTurnId: turn.clientTurnId }); h.n.frame({ type: 'turn.accepted', turn }); });
    const command = async (id: string, kind: string, payload: Record<string, unknown>) => {
      await act(async () => { await h.n.event({ id, type: 'device.action_requested', createdAt: new Date().toISOString(), payload: { actionId: id, sessionId: 'assistant', turnId: turn.id, kind, payload, expiresIn: 180000, context: turn.context } }, 0); });
    };
    await command('original-one', 'play_audio', { mediaId: 'voice-source', messageId: 'voice-message', chatId: 'anna' });
    await h.wait(() => h.mia.messageReference?.messageId === 'voice-message');
    assert.equal(h.n.playbacks, 0, 'the real source card must appear before original playback');
    const region = h.tree.findAll(node => node.props.testID === 'message-reference-region')[0]!;
    await act(async () => { region.props.onLayout({ nativeEvent: { layout: { width: 390, height: 500 } } }); });
    const card = h.tree.findAll(node => node.type === 'AnimatedView' as any && node.props.testID === 'message-reference-card')[0]!;
    await act(async () => { card.props.onLayout({ nativeEvent: { layout: { width: 358, height: 250 } } }); });
    await h.wait(() => h.n.playbacks === 1);
    assert.equal(h.mia.originalPlayback?.state, 'playing');
    assert.ok(h.tree.findAll(node => node.type === 'Text' as any && node.props.children === 'Playing voice message').length);
    assert.ok(h.tree.findAll(node => node.props.testID === 'voice-message-waveform').length);
    assert.equal(card.findAll(node => node.type === 'Pressable' as any).length, 0);
    assert.equal(h.tree.findAll(node => node.props.testID === 'audio-controls').length, 0);
    assert.equal(h.tree.findAll(node => node.type === 'Text' as any && node.props.children === 'This transcript must not replace the voice player.').length, 0);
    const label = (id: string) => h.tree.findAll(node => node.type === 'Text' as any && node.props.testID === id)[0]!.props.children;
    assert.equal(label('voice-message-duration'), '0:10');
    assert.equal(label('voice-message-status'), 'Playing');
    assert.equal(h.n.requests.some(r => r.path === '/v1/device-actions/original-one/result'), false);
    await command('input-mute', 'set_microphone_muted', { muted: true });
    await h.wait(() => h.n.requests.some(r => r.path === '/v1/device-actions/input-mute/result'));
    assert.equal(h.mia.originalPlayback?.state, 'playing', 'input mute cannot mark original audio finished');
    const nativeStarts = h.n.nativeStarts;
    const playbackCompletion = h.n.playback;
    await command('input-unmute', 'set_microphone_muted', { muted: false });
    await h.wait(() => h.n.requests.some(r => r.path === '/v1/device-actions/input-unmute/result'));
    assert.equal(h.n.nativeStarts, nativeStarts, 'unmute defers native microphone acquisition until original media releases Expo audio');
    assert.equal(h.n.playback, playbackCompletion); assert.equal(h.mia.originalPlayback?.state, 'playing');
    await act(async () => { h.n.playback!(); });
    await h.wait(() => h.n.requests.some(r => r.path === '/v1/device-actions/original-one/result'));
    assert.equal(h.mia.originalPlayback?.state, 'finished');
    assert.equal(label('voice-message-status'), 'Finished'); assert.equal(label('voice-message-position'), '0:10');
    assert.equal(h.n.requests.find(r => r.path === '/v1/device-actions/original-one/result')!.body.success, true);
    await command('original-two', 'play_audio', { mediaId: 'voice-source', messageId: 'voice-message', chatId: 'anna' });
    await h.wait(() => h.n.playbacks === 2);
    await command('stop-now', 'stop_audio', {});
    await h.wait(() => h.n.requests.some(r => r.path === '/v1/device-actions/stop-now/result'));
    await h.wait(() => h.n.requests.some(r => r.path === '/v1/device-actions/original-two/result'));
    assert.equal(h.mia.originalPlayback?.state, 'stopped');
    assert.equal(label('voice-message-status'), 'Stopped');
    assert.equal(h.n.requests.find(r => r.path === '/v1/device-actions/original-two/result')!.body.success, false);
    assert.equal(h.mia.aiMode, true);
    assert.equal(h.mia.voiceFault, false, 'original media handoff preserves the native response controller');
  } finally { await h.close(); }
});
const session = { token: 'token', expiresAt: '2099-01-01', user: { id: 'user', username: 'me', displayName: 'Me', phoneNumber: '+15550000000', profileComplete: true } };
const assistantSession = { id: 'assistant', generation: 0, activeChatId: null };
const chat = { id: 'anna', recipient: { id: 'recipient', username: 'anna', displayName: 'Anna' }, unreadCount: 0, lastMessage: null };

async function mount(mode = false, renderApp = false, nativeAvailable = false, holdStartup = false) {
  const code = (await bundle).outputFiles[0]!.text;
  const n = {
    session, preferences: new Map([['mia.ai_mode', String(mode)]]), captures: 0, playbacks: 0, deleted: [] as string[],
    frames: [] as Frame[], requests: [] as { path: string; method: string; body: any }[], turns: [] as Turn[],
    capture: null as ((recording: Recording | null) => void) | null, playback: null as (() => void) | null,
    playbackProgress: null as ((progress: PlaybackProgress) => void) | null,
    appState: (_state: string) => {}, event: async (_event: ServerEvent, _time: number, _replayed?: boolean) => {}, frame: (_frame: Frame) => {},
    connection: (_status: string) => {}, offline: false, holdHealth: false, healthHeld: false, healthCancelled: false,
    noteRecording: false, complete: true, text: 'Open Anna', holdRecognition: false, recognitionCancelled: false, failSpeech: false, permissionDenied: false, dropAcceptedTurn: false,
    nativeAvailable, nativeStarts: 0, nativeStops: 0, nativePCM: null as ((bytes: Uint8Array) => void) | null,
    nativeReject: null as ((reason: unknown) => void) | null, pcmPackets: 0,
    nativeRevision: 0, nativeSession: false, audioConflicts: 0, holdNativeStart: false, holdNativeStop: false,
    releaseNativeStart: null as (() => void) | null, releaseNativeStop: null as (() => void) | null,
    holdASR: false,
    holdNoteStart: false, releaseNoteStart: null as (() => void) | null, failSend: false,
    savedPcm: null as Uint8Array | null,
    appStateHandlers: new Set<(state: string) => void>(), announcements: [] as string[], vibrations: 0,
    dimensions: { width: 390, height: 844, scale: 3, fontScale: 1 }, reducedMotion: false,
    motionHandlers: new Set<(value: boolean) => void>(), animations: [] as { duration: number; useNativeDriver: boolean; toValue: number }[],
    loops: [] as { child: any; started: boolean; stopped: boolean }[],
    keyboardHandlers: new Map<string, () => void>(), insets: { top: 47, bottom: 34, left: 0, right: 0 },
    backGesture: null as Record<string, (...args: any[]) => any> | null, holdAnimation: false, finishAnimation: null as (() => void) | null,
    pendingAnimations: [] as { config: { duration: number; toValue: number; delay?: number; useNativeDriver: boolean; isInteraction?: boolean }; finish(): void; active(): boolean }[],
    savedContacts: [] as Contact[],
    savedDrafts: [] as Draft[],
    holdContacts: false, contactsHeld: false, releaseContacts: null as (() => void) | null,
    history: [] as Message[],
    referenceSources: [] as Message[],
    savedChats: [chat],
    holdPeopleSearch: false,
    failPreferences: false,
    holdStartup, releaseStartupMode: null as (() => void) | null, releaseStartupSession: null as (() => void) | null,
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
    if (path === '/v1/auth/logout') return response({});
    if (path === '/health/ready') {
      if (n.holdHealth) {
        n.healthHeld = true;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { n.healthCancelled = true; reject(new Error('aborted')); }, { once: true });
        });
      }
      return response({ capabilities: { agent: true, speechRecognition: true, speechSynthesis: true } });
    }
    if (path === '/v1/chats') return response(method === 'POST' ? { id: n.savedChats.find(item => item.recipient.id === body.recipientId)?.id ?? chat.id } : n.savedChats);
    if (path.startsWith('/v1/users?query=')) {
      if (n.holdPeopleSearch) return new Promise((resolve, reject) => {
        n.peopleSearches.push({ query: decodeURIComponent(path.split('query=')[1]!), signal: init!.signal!, resolve, reject });
      });
      return response([chat.recipient]);
    }
    if (path === '/v1/contacts' && method === 'POST') { const contact = { ...chat.recipient, name: 'Anna', contactId: 'contact-anna' }; if (!n.savedContacts.length) n.savedContacts.push(contact); return response(contact); }
    if (path === '/v1/contacts') {
      if (n.holdContacts) { n.contactsHeld = true; await new Promise<void>(resolve => { n.releaseContacts = resolve; }); }
      return response(n.savedContacts);
    }
    if (path === '/v1/chats/anna') return response(chat);
    if (path.startsWith('/v1/chats/anna/messages/')) return response(n.referenceSources.find(source => path.endsWith('/' + source.id)));
    if (path === '/v1/chats/anna/messages' && method === 'POST') {
      if (n.failSend) throw new Error('Send failed');
      return response({ id: 'sent-note', chatId: 'anna', senderId: 'user', kind: body.content.kind, mediaId: body.content.mediaId, text: null, createdAt: new Date().toISOString() });
    }
    if (path.startsWith('/v1/chats/anna/messages')) return response(n.history);
    if (path.startsWith('/v1/chats/ben/messages')) return response([]);
    if (path === '/v1/chats/anna/read') return response({});
    if (path === '/v1/drafts') return response(n.savedDrafts);
    if (path === '/v1/assistant/sessions') return response(assistantSession);
    if (path === '/v1/assistant/sessions/assistant') return response({ turns: [...n.turns].reverse() });
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
  const module = { exports: {} as { useMia: () => Mia; App: React.ComponentType; UiProvider: React.ComponentType<any>; Button: React.ComponentType<any>; Reveal: React.ComponentType<any>; MessageReferenceCard: React.ComponentType<React.ComponentProps<typeof import('../src/screens/MessageReferenceCard').MessageReferenceCard>> } };
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
  if (!holdStartup) await wait(() => renderApp ? n.requests.some(request => request.path === '/v1/assistant/sessions/assistant') : !!mia.assistantSession);
  return {
    n, components: module.exports, get mia(): Mia { return renderApp ? renderer.root.findAll(node => typeof node.props.mia?.saveAiMode === 'function')[0]!.props.mia : mia; }, get tree() { return renderer.root; }, wait,
    async say() { assert.ok(n.capture); await act(async () => { n.capture!({ uri: 'file:///command.wav', durationMs: 2400 }); }); },
    async close() { await act(async () => { renderer.unmount(); }); globalThis.fetch = realFetch; globalThis.FormData = realFormData; delete (globalThis as any).__miaNative; },
  };
}

test('lower hold records until release, asks before sending, and preserves the agent mute choice', async () => {
  for (const native of [false, true]) for (const muted of [false, true]) {
    const h = await mount(true, true, native);
    let gesture: ReturnType<typeof pressGesture> | undefined;
    try {
      await h.wait(() => native ? !!h.n.nativePCM : !!h.n.capture);
      if (muted) await act(async () => { await h.mia.toggleMicrophone(); });
      await act(async () => { await h.mia.navigate('chats', 'anna'); });
      const layer = () => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.testID === 'agent-interaction-layer')[0]!;
      gesture = pressGesture(layer().props, { x: 120, y: 740 });
      await act(async () => { gesture!.begin(); });
      await h.wait(() => h.mia.audioState === 'recording');
      assert.equal(h.n.noteRecording, !native); assert.equal(h.n.capture, null); assert.equal(!!h.n.nativePCM, native);
      assert.equal(h.mia.microphoneMuted, muted); assert.equal(h.mia.aiMode, true);
      await act(async () => { h.n.nativePCM?.(new Uint8Array(2400)); gesture!.release(); });
      await h.wait(() => !!h.n.playback);
      assert.ok(h.mia.recording); assert.equal(h.n.noteRecording, false);
      const request = h.n.requests.find(r => r.path.endsWith('/turns') && r.method === 'POST')!;
      assert.equal(request.body.context.voiceNote.recipientId, 'recipient');
      assert.equal(request.body.context.voice.microphoneMuted, muted);
      assert.equal(h.n.requests.filter(r => r.path === '/v1/chats/anna/messages' && r.method === 'POST').length, 0);
      await act(async () => { h.n.playback!(); });
      await h.wait(() => h.mia.audioState === 'idle' && h.mia.voicePhase !== 'speaking');
      assert.equal(h.mia.microphoneMuted, muted);
      if (!native && !muted) await h.wait(() => !!h.n.capture);
      if (!native && muted) assert.equal(h.n.capture, null);
      if (native) {
        await h.wait(() => !!h.n.nativePCM);
        const packets = h.n.pcmPackets;
        await act(async () => { h.n.nativePCM!(new Uint8Array(12000)); });
        assert.equal(h.n.pcmPackets > packets, !muted);
      }
      assert.ok(h.mia.recording, 'returning to command listening keeps the original unsent');
    } finally { gesture?.dispose(); await h.close(); }
  }
});

test('a new lower hold replaces an unsent note, its preview or its send question without changing mute', async () => {
  for (const native of [false, true]) for (const muted of [false, true]) for (const phase of ['draft', 'preview', 'question']) {
    const h = await mount(true, true, native);
    let gesture: ReturnType<typeof pressGesture> | undefined;
    let previous: Promise<void> | undefined;
    try {
      await act(async () => { await h.mia.navigate('chats', 'anna'); });
      if (muted) await act(async () => { await h.mia.toggleMicrophone(); });
      if (phase === 'question') {
        await act(async () => { await h.mia.beginHeldRecording(); });
        await act(async () => { h.n.nativePCM?.(new Uint8Array(2400)); previous = h.mia.endHeldRecording(); });
        await h.wait(() => !!h.n.playback);
      } else {
        await act(async () => { await h.mia.startRecording(); h.n.nativePCM?.(new Uint8Array(2400)); await h.mia.finishRecording(); });
        if (phase === 'preview') {
          await act(async () => { previous = h.mia.preview().catch(reason => { assert.equal(reason.constructor.name, 'CancelledError'); }); });
          await h.wait(() => !!h.n.playback);
        }
      }
      const oldNote = (h.n.frames.filter(frame => frame.type === 'voice.context' && (frame.context as any)?.voiceNote).at(-1)!.context as any).voiceNote;
      const layer = h.tree.findAll(node => node.type === 'Pressable' as any && node.props.testID === 'agent-interaction-layer')[0]!;
      gesture = pressGesture(layer.props, { x: 120, y: 740 });
      await act(async () => { gesture!.begin(); });
      await h.wait(() => h.mia.audioState === 'recording');
      assert.equal(h.mia.recording, null); assert.equal(h.n.noteRecording, !native);
      assert.equal(h.n.deleted.filter(uri => uri === 'file:///note.wav').length, 1);
      assert.equal(h.mia.microphoneMuted, muted);
      assert.equal(h.n.requests.filter(r => r.path === '/v1/chats/anna/messages' && r.method === 'POST').length, 0);
      await act(async () => { h.n.nativePCM?.(new Uint8Array(2400)); gesture!.release(); });
      await h.wait(() => !!h.n.playback);
      const newNote = (h.n.requests.filter(r => r.path.endsWith('/turns') && r.method === 'POST').at(-1)!.body.context).voiceNote;
      assert.notEqual(newNote.id, oldNote.id); assert.equal(newNote.recipientId, 'recipient');
      await act(async () => { h.n.playback!(); await previous; });
      await h.wait(() => h.mia.audioState === 'idle' && h.mia.voicePhase !== 'speaking');
      assert.ok(h.mia.recording); assert.equal(h.mia.microphoneMuted, muted);
      assert.equal(h.n.audioConflicts, 0); assert.equal(h.mia.voiceFault, false);
    } finally { gesture?.dispose(); await h.close(); }
  }
});

test('native recording, its send question and media playback retain one graph and one recognition session', async () => {
  for (const muted of [false, true]) {
    const h = await mount(true, false, true);
    try {
      await h.wait(() => !!h.n.nativePCM);
      await act(async () => { await h.mia.navigate('chats', 'anna'); });
      if (muted) await act(async () => { await h.mia.toggleMicrophone(); });
      const starts = h.n.nativeStarts, stops = h.n.nativeStops;
      const sessions = h.n.frames.filter(f => f.type === 'voice.start').length;
      const cancellations = h.n.frames.filter(f => f.type === 'voice.cancel').length;
      await act(async () => { await h.mia.beginHeldRecording(); });
      await act(async () => { await h.n.event({ id: 'late-acceptance', type: 'assistant.accepted', createdAt: new Date().toISOString(),
        payload: { clientTurnId: 'before-recording', turnId: 'before-recording' } }, 0); });
      assert.equal(h.mia.audioState, 'recording', 'late acceptance cannot cancel a newer recording gesture');
      const packets = h.n.pcmPackets, pcm = new Uint8Array([0, 0, 255, 127, 0, 128, 1, 2]);
      await act(async () => { h.n.nativePCM!(pcm); });
      assert.equal(h.n.pcmPackets, packets, 'recorded words cannot become commands');
      let finished!: Promise<void>;
      await act(async () => { finished = h.mia.endHeldRecording(); });
      await h.wait(() => !!h.n.playback);
      assert.deepEqual(h.n.savedPcm, pcm, 'the draft contains the original microphone samples');
      await act(async () => { h.n.playback!(); await finished; });
      let preview!: Promise<void>;
      await act(async () => { preview = h.mia.preview().catch(reason => { assert.equal(reason.constructor.name, 'CancelledError'); }); });
      await h.wait(() => !!h.n.playback);
      await act(async () => { await h.mia.stopAudio(); await preview; });
      let media!: Promise<void>;
      await act(async () => { media = h.mia.playMedia('voice-source'); });
      await h.wait(() => !!h.n.playback);
      await act(async () => { h.n.playback!(); await media; });
      assert.equal(h.n.nativeStarts, starts); assert.equal(h.n.nativeStops, stops);
      assert.equal(h.n.frames.filter(f => f.type === 'voice.start').length, sessions);
      assert.equal(h.n.frames.filter(f => f.type === 'voice.cancel').length, cancellations);
      assert.equal(h.n.noteRecording, false, 'Expo recorder never acquired the audio session');
      assert.equal(h.mia.microphoneMuted, muted); assert.equal(h.n.audioConflicts, 0);
      assert.equal(h.mia.voicePhase, muted ? 'paused' : 'listening');
      assert.equal(h.n.requests.find(r => r.path.endsWith('/stop'))!.body.preserveVoice, true);
    } finally { await h.close(); }
  }
});

test('release during recording startup and cancellation cannot start a late recorder or ask to send', async () => {
  for (const cancellation of ['release', 'background', 'cancel'] as const) {
    const h = await mount(true, true);
    let gesture: ReturnType<typeof pressGesture> | undefined;
    try {
      await act(async () => { await h.mia.navigate('chats', 'anna'); });
      h.n.holdNoteStart = true;
      const layer = h.tree.findAll(node => node.type === 'Pressable' as any && node.props.testID === 'agent-interaction-layer')[0]!;
      gesture = pressGesture(layer.props, { x: 120, y: 740 });
      await act(async () => { gesture!.begin(); });
      await h.wait(() => !!h.n.releaseNoteStart);
      await act(async () => {
        if (cancellation === 'background') h.n.appState('background');
        else if (cancellation === 'cancel') gesture!.cancel();
        else gesture!.release();
        h.n.releaseNoteStart!();
      });
      assert.equal(h.n.noteRecording, false); assert.equal(h.mia.recording, null);
      assert.equal(h.n.turns.length, 0); assert.equal(h.mia.aiMode, true); assert.equal(h.mia.microphoneMuted, false);
    } finally { gesture?.dispose(); await h.close(); }
  }
});

test('original playback and local preview suspend only command listening and restore the current mute choice', async () => {
  for (const native of [false, true]) for (const muted of [false, true]) for (const preview of [false, true]) {
    const h = await mount(true, false, native);
    try {
      await h.wait(() => native ? !!h.n.nativePCM : !!h.n.capture);
      await act(async () => { await h.mia.navigate('chats', 'anna'); });
      if (preview) {
        await act(async () => { await h.mia.startRecording(); h.n.nativePCM?.(new Uint8Array(2400)); await h.mia.finishRecording(); });
      }
      if (muted) await act(async () => { await h.mia.toggleMicrophone(); });
      let playback!: Promise<void>;
      await act(async () => { playback = preview ? h.mia.preview() : h.mia.playMedia('original'); });
      await h.wait(() => !!h.n.playback);
      assert.equal(h.n.capture, null); assert.equal(!!h.n.nativePCM, native);
      assert.equal(h.mia.microphoneMuted, muted);
      await act(async () => { h.n.playback!(); await playback; });
      assert.equal(h.mia.microphoneMuted, muted);
      if (!native && !muted) await h.wait(() => !!h.n.capture);
      if (!native && muted) assert.equal(h.n.capture, null);
      if (native) {
        await h.wait(() => !!h.n.nativePCM);
        const packets = h.n.pcmPackets;
        await act(async () => { h.n.nativePCM!(new Uint8Array(12000)); });
        assert.equal(h.n.pcmPackets > packets, !muted);
      }
      assert.equal(h.n.audioConflicts, 0);
    } finally { await h.close(); }
  }
});

test('original playback preserves pending ASR renewal and a late ready frame cannot restart the graph', async () => {
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    h.n.holdASR = true;
    const previous = h.n.frames.filter(f => f.type === 'voice.start').at(-1)!;
    await act(async () => { h.n.frame({ type: 'voice.closed', requestId: previous.requestId }); });
    const pending = h.n.frames.filter(f => f.type === 'voice.start').at(-1)!;
    const starts = h.n.nativeStarts;
    let playback!: Promise<void>;
    await act(async () => { playback = h.mia.playMedia('original', () => {}); });
    await h.wait(() => !!h.n.playback);
    await act(async () => { h.n.frame({ type: 'voice.ready', requestId: pending.requestId }); });
    assert.equal(h.n.nativeStarts, starts); assert.ok(h.n.nativePCM);
    h.n.holdASR = false;
    await act(async () => { h.n.playback!(); await playback; });
    await h.wait(() => !!h.n.nativePCM);
    assert.equal(h.n.audioConflicts, 0);
  } finally { await h.close(); }
});

test('muting during playback stays muted after a lower-area stop without changing agent mode', async () => {
  const h = await mount(true, true, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    let playback!: Promise<void>;
    await act(async () => { playback = h.mia.playMedia('original').catch(reason => { assert.equal(reason.constructor.name, 'CancelledError'); }); });
    await h.wait(() => !!h.n.playback);
    await act(async () => { await h.mia.toggleMicrophone(); });
    const layer = h.tree.findAll(node => node.type === 'Pressable' as any && node.props.testID === 'agent-interaction-layer')[0]!;
    const gesture = pressGesture(layer.props, { x: 120, y: 740 });
    await act(async () => { gesture.begin(); gesture.release(); await playback; });
    gesture.dispose();
    assert.equal(h.mia.microphoneMuted, true); assert.equal(h.mia.aiMode, true);
    await h.wait(() => !!h.n.nativePCM);
    const packets = h.n.pcmPackets;
    await act(async () => { h.n.nativePCM!(new Uint8Array(2400)); });
    assert.equal(h.n.pcmPackets, packets);
  } finally { await h.close(); }
});

test('agent recording actions await original preview, reject replaced recordings and send only the bound draft', async () => {
  const h = await mount(true, false, true);
  try {
    await act(async () => { await h.mia.navigate('chats', 'anna'); await h.mia.startRecording(); h.n.nativePCM?.(new Uint8Array(2400)); await h.mia.finishRecording(); });
    await h.wait(() => !!h.n.nativePCM);
    const stream = h.n.frames.filter(frame => frame.type === 'voice.start').at(-1)!;
    const currentContext = h.n.frames.filter(f => f.type === 'voice.context').at(-1)!.context;
    const note = (currentContext as any).voiceNote;
    const turn: Turn = { id: 'local-note-turn', sessionId: 'assistant', userId: 'user', generation: 1, userText: 'Play my recording.',
      assistantText: null, status: 'running', clientTurnId: 'local-note-client', context: currentContext as any };
    h.n.turns.push(turn);
    await act(async () => { h.n.frame({ type: 'voice.interruption', requestId: stream.requestId, clientTurnId: turn.clientTurnId }); h.n.frame({ type: 'turn.accepted', turn }); });
    const command = async (id: string, action: string, recordingId = note.id, recipientId = note.recipientId) => {
      await act(async () => { await h.n.event({ id, type: 'device.action_requested', createdAt: new Date().toISOString(), payload: {
        actionId: id, sessionId: 'assistant', turnId: turn.id, kind: 'control_voice_note',
        payload: { recordingId, recipientId, action }, expiresIn: 180000, context: turn.context,
      } }, 0); });
    };
    const result = (id: string) => h.n.requests.find(r => r.path === `/v1/device-actions/${id}/result`)?.body;
    await command('preview-local', 'preview');
    await h.wait(() => !!h.n.playback);
    assert.equal(result('preview-local'), undefined); assert.ok(h.n.nativePCM);
    assert.equal(h.n.requests.some(r => r.path === '/v1/media'), false, 'preview stays local');
    await act(async () => { h.n.playback!(); });
    await h.wait(() => !!result('preview-local'));
    assert.equal(result('preview-local').success, true);
    await command('wrong-local', 'send', 'replaced-recording');
    await h.wait(() => !!result('wrong-local'));
    assert.equal(result('wrong-local').success, false); assert.ok(h.mia.recording);
    await command('wrong-recipient', 'send', note.id, 'ben-user');
    await h.wait(() => !!result('wrong-recipient'));
    assert.equal(result('wrong-recipient').success, false); assert.ok(h.mia.recording);
    await command('send-local', 'send');
    await h.wait(() => !!result('send-local'));
    assert.equal(result('send-local').success, true); assert.equal(h.mia.recording, null);
    assert.equal(h.n.requests.filter(r => r.path === '/v1/chats/anna/messages' && r.method === 'POST').length, 1);
    assert.equal(h.n.audioConflicts, 0); assert.equal(h.mia.voiceFault, false);
  } finally { await h.close(); }
});

test('recording delivery resolves its captured recipient even after the visible chat changes', async () => {
  const h = await mount(true);
  try {
    h.n.savedChats.push({ ...chat, id: 'ben', recipient: { id: 'ben-user', displayName: 'Ben', username: 'ben' } });
    await act(async () => { await h.mia.navigate('chats', 'anna'); await h.mia.startRecording(); await h.mia.finishRecording(); });
    const recorded = (h.n.frames.filter(f => f.type === 'voice.context' && (f.context as any)?.voiceNote).at(-1)!.context as any).voiceNote;
    assert.equal(recorded.recipientId, 'recipient'); assert.equal(recorded.chatId, undefined);
    await act(async () => { await h.mia.navigate('chats', 'ben'); });
    assert.equal(h.mia.activeChatId, 'ben');
    await act(async () => { await h.mia.useRecording(); });
    const destination = h.n.requests.filter(r => r.path === '/v1/chats' && r.method === 'POST').at(-1)!;
    assert.equal(destination.body.recipientId, 'recipient');
    assert.equal(h.n.requests.filter(r => r.path === '/v1/chats/anna/messages' && r.method === 'POST').length, 1);
    assert.equal(h.n.requests.filter(r => r.path === '/v1/chats/ben/messages' && r.method === 'POST').length, 0);
  } finally { await h.close(); }
});

test('failed sends keep the original draft; retry and repeated approval use one message identity', async () => {
  const h = await mount(true);
  try {
    await act(async () => { await h.mia.navigate('chats', 'anna'); await h.mia.startRecording(); await h.mia.finishRecording(); });
    const value = h.mia.recording;
    h.n.failSend = true;
    await act(async () => { await assert.rejects(h.mia.useRecording()); });
    assert.equal(h.mia.recording, value); assert.equal(h.mia.pending[0]?.status, 'failed');
    h.n.failSend = false;
    await act(async () => { await Promise.all([h.mia.useRecording(), h.mia.useRecording()]); });
    assert.equal(h.mia.recording, null);
    const sends = h.n.requests.filter(r => r.path === '/v1/chats/anna/messages' && r.method === 'POST');
    assert.equal(sends.length, 2); assert.equal(sends[0]!.body.clientMessageId, sends[1]!.body.clientMessageId);
    assert.equal(h.n.requests.filter(r => r.path === '/v1/media').length, 1, 'retry keeps the same original media');
  } finally { await h.close(); }
});

test('startup waits for both saved credentials and mode, then opens assistant home only for the restored voice mode', async () => {
  for (const enabled of [false, true]) for (const sessionFirst of [true, false]) {
    const h = await mount(enabled, true, false, true);
    const loading = () => h.tree.findAll(node => node.type === 'View' as any && node.props.testID === 'app-startup').length > 0;
    const voice = () => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel?.startsWith('Mia voice mode.')).length > 0;
    const tabs = () => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityRole === 'tab');
    try {
      assert.equal(loading(), true); assert.equal(voice(), false); assert.equal(tabs().length, 0);
      assert.equal(h.tree.findAll(node => typeof node.type === 'function' && node.type.name === 'MiaCore').length, 0, 'loading must not impersonate the voice-mode orb');
      assert.equal(h.n.captures, 0); assert.equal(h.n.requests.length, 0);
      await act(async () => { if (sessionFirst) h.n.releaseStartupSession!(); else h.n.releaseStartupMode!(); });
      assert.equal(loading(), true); assert.equal(voice(), false); assert.equal(tabs().length, 0);
      assert.equal(h.n.captures, 0);
      await act(async () => { if (sessionFirst) h.n.releaseStartupMode!(); else h.n.releaseStartupSession!(); });
      await h.wait(() => !loading());
      assert.equal(h.mia.aiMode, enabled); assert.equal(voice(), enabled);
      const root = h.tree.findAll(node => node.type === 'SafeAreaView' as any && node.props.edges)[0]!;
      assert.equal(root.props.pointerEvents, enabled ? 'none' : 'auto');
      assert.equal(root.props.accessibilityElementsHidden, enabled);
      assert.equal(h.mia.tab, enabled ? 'assistant' : 'chats');
      assert.equal(h.tree.findAll(node => node.type === 'ScrollView' as any && node.props.testID === 'agent-home').length, enabled ? 1 : 0);
      assert.equal(h.tree.findAll(node => node.type === 'View' as any && node.props.testID === 'agent-dock').length, enabled ? 1 : 0);
      if (enabled) await h.wait(() => h.n.captures === 1);
      else { assert.equal(h.n.captures, 0); assert.equal(h.n.preferences.get('mia.ai_mode'), 'false'); }
    } finally { await h.close(); }
  }
});

test('ai_mode starts one global conversation, speaks automatically and keeps listening after a reply and tab navigation', async () => {
  const h = await mount();
  try {
    assert.equal(h.n.captures, 0);
    await act(async () => { await h.mia.saveAiMode(true); });
    await h.wait(() => !!h.n.capture);
    assert.equal(h.mia.tab, 'assistant');
    await h.say(); await h.wait(() => h.n.playbacks === 1);
    assert.equal(h.mia.voicePhase, 'speaking'); assert.equal(h.n.captures, 1);
    assert.deepEqual(h.n.turns[0]?.context, { route: '/mia', revision: 1, previousRoute: '/chats', voice: { enabled: true, microphoneMuted: false, revision: 1 } });
    await act(async () => { h.n.playback!(); });
    await h.wait(() => h.n.captures === 2);
    await act(async () => { await h.mia.navigate('people'); });
    await h.wait(() => !!h.n.capture);
    assert.equal(h.mia.tab, 'people'); assert.equal(h.mia.aiMode, true);
    h.n.text = 'Find David'; await h.say(); await h.wait(() => h.n.playbacks === 2);
    assert.equal(h.n.turns[1]?.context?.route, '/contacts');
    await act(async () => { await h.mia.saveAiMode(false); });
    assert.equal(h.n.capture, null); assert.equal(h.mia.voicePhase, 'off');
    assert.equal(h.mia.tab, 'people', 'leaving voice mode retains the current messenger page');
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

test('agent page actions switch visible views and retain the native voice session and same-turn action ownership', async () => {
  const h = await mount(true, true, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    const stream = h.n.frames.find(frame => frame.type === 'voice.start')!;
    const turn: Turn = { id: 'page-turn', sessionId: 'assistant', userId: 'user', generation: 1, userText: 'Show my contacts and then open Anna.',
      assistantText: null, status: 'running', clientTurnId: 'page-client', context: stream.context as any };
    h.n.turns.push(turn);
    await act(async () => { h.n.frame({ type: 'voice.interruption', requestId: stream.requestId, clientTurnId: turn.clientTurnId }); h.n.frame({ type: 'turn.accepted', turn }); });
    const stops = h.n.nativeStops; const starts = h.n.nativeStarts;
    h.n.savedDrafts.push({ id: 'saved-draft', recipientId: 'recipient', recipient: chat.recipient, kind: 'text', text: 'Keep this message for Anna.', mediaId: null,
      version: 1, state: 'editing', reviewedVersion: null, updatedAt: new Date().toISOString() });
    const stopRequests = h.n.requests.filter(request => request.path.endsWith('/stop')).length;
    const open = async (id: string, kind: string, payload: Record<string, unknown>) => {
      await act(async () => { await h.n.event({ id, type: 'device.action_requested', createdAt: new Date().toISOString(), payload: {
        actionId: id, sessionId: 'assistant', turnId: turn.id, kind, payload, context: turn.context,
      } }, 0); });
      const feedback = h.n.requests.find(request => request.path === `/v1/device-actions/${id}/result`)!.body;
      assert.equal(feedback.success, true);
      return feedback.result.context;
    };
    for (const [route, tab] of [['/contacts', 'people'], ['/drafts', 'drafts'], ['/settings', 'settings'], ['/chats', 'chats'], ['/mia', 'assistant']]) {
      const reported = await open(`page-${tab}`, 'open_page', { route });
      assert.equal(h.mia.tab, tab); assert.equal(h.mia.activeChatId, null); assert.equal(reported.route, route);
      assert.ok(h.tree.findAll(node => node.type === 'View' as any && node.props.testID === 'agent-dock').length);
      assert.equal(h.tree.findAll(node => node.type === 'SafeAreaView' as any && node.props.accessibilityElementsHidden === true).length, 1);
      if (tab === 'drafts') {
        assert.ok(h.tree.findAll(node => node.type === 'Text' as any && node.props.children === 'Saved messages').length);
        assert.ok(h.tree.findAll(node => node.type === 'Text' as any && node.props.children === 'Keep this message for Anna.').length);
        assert.ok(h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Review message').length);
      }
    }
    assert.equal((await open('page-chat', 'open_chat', { chatId: 'anna' })).route, '/chat/anna');
    assert.equal(h.mia.activeChatId, 'anna');
    assert.equal(h.tree.findAll(node => node.type === 'FlatList' as any).length, 1, 'the conversation remains visible');
    assert.equal(h.tree.findAll(node => node.props.testID === 'message-composer-area').length, 0, 'voice mode hides manual composition');
    assert.equal(h.tree.findAll(node => node.type === 'TextInput' as any && node.props.accessibilityLabel === 'Message Anna').length, 0);
    await open('page-return', 'open_page', { route: '/mia' });
    await open('page-followup', 'stop_audio', {});
    assert.equal(h.mia.tab, 'assistant'); assert.equal(h.mia.aiMode, true);
    assert.equal(h.n.nativeStops, stops); assert.equal(h.n.nativeStarts, starts);
    assert.equal(h.n.requests.filter(request => request.path.endsWith('/stop')).length, stopRequests);
    assert.equal(turn.status, 'running');
    await act(async () => { await h.mia.navigate('assistant'); });
    const acknowledged = h.n.requests.filter(request => request.path.startsWith('/v1/device-actions/')).length;
    await act(async () => { await h.n.event({ id: 'after-manual-home', type: 'device.action_requested', createdAt: new Date().toISOString(), payload: {
      actionId: 'after-manual-home', turnId: turn.id, kind: 'open_page', payload: { route: '/contacts' }, context: turn.context,
    } }, 0); });
    assert.equal(h.mia.tab, 'assistant'); assert.equal(h.mia.aiMode, true);
    assert.equal(h.n.requests.filter(request => request.path.startsWith('/v1/device-actions/')).length, acknowledged, 'manual home navigation revokes even a same-route lease');
  } finally { await h.close(); }
});

test('unauthorized, expired, replayed and unallowlisted page actions cannot change the visible view', async () => {
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    const stream = h.n.frames.find(frame => frame.type === 'voice.start')!;
    const turn: Turn = { id: 'guarded-page-turn', sessionId: 'assistant', userId: 'user', generation: 1, userText: 'Show contacts.',
      assistantText: null, status: 'running', clientTurnId: 'guarded-page-client', context: stream.context as any };
    h.n.turns.push(turn);
    await act(async () => { h.n.frame({ type: 'voice.interruption', requestId: stream.requestId, clientTurnId: turn.clientTurnId }); h.n.frame({ type: 'turn.accepted', turn }); });
    const send = async (id: string, options: { turnId?: string; createdAt?: string; route?: string; context?: any; replayed?: boolean } = {}) => {
      await act(async () => { await h.n.event({ id, type: 'device.action_requested', createdAt: options.createdAt ?? new Date().toISOString(), payload: {
        actionId: id, turnId: options.turnId ?? turn.id, kind: 'open_page', payload: { route: options.route ?? '/contacts' }, context: options.context ?? turn.context,
      } }, 0, options.replayed); });
      assert.equal(h.mia.tab, 'assistant');
      return h.n.requests.find(request => request.path === `/v1/device-actions/${id}/result`)?.body;
    };
    assert.equal(await send('foreign-page', { turnId: 'another-device-turn' }), undefined);
    assert.equal(await send('expired-page', { createdAt: new Date(Date.now() - 19000).toISOString() }), undefined);
    assert.equal(await send('replayed-page', { replayed: true }), undefined);
    assert.equal((await send('wrong-context-page', { context: { route: '/settings', revision: 99 } })).success, false);
    for (const route of ['https://example.com', '/chat/anna', '/settings/../mia']) assert.equal((await send(`invalid-${route}`, { route })).success, false);
    assert.equal(h.mia.aiMode, true);
  } finally { await h.close(); }
});

test('manual navigation during a page refresh prevents the pending action from stealing the screen', async () => {
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    const stream = h.n.frames.find(frame => frame.type === 'voice.start')!;
    const turn: Turn = { id: 'refresh-page-turn', sessionId: 'assistant', userId: 'user', generation: 1, userText: 'Show contacts.',
      assistantText: null, status: 'running', clientTurnId: 'refresh-page-client', context: stream.context as any };
    h.n.turns.push(turn);
    await act(async () => { h.n.frame({ type: 'voice.interruption', requestId: stream.requestId, clientTurnId: turn.clientTurnId }); h.n.frame({ type: 'turn.accepted', turn }); });
    h.n.holdContacts = true;
    let pending!: Promise<void>;
    await act(async () => { pending = h.n.event({ id: 'refresh-page', type: 'device.action_requested', createdAt: new Date().toISOString(), payload: {
      actionId: 'refresh-page', turnId: turn.id, kind: 'open_page', payload: { route: '/contacts' }, context: turn.context,
    } }, 0); });
    await h.wait(() => h.n.contactsHeld);
    await act(async () => { await h.mia.navigate('settings'); });
    await act(async () => { h.n.holdContacts = false; h.n.releaseContacts!(); await pending; });
    assert.equal(h.mia.tab, 'settings'); assert.equal(h.mia.aiMode, true);
    assert.equal(h.n.requests.find(request => request.path === '/v1/device-actions/refresh-page/result')!.body.success, false);
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

test('finishing a voice note restores command capture while keeping its unsent draft', async () => {
  const h = await mount(true);
  try {
    await h.wait(() => !!h.n.capture);
    await act(async () => { await h.mia.startRecording(); });
    assert.equal(h.n.capture, null); assert.equal(h.mia.audioState, 'recording');
    await act(async () => { await h.mia.finishRecording(); });
    assert.ok(h.mia.recording); await h.wait(() => !!h.n.capture);
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

test('a failed spoken response stops and can resume on the assistant home', async () => {
  const h = await mount(true);
  try {
    await h.wait(() => !!h.n.capture); h.n.failSpeech = true;
    await h.say(); await h.wait(() => h.mia.voiceFault);
    assert.equal(h.mia.voicePhase, 'waiting'); assert.equal(h.n.capture, null); assert.equal(h.mia.aiMode, true);
    h.n.failSpeech = false;
    await act(async () => { await h.mia.resumeAssistant(); });
    await h.wait(() => !!h.n.capture);
    assert.equal(h.mia.voiceFault, false); assert.equal(h.mia.error, '');
    assert.equal(h.mia.tab, 'assistant');
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
    assert.deepEqual(h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityRole === 'tab').map(node => node.props.accessibilityLabel), ['Contacts', 'Chats', 'Settings']);
      assert.equal(pressable('Mia voice mode'), undefined, 'no dock launcher');
      assert.equal(pressable('Enable voice mode'), undefined, 'activation is absent outside Settings');
      await act(async () => { pressable('Settings').props.onPress(); });
      await act(async () => { pressable('Mia voice mode').props.onPress(); });
      assert.equal(h.mia.aiMode, false, 'one tap must not activate');
      await act(async () => { pressable('Keep voice mode off').props.onPress(); });
      assert.equal(h.mia.aiMode, false);
      await act(async () => { pressable('Mia voice mode').props.onPress(); });
      await act(async () => { pressable('Enable voice mode now').props.onPress(); });
      await h.wait(() => !!h.n.capture);
      assert.equal(h.mia.tab, 'assistant');
      assert.equal(h.tree.findAll(node => node.type === 'SafeAreaView' as any && node.props.pointerEvents === 'none').length, 1);
      assert.equal(h.tree.findAll(node => node.type === 'SafeAreaView' as any && node.props.accessibilityElementsHidden === true && node.props.importantForAccessibility === 'no-hide-descendants').length, 1);
      assert.equal(h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityViewIsModal === true).length, 1);
      assert.ok(h.tree.findAll(node => node.type === 'View' as any && node.props.testID === 'agent-dock').length);
      await act(async () => { await overlay().props.onPress(); });
      await h.wait(() => h.n.capture === null);
      assert.equal(overlay().props.accessibilityState.checked, false);
      assert.equal(h.n.preferences.get('mia.ai_mode'), 'true');
      await act(async () => { await overlay().props.onPress(); });
      await h.wait(() => !!h.n.capture);
      assert.equal(overlay().props.accessibilityState.checked, true);
      const exit = overlay;
      await act(async () => { overlay().props.onAccessibilityEscape(); });
      assert.equal(h.mia.aiMode, true); assert.ok(h.n.announcements.length >= 1);
      const aborted = pressGesture(overlay().props);
      await act(async () => { aborted.begin(); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); aborted.release(); });
      aborted.dispose();
      assert.equal(h.mia.aiMode, true, 'the previous short hold must not exit');
      assert.equal(h.mia.microphoneMuted, false, 'release must not become a mic tap');
      assert.equal(h.n.vibrations, 0);
      const backgroundHold = pressGesture(exit().props);
      await act(async () => { backgroundHold.begin(); h.n.appState('background'); });
      backgroundHold.dispose();
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
      assert.equal(h.mia.tab, 'chats', 'holding exit on the assistant home returns to the messenger');
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

test('the transparent global layer owns every page and consumes taps, swipes and multi-touch without activating content', async () => {
  const h = await mount(true, true);
  const layer = () => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.testID === 'agent-interaction-layer')[0]!;
  const event = (x: number, y: number, timestamp: number, fingers = 1) => ({ nativeEvent: {
    pageX: x, pageY: y, timestamp, touches: Array.from({ length: fingers }, () => ({ pageX: x, pageY: y })), changedTouches: [{ pageX: x, pageY: y }],
  } });
  try {
    await h.wait(() => !!h.n.capture);
    const bounds = layer().props.style;
    for (const edge of ['top', 'left', 'right', 'bottom']) assert.equal(bounds[edge], 0);
    assert.equal(bounds.backgroundColor, 'transparent');
    assert.ok(layer().parent?.parent === h.tree.findAll(node => node.type === 'View' as any)[0], 'the layer is a sibling of the blocked content');
    for (const [tab, chatId] of [['assistant', null], ['chats', 'anna'], ['people', null], ['settings', null]] as const) {
      await act(async () => { await h.mia.navigate(tab, chatId); });
      const content = h.tree.findAll(node => node.type === 'SafeAreaView' as any)[0]!;
      assert.equal(content.props.pointerEvents, 'none'); assert.equal(content.props.accessibilityElementsHidden, true);
      assert.equal(content.props.importantForAccessibility, 'no-hide-descendants');
      const dock = h.tree.findAll(node => node.type === 'View' as any && node.props.testID === 'agent-dock')[0]!;
      assert.equal(dock.findAll(node => node.type === 'Pressable' as any).length, 0, 'footer is presentation only');
      for (const [x, y] of [[12, 24], [195, 400], [375, 820]]) {
        const muted = h.mia.microphoneMuted;
        await act(async () => { layer().props.onTouchStart(event(x!, y!, 1000)); layer().props.onPressOut(); layer().props.onPress(event(x!, y!, 1100)); });
        assert.equal(h.mia.microphoneMuted, y! < h.n.dimensions.height * .6 ? !muted : muted); assert.equal(h.mia.tab, tab); assert.equal(h.mia.activeChatId, chatId);
      }
      const muted = h.mia.microphoneMuted;
      await act(async () => { layer().props.onTouchStart(event(30, 120, 2000)); layer().props.onTouchMove(event(30, 240, 2100)); layer().props.onPressOut(); layer().props.onPress(event(30, 240, 2200)); });
      assert.equal(h.mia.microphoneMuted, muted, 'a swallowed scroll gesture is not a mic tap');
      await act(async () => { layer().props.onTouchStart(event(30, 120, 3000)); layer().props.onTouchStart(event(30, 120, 3050, 2)); layer().props.onPressOut(); layer().props.onPress(event(30, 120, 3100)); });
      assert.equal(h.mia.microphoneMuted, muted, 'multi-touch never becomes a tap');
    }
    assert.equal(h.n.vibrations, 0); assert.equal(h.mia.aiMode, true);
    await act(async () => { layer().props.onTouchStart(event(80, 240, 4000)); layer().props.onLongPress(); });
    assert.ok(h.tree.findAll(node => node.type === 'Text' as any && node.props.children === 'Hold…').length);
    await act(async () => { await h.mia.saveAiMode(false); });
    assert.equal(layer(), undefined);
    const content = h.tree.findAll(node => node.type === 'SafeAreaView' as any)[0]!;
    assert.equal(content.props.pointerEvents, 'auto'); assert.equal(content.props.accessibilityElementsHidden, false);
    await act(async () => { await h.mia.saveAiMode(true); });
    assert.ok(layer());
    assert.equal(h.tree.findAll(node => node.type === 'Text' as any && node.props.children === 'Hold…').length, 0, 'a new activation cannot inherit an abandoned exit hold');
  } finally { await h.close(); }
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
    const sessions = h.n.frames.filter(f => f.type === 'voice.start').length;
    const cancelled = h.n.frames.filter(f => f.type === 'voice.cancel').length;
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
    await act(async () => { await h.mia.toggleMicrophone(); });
    assert.equal(h.n.frames.filter(f => f.type === 'voice.start').length, sessions);
    assert.equal(h.n.frames.filter(f => f.type === 'voice.cancel').length, cancelled);
    assert.deepEqual(h.n.frames.filter(f => f.type === 'voice.mute').map(f => f.muted), [true, false, true, false]);
    assert.equal(h.mia.voicePhase, 'listening');
  } finally { h.n.holdNativeStop = false; h.n.releaseNativeStop?.(); await h.close(); }
});

test('muted recognition survives rotation, background and reconnect without reopening on unmute', async () => {
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    await act(async () => { h.n.nativePCM!(new Uint8Array(3840)); await h.mia.toggleMicrophone(); });
    const stream = () => h.n.frames.filter(f => f.type === 'voice.start').at(-1)!;
    await act(async () => { h.n.frame({ type: 'voice.closed', requestId: stream().requestId }); });
    assert.equal((stream().context as any).voice.microphoneMuted, true);
    assert.equal(h.mia.microphoneMuted, true); assert.equal(h.mia.voicePhase, 'paused');
    await act(async () => { h.n.appState('background'); });
    await h.wait(() => !h.n.nativePCM);
    await act(async () => { h.n.appState('active'); });
    await h.wait(() => !!h.n.nativePCM);
    assert.equal(h.mia.voicePhase, 'paused');
    await act(async () => { h.n.connection('Offline · reconnecting'); });
    await act(async () => { h.n.connection('Connected'); });
    await h.wait(() => !!h.n.nativePCM);
    await act(async () => { h.n.nativePCM!(new Uint8Array(3840)); });
    assert.equal(h.mia.voicePhase, 'paused');
    assert.equal((stream().context as any).voice.microphoneMuted, true);
    const sessions = h.n.frames.filter(f => f.type === 'voice.start').length;
    const packets = h.n.pcmPackets;
    await act(async () => { await h.mia.toggleMicrophone(); h.n.nativePCM!(new Uint8Array(3840)); });
    assert.equal(h.n.frames.filter(f => f.type === 'voice.start').length, sessions);
    assert.equal(h.mia.voicePhase, 'listening'); assert.ok(h.n.pcmPackets > packets);
  } finally { await h.close(); }
});

test('mute while waiting for ASR ready preserves the request and resumes without a second handshake', async () => {
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    h.n.holdASR = true;
    const first = h.n.frames.find(f => f.type === 'voice.start')!;
    await act(async () => { h.n.frame({ type: 'voice.closed', requestId: first.requestId }); });
    const stream = h.n.frames.filter(f => f.type === 'voice.start').at(-1)!;
    const sessions = h.n.frames.filter(f => f.type === 'voice.start').length;
    await act(async () => { await h.mia.toggleMicrophone(); h.n.nativePCM!(new Uint8Array(3840)); });
    const packets = h.n.pcmPackets;
    await act(async () => { h.n.frame({ type: 'voice.ready', requestId: stream.requestId }); });
    assert.equal(h.mia.voicePhase, 'paused'); assert.equal(h.n.pcmPackets, packets);
    await act(async () => { await h.mia.toggleMicrophone(); h.n.nativePCM!(new Uint8Array(3840)); });
    assert.equal(h.n.frames.filter(f => f.type === 'voice.start').length, sessions);
    assert.equal(h.mia.voicePhase, 'listening');
  } finally { await h.close(); }
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
    const inputRevision = (h.n.frames.filter(f => f.type === 'voice.mute').at(-1)!.revision as number);
    await act(async () => { h.n.frame({ type: 'voice.interruption', requestId: stream.requestId,
      inputRevision: inputRevision - 2, clientTurnId: 'queued-before-mute' }); });
    assert.ok(h.n.playback, 'an old interruption queued before mute/unmute cannot stop the current reply');
    await act(async () => { await h.mia.stopAssistantReply(); });
    assert.equal(h.n.playback, null); assert.equal(h.mia.aiMode, true); assert.equal(h.n.nativeStops, stops);
    assert.equal(h.n.frames.filter(f => f.type === 'voice.start').length, 2, 'only Stop reply rotates recognition');
  } finally { await h.close(); }
});

test('an already committed voice command delivered after mute still receives its spoken reply', async () => {
  const h = await mount(true, false, true);
  try {
    await h.wait(() => !!h.n.nativePCM);
    const stream = h.n.frames.find(f => f.type === 'voice.start')!;
    const turn: Turn = { id: 'committed-before-mute', sessionId: 'assistant', userId: 'user', generation: 1,
      userText: 'Explain', assistantText: 'Here is the answer.', status: 'completed', clientTurnId: 'committed-client', context: stream.context as any };
    h.n.turns.push(turn);
    await act(async () => { await h.mia.toggleMicrophone(); });
    await act(async () => { h.n.frame({ type: 'voice.closed', requestId: stream.requestId }); });
    await act(async () => {
      h.n.frame({ type: 'voice.interruption', requestId: stream.requestId, inputRevision: 0, clientTurnId: turn.clientTurnId });
      h.n.frame({ type: 'turn.accepted', requestId: stream.requestId, inputRevision: 0, turn });
    });
    await h.wait(() => !!h.n.playback);
    assert.equal(h.mia.microphoneMuted, true); assert.equal(h.mia.voicePhase, 'speaking');
    assert.equal(h.n.frames.filter(f => f.type === 'voice.start').length, 2, 'natural rotation preserves committed work from the previous stream');
    await act(async () => { await h.mia.stopAssistantReply(); });
    const playbacks = h.n.playbacks;
    await act(async () => { h.n.frame({ type: 'turn.accepted', requestId: stream.requestId, inputRevision: 0, turn }); });
    assert.equal(h.n.playbacks, playbacks, 'explicit stop revokes acceptance from old streams');
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
    assert.equal(h.mia.tab, 'chats');
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

test('voice-note playback waits for pending native startup and never opens a competing audio session', async () => {
  const h = await mount(false, false, true);
  try {
    h.n.holdNativeStart = true;
    await act(async () => { await h.mia.saveAiMode(true); });
    await h.wait(() => !!h.n.releaseNativeStart);
    const stops = h.n.nativeStops;
    let playback!: Promise<void>;
    await act(async () => { playback = h.mia.playMedia('note', () => {}); });
    assert.equal(h.n.playback, null);
    assert.equal(h.n.nativeStops, stops, 'the pending graph stays owned');
    h.n.holdNativeStart = false;
    await act(async () => { h.n.releaseNativeStart?.(); });
    await h.wait(() => !!h.n.playback);
    assert.equal(h.n.nativeSession, true, 'the voice note uses the graph that was already starting');
    await act(async () => { h.n.playback?.(); await playback; });
    assert.equal(h.n.audioConflicts, 0); assert.equal(h.n.nativeStops, stops);
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
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Contacts')[0]!.props.onPress(); });
    const input = h.tree.findAll(node => node.type === 'TextInput' as any && node.props.accessibilityLabel === 'Find by phone number or username')[0]!;
    await act(async () => { input.props.onChangeText('+1 (202) 555-0101'); });
    await h.wait(() => h.n.requests.some(request => request.path.startsWith('/v1/users?query=')));
    assert.ok(h.n.requests.some(request => request.path === `/v1/users?query=${encodeURIComponent('+1 (202) 555-0101')}`));
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Add Anna and open chat')[0]!.props.onPress(); });
    await h.wait(() => h.n.requests.some(request => request.path === '/v1/contacts' && request.method === 'POST'));
    assert.equal(h.n.requests.find(request => request.path === '/v1/contacts' && request.method === 'POST')?.body.userId, 'recipient');
    await h.wait(() => h.n.requests.some(request => request.path.startsWith('/v1/chats/anna/messages')));
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Back')[0]!.props.onPress(); });
    assert.equal(h.mia.tab, 'people', 'back returns to Contacts, where this conversation was opened');
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Contacts')[0]!.props.onPress(); });
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Anna, @anna')[0]!.props.onPress(); });
    await h.wait(() => h.mia.activeChatId === 'anna');
    assert.equal(h.n.requests.filter(request => request.path === '/v1/contacts' && request.method === 'POST').length, 1, 'opening a saved contact does not add it again');
    assert.equal(h.n.captures, 0, 'searching contacts must not activate the voice assistant');
  } finally { await h.close(); }
});

test('Contacts and Chats share header geometry and row height; chat back swipe returns to its origin', async () => {
  const h = await mount(false, true);
  const button = (label: string) => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === label)[0]!;
  const flatten = (value: any): Record<string, any> => Array.isArray(value) ? Object.assign({}, ...value.filter(Boolean).map(flatten)) : value ?? {};
  const header = (title: string) => h.tree.findAll(node => node.type === 'Text' as any && node.props.accessibilityRole === 'header' && node.props.children === title)[0]!.parent!;
  try {
    const chatHeader = flatten(header('Chats').props.style);
    const chatRow = flatten(button('Anna. No messages yet').props.style({ pressed: false }));
    const tabs = h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityRole === 'tab');
    assert.deepEqual(tabs.map(node => node.props.accessibilityLabel), ['Contacts', 'Chats', 'Settings']);
    const selectedIcon = tabs[1]!.findAll(node => node.type === 'AnimatedView' as any && flatten(node.props.style).borderRadius === 18)[0]!;
    const iconStyle = flatten(selectedIcon.props.style); assert.equal(iconStyle.width, 36); assert.equal(iconStyle.height, 36);
    assert.equal(tabs[1]!.props.accessibilityState.selected, true);
    h.n.savedContacts.push({ ...chat.recipient, contactId: 'contact-anna', name: 'Anna' });
    await act(async () => { await h.mia.refresh(); button('Contacts').props.onPress(); });
    assert.deepEqual(flatten(header('Contacts').props.style), chatHeader, 'the search row has the same header above it on both tabs');
    const contactRow = flatten(button('Anna, @anna').props.style({ pressed: false }));
    for (const key of ['minHeight', 'paddingVertical', 'paddingHorizontal', 'gap']) assert.equal(contactRow[key], chatRow[key]);
    assert.equal(h.tree.findAll(node => node.type === 'Text' as any && node.props.children === 'Saved contacts').length, 0, 'normal contacts retain the simple ungrouped list');
    await act(async () => { button('Anna, @anna').props.onPress(); });
    await h.wait(() => h.mia.activeChatId === 'anna');
    const back = h.n.backGesture!;
    await act(async () => { back.onPanResponderGrant!(); back.onPanResponderRelease!(null, { dx: 130, vx: .2 }); });
    await h.wait(() => h.mia.tab === 'people');
    assert.equal(h.mia.activeChatId, null);
    await act(async () => { button('Chats').props.onPress(); });
    await act(async () => { button('Anna. No messages yet').props.onPress(); });
    await h.wait(() => h.mia.activeChatId === 'anna');
    await act(async () => { button('Back').props.onPress(); });
    assert.equal(h.mia.tab, 'chats'); assert.equal(h.mia.activeChatId, null);
  } finally { await h.close(); }
});

test('agent home shows the newest conversation and active Settings returns home without re-enabling or unmuting Mia', async () => {
  const h = await mount(true, true);
  const button = (label: string) => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === label)[0]!;
  const texts = () => h.tree.findAll(node => node.type === 'Text' as any).map(node => node.props.children);
  try {
    const turn: Turn = { id: 'older-home-turn', sessionId: 'assistant', userId: 'user', generation: 1, userText: 'An older request.',
      assistantText: 'An older reply.', status: 'completed', clientTurnId: 'older-home-client' };
    h.n.turns.push(turn, { ...turn, id: 'newer-home-turn', generation: 2, userText: 'My newest request.', assistantText: 'My newest reply.', clientTurnId: 'newer-home-client' });
    await act(async () => { await h.mia.retryAssistant(); await h.mia.toggleMicrophone(); });
    assert.ok(texts().includes('My newest request.')); assert.ok(texts().includes('My newest reply.'));
    assert.equal(texts().includes('An older request.'), false);
    const modeWrites = h.n.preferences.get('mia.ai_mode');
    await act(async () => { await h.mia.navigate('settings'); });
    assert.equal(h.mia.tab, 'settings'); assert.equal(h.mia.microphoneMuted, true);
    assert.equal(h.tree.findAll(node => node.type === 'SafeAreaView' as any && node.props.pointerEvents === 'none').length, 1);
    await act(async () => { await h.mia.navigate('assistant'); });
    assert.equal(h.mia.tab, 'assistant'); assert.equal(h.mia.aiMode, true); assert.equal(h.mia.microphoneMuted, true);
    assert.equal(h.tree.findAll(node => node.type === 'Modal' as any).length, 0);
    assert.equal(h.n.preferences.get('mia.ai_mode'), modeWrites);
  } finally { await h.close(); }
});

test('Settings uses modal confirmations without changing its page layout and only signs out after approval', async () => {
  const h = await mount(false, true);
  const button = (label: string) => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === label)[0]!;
  const modal = () => h.tree.findAll(node => node.type === 'Modal' as any)[0];
  try {
    await act(async () => { button('Settings').props.onPress(); });
    const page = h.tree.findAll(node => node.type === 'ScrollView' as any)[0]!;
    const childCount = page.children.length;
    assert.equal(h.tree.findAll(node => node.type === 'Text' as any && node.props.children === 'PERMISSIONS').length, 0);
    assert.equal(button('Open iPhone settings'), undefined);
    await act(async () => { button('Mia voice mode').props.onPress(); });
    assert.ok(modal()); assert.equal(h.mia.aiMode, false);
    assert.equal(page.children.length, childCount, 'the question is outside the settings scroll content');
    await act(async () => { modal()!.props.onRequestClose(); });
    assert.equal(modal(), undefined); assert.equal(h.mia.aiMode, false);
    await act(async () => { button('Sign out').props.onPress(); });
    assert.ok(modal()); assert.equal(h.n.requests.some(request => request.path === '/v1/auth/logout'), false);
    await act(async () => { button('Keep me signed in').props.onPress(); });
    assert.equal(modal(), undefined); assert.ok(h.mia.session);
    await act(async () => { button('Sign out').props.onPress(); });
    await act(async () => { button('Sign out now').props.onPress(); });
    await h.wait(() => h.mia.session === null);
    assert.equal(h.n.requests.filter(request => request.path === '/v1/auth/logout').length, 1);
  } finally { await h.close(); }
});

test('an approved voice mode cannot be covered by its old confirmation if preference persistence fails', async () => {
  const h = await mount(false, true);
  const button = (label: string) => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === label)[0]!;
  try {
    await act(async () => { button('Settings').props.onPress(); });
    await act(async () => { button('Mia voice mode').props.onPress(); });
    h.n.failPreferences = true;
    await act(async () => { button('Enable voice mode now').props.onPress(); });
    assert.equal(h.mia.aiMode, true, 'the user explicitly approved activation');
    assert.equal(h.tree.findAll(node => node.type === 'Modal' as any).length, 0);
    assert.equal(button('Keep voice mode off'), undefined);
    assert.ok(h.mia.error);
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
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Contacts')[0]!.props.onPress(); });
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
    await act(async () => { h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Contacts')[0]!.props.onPress(); });
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
    assert.equal(h.tree.findAll(node => node.type === 'AnimatedView' as any && node.props.testID === 'chat-screen').length, 0, 'the assistant home unmounts the chat gesture');
    await act(async () => { h.n.finishAnimation!(); });
    assert.equal(h.mia.activeChatId, null); assert.equal(h.mia.tab, 'assistant'); assert.equal(h.mia.aiMode, true);
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
  const text = (node: React.ReactNode): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(text).join(' ');
    return React.isValidElement<{ children?: React.ReactNode }>(node) ? text(node.props.children) : '';
  };
  const rowText = (id: string) => {
    const data = timeline().props.data as Message[];
    const index = data.findIndex(message => message.id === id);
    return text(timeline().props.renderItem({ item: data[index], index, separators: {} }));
  };
  const day = new Date(history[0]!.createdAt).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
  try {
    h.n.history = history;
    await act(async () => { await h.mia.navigate('chats', 'anna'); });
    assert.equal(timeline().props.inverted, true);
    assert.deepEqual(timeline().props.data.map((m: Message) => m.id), ['m2', 'm1']);
    assert.deepEqual(timeline().props.contentOffset, { x: 0, y: 0 });
    assert.equal(rowText('m2').includes(day), false);
    assert.equal(rowText('m1').includes(day), true);
    await act(async () => { timeline().props.onScrollBeginDrag(); timeline().props.onScroll({ nativeEvent: { contentOffset: { y: 250 } } }); });
    await act(async () => { await h.mia.navigate('people'); });
    h.n.history = [{ ...history[0]!, id: 'm3', text: 'Arrived while away', createdAt: '2026-10-29T12:02:00Z' }, ...history,
      { ...history[1]!, id: 'm0', text: 'Older history', createdAt: '2026-10-29T11:59:00Z' }];
    await act(async () => { await h.mia.navigate('chats', 'anna'); });
    assert.deepEqual(timeline().props.contentOffset, { x: 0, y: 250 });
    assert.deepEqual(timeline().props.data.map((m: Message) => m.id), ['m2', 'm1'], 'restore the previous content before inserting unseen messages');
    assert.equal(rowText('m1').includes(day), true, 'date geometry belongs to the frozen snapshot until restoration completes');
    await act(async () => { timeline().props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } }); });
    assert.equal(h.mia.chatScrollPositions.read('user', 'anna').offset, 250, 'layout events cannot erase a saved offset');
    await act(async () => { timeline().props.onContentSizeChange(390, 2000); });
    assert.deepEqual(timeline().props.data.map((m: Message) => m.id), ['m3', 'm2', 'm1', 'm0']);
    assert.equal(rowText('m1').includes(day), false);
    assert.equal(rowText('m0').includes(day), true, 'the day heading moves to the newly loaded oldest message');
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

test('classic mode stays static and agent decoration follows Reduce Motion with shared subscription cleanup', async () => {
  const h = await mount(false, true);
  const button = (label: string) => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === label)[0]!;
  let probe: ReactTestRenderer | undefined;
  const { UiProvider, Button, Reveal } = h.components;
  // Isolate shared component behavior from the product's intentionally blocked
  // agent UI; this does not activate a hidden button under the global layer.
  const sample = (agent: boolean) => React.createElement(UiProvider, { agent }, React.createElement(Reveal, null,
    React.createElement(Button, { label: 'Motion sample', onPress() {} })));
  const sampleButton = () => probe!.root.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === 'Motion sample')[0]!;
  try {
    assert.equal(h.n.motionHandlers.size, 1);
    assert.equal(h.n.animations.length, 0, 'normal pages have no premium motion');
    await act(async () => { button('Chats').props.onPressIn(); button('Chats').props.onPressOut(); });
    assert.equal(h.n.animations.length, 0, 'normal control feedback stays simple');
    await act(async () => { button('Settings').props.onPress(); });
    await act(async () => { button('Mia voice mode').props.onPress(); });
    assert.equal(h.tree.findAll(node => node.type === 'Modal' as any)[0]!.props.animationType, 'none');
    await act(async () => { probe = create(sample(true)); });
    assert.equal(h.n.motionHandlers.size, 1, 'all consumers share one native preference subscription');
    assert.ok(h.n.animations.some(animation => animation.duration === 140 && animation.useNativeDriver));
    h.n.animations.length = 0;
    await act(async () => { sampleButton().props.onPressIn(); sampleButton().props.onPressOut(); });
    assert.deepEqual(h.n.animations.map(animation => [animation.duration, animation.useNativeDriver]), [[80, true], [120, true]]);
    await act(async () => { h.n.reducedMotion = true; for (const handler of h.n.motionHandlers) handler(true); });
    h.n.animations.length = 0;
    await act(async () => { sampleButton().props.onPressIn(); sampleButton().props.onPressOut(); probe!.update(sample(true)); });
    assert.equal(h.n.animations.length, 0, 'premium motion remains static under Reduce Motion');
    await act(async () => { h.n.reducedMotion = false; for (const handler of h.n.motionHandlers) handler(false); });
    await act(async () => { probe!.update(sample(false)); });
    h.n.animations.length = 0;
    await act(async () => { sampleButton().props.onPressIn(); sampleButton().props.onPressOut(); });
    assert.equal(h.n.animations.length, 0, 'leaving the agent appearance disables premium feedback');
  } finally { if (probe) await act(async () => { probe!.unmount(); }); await h.close(); }
  assert.equal(h.n.motionHandlers.size, 0);
});

test('appearance follows the actual mode and round-tripping preserves drafts, composition and chat position', async () => {
  const h = await mount(false, true);
  const flatten = (value: any): Record<string, any> => Array.isArray(value) ? Object.assign({}, ...value.filter(Boolean).map(flatten)) : value ?? {};
  const title = (text: string) => h.tree.findAll(node => node.type === 'Text' as any && node.props.accessibilityRole === 'header' && node.props.children === text)[0]!;
  const timeline = () => h.tree.findAll(node => node.type === 'FlatList' as any)[0]!;
  const appearance = () => h.tree.findAll(node => node.type === h.components.UiProvider)[0]!.props.agent;
  const layer = () => h.tree.findAll(node => node.props.testID === 'agent-interaction-layer' && node.type === 'Pressable' as any)[0];
  const profileAvatar = () => h.tree.findAll(node => typeof node.type === 'function' && node.type.name === 'Avatar')[0]!;
  try {
    assert.equal(appearance(), false); assert.equal(flatten(title('Chats').props.style).fontSize, 28);
    h.n.history = [{ id: 'mode-message', chatId: 'anna', senderId: 'recipient', kind: 'text', text: 'A message kept in place.', mediaId: null, createdAt: '2026-10-30T12:00:00Z' }];
    h.n.savedDrafts.push({ id: 'mode-draft', recipientId: 'recipient', recipient: chat.recipient, kind: 'text', text: 'An unsent draft.', mediaId: null,
      version: 1, state: 'editing', reviewedVersion: null, updatedAt: new Date().toISOString() });
    await act(async () => { await h.mia.refresh(); await h.mia.navigate('chats', 'anna'); });
    await act(async () => { h.mia.setComposer('Keep my typed reply'); });
    await act(async () => { timeline().props.onScrollBeginDrag(); timeline().props.onScroll({ nativeEvent: { contentOffset: { y: 210 } } }); });
    await act(async () => { await h.mia.saveAiMode(true); await h.mia.navigate('chats'); });
    assert.equal(appearance(), true); assert.ok(layer());
    assert.equal(flatten(title('Chats').props.style).fontSize, 32);
    assert.ok(h.n.animations.some(animation => animation.duration === 140));
    await act(async () => { await h.mia.navigate('settings'); });
    assert.equal(profileAvatar().props.size, 60);
    await act(async () => { await h.mia.navigate('people'); });
    assert.equal(flatten(title('Contacts').props.style).fontSize, 32);
    await act(async () => { await h.mia.navigate('chats', 'anna'); });
    assert.equal(h.mia.composers.anna, 'Keep my typed reply');
    assert.deepEqual(timeline().props.contentOffset, { x: 0, y: 210 });
    const preservedList = timeline();
    assert.equal(h.tree.findAll(node => node.type === 'TextInput' as any && node.props.accessibilityLabel === 'Message Anna').length, 0);
    const node = timeline().props.renderItem({ item: h.n.history[0], index: 0, separators: {} });
    assert.equal(flatten(node.props.children[0].props.children.props.style).backgroundColor, '#0E0C15', 'agent dates use the premium capsule');
    await act(async () => { await h.mia.saveAiMode(false); });
    assert.equal(appearance(), false); assert.equal(layer(), undefined);
    assert.equal(h.mia.activeChatId, 'anna'); assert.ok(timeline() === preservedList, 'appearance changes do not remount the visible list');
    assert.deepEqual(timeline().props.contentOffset, { x: 0, y: 210 });
    assert.equal(h.tree.findAll(node => node.type === 'TextInput' as any && node.props.accessibilityLabel === 'Message Anna')[0]!.props.value, 'Keep my typed reply');
    assert.equal(h.mia.drafts[0]?.text, 'An unsent draft.');
    const classic = timeline().props.renderItem({ item: h.n.history[0], index: 0, separators: {} });
    assert.equal(flatten(classic.props.children[0].props.children.props.style).backgroundColor, 'transparent');
    await act(async () => { await h.mia.navigate('settings'); });
    assert.equal(profileAvatar().props.size, 48); assert.equal(flatten(title('Settings').props.style).fontSize, 28);
    h.n.animations.length = 0;
    await act(async () => { await h.mia.navigate('chats'); });
    assert.equal(h.n.animations.length, 0, 'the restored normal mode stays visually quiet');
  } finally { await h.close(); }
});

test('compact screens retain readable large-text identity, expanded conversation names and a usable composer', async () => {
  const h = await mount(false, true);
  const flatten = (value: any): Record<string, any> => Array.isArray(value) ? Object.assign({}, ...value.filter(Boolean).map(flatten)) : value ?? {};
  const button = (label: string) => h.tree.findAll(node => node.type === 'Pressable' as any && node.props.accessibilityLabel === label)[0]!;
  try {
    h.n.dimensions = { width: 320, height: 568, scale: 2, fontScale: 1.8 };
    await act(async () => { button('Settings').props.onPress(); });
    const page = h.tree.findAll(node => node.type === 'ScrollView' as any)[0]!;
    assert.equal(flatten(page.props.contentContainerStyle).paddingHorizontal, 16);
    const name = h.tree.findAll(node => node.type === 'Text' as any && node.props.children === 'Me')[0]!;
    assert.equal(flatten(name.parent!.props.style).flex, 0, 'stacked identity has natural content height');
    assert.equal(flatten(name.parent!.parent!.props.style).flexDirection, 'column');
    assert.equal(name.props.numberOfLines, undefined, 'profile identity remains fully readable');
    assert.equal(name.props.allowFontScaling, undefined, 'actual identity text respects the device text size');
    const initials = h.tree.findAll(node => node.type === 'Text' as any && node.props.children === 'M')[0]!;
    assert.equal(initials.props.allowFontScaling, false, 'decorative initials fit their fixed artwork without changing real content text');
    assert.equal(button('Mia voice mode').findAll(node => node.type === 'Icon' as any && node.props.name === 'chevron-forward').length, 0, 'the stacked card has no orphan decorative arrow');
    assert.ok(h.tree.findAll(node => node.type === 'Text' as any && node.props.children === '+15550000000').length);
    await act(async () => { button('Chats').props.onPress(); });
    const rowName = h.tree.findAll(node => node.type === 'Text' as any && node.props.children === 'Anna')[0]!;
    assert.equal(rowName.props.numberOfLines, 2);
    await act(async () => { button('Anna. No messages yet').props.onPress(); });
    await h.wait(() => h.mia.activeChatId === 'anna');
    const title = h.tree.findAll(node => node.type === 'Text' as any && node.props.accessibilityRole === 'header' && node.props.children === 'Anna')[0]!;
    assert.equal(title.props.numberOfLines, 2);
    const input = h.tree.findAll(node => node.type === 'TextInput' as any && node.props.accessibilityLabel === 'Message Anna')[0]!;
    assert.equal(flatten(input.props.style).flex, 1); assert.equal(flatten(input.props.style).maxHeight, 120);
    assert.equal(input.props.maxLength, 8000); assert.equal(input.props.multiline, true);
    const timeline = h.tree.findAll(node => node.type === 'FlatList' as any)[0]!;
    const item = { id: 'large', senderId: 'user', createdAt: '2026-10-30T12:00:00Z', kind: 'text', text: 'A long message stays fully readable.' };
    const row = timeline.props.renderItem({ item, index: 0, separators: {} });
    const bubble = row.props.children[1].props.children[0];
    assert.equal(flatten(bubble.props.style).maxWidth, '94%');
    assert.equal(bubble.props.children[1].props.numberOfLines, undefined);
    assert.deepEqual(timeline.props.contentOffset, { x: 0, y: 0 }); assert.equal(timeline.props.inverted, true);
  } finally { await h.close(); }
});
