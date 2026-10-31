import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, Vibration } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Api, ApiError } from './api';
import { CancelledError, UserFacingError, VoiceCaptureUnavailable, userErrorMessage } from './errors';
import { AssistantControl } from './assistantControl';
import { NavigationContext, pageView, routeView, sameContext, viewRoute, type View } from './navigationContext';
import { preferences, sessionStorage } from './storage';
import { Realtime, type Frame } from './realtime';
import { PresentationLease, isLiveAction, mergeMessages } from './coordination';
import { DeviceActionError, deviceActionFailure, speechFailure, type DeviceActionStage } from './deviceActionFeedback';
import { ChatScrollPositions } from './chatScrollPositions';
import { Engine } from './audio/engine';
import { DuplexAudio } from './audio/duplex';
import { concatBytes } from './audio/wav';
import { pcmLevel } from './audio/level';
import { VoiceConversation, checkVoice, voiceDelay, type VoicePhase, type VoiceRuntime } from './voiceConversation';
import type { Recording } from './audio/types';
import type { AssistantSession, Capabilities, Chat, ClientContext, Contact, DeviceAction, Draft, Message, MessageReference, MessageReferenceIdentity, OriginalPlayback, OtpChallenge, PendingMessage, Profile, ServerEvent, Session, Turn, User, VoiceNote } from './types';
export type Tab = View;
const address = (process.env.EXPO_PUBLIC_API_URL ?? '').trim().replace(/\/+$/, '');
export function useMia() {
  const [booting, setBooting] = useState(true); const [session, setSession] = useState<Session | null>(null);
  const [aiMode, setAiMode] = useState(false);
  const [microphoneMuted, setMicrophoneMuted] = useState(false);
  const microphoneIntent = useRef(false);
  const microphoneTransition = useRef<Promise<void>>(Promise.resolve());
  const microphoneEpoch = useRef(0);
  const voiceControlRevision = useRef(0);
  const finishingControl = useRef<string | null>(null);
  const respondingTurn = useRef<string | null>(null);
  const appliedVoiceControl = useRef<{ turnId: string; revision: number } | null>(null);
  const [finishingControlReply, setFinishingControlReply] = useState(false);
  const voiceSessionEnabled = aiMode || finishingControlReply;
  const [voiceLevel, setVoiceLevel] = useState(0);
  const lastMeter = useRef(0);
  const voiceEnvelope = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('off');
  const [voiceFault, setVoiceFault] = useState(false);
  const [voiceRecoverable, setVoiceRecoverable] = useState(false);
  const [realtimeReady, setRealtimeReady] = useState(false);
  const recoveryBarrier = useRef<Promise<unknown>>(Promise.resolve());
  const voiceFailureMessage = useRef('');
  const [inForeground, setInForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const [manualAudio, setManualAudioState] = useState(false);
  const manualAudioRef = useRef(false);
  function setManualAudio(value: boolean) { manualAudioRef.current = value; setManualAudioState(value); }
  const [voiceRevision, setVoiceRevision] = useState(0);
  const conversation = useRef(new VoiceConversation()).current;
  const duplex = useRef(new DuplexAudio(() => audio.current!.stop())).current;
  const nativeStream = useRef<string | null>(null);
  const nativeRecognitionSessions = useRef(new Set<string>());
  const nativeCandidate = useRef<string | null>(null);
  const nativeResponse = useRef<AbortController | null>(null);
  const nativeCapture = useRef<string | null>(null);
  const nativePCM = useRef<{ parts: Uint8Array[]; bytes: number }>({ parts: [], bytes: 0 });
  const aiModeRef = useRef(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('chats');
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [chats, setChats] = useState<Chat[]>([]); const [contacts, setContacts] = useState<Contact[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]); const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [hasOlder, setHasOlder] = useState<Record<string, boolean>>({}); const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [composers, setComposers] = useState<Record<string, string>>({}); const [pending, setPending] = useState<PendingMessage[]>([]);
  const [assistantSession, setAssistantSession] = useState<AssistantSession | null>(null); const [turns, setTurns] = useState<Turn[]>([]);
  const [audioState, setAudioState] = useState<'idle' | 'recording' | 'loading' | 'playing'>('idle');
  const [messageReference, setMessageReference] = useState<MessageReference | null>(null);
  const reference = useRef<MessageReference | null>(null);
  const referenceEpoch = useRef(0);
  const referencePresentation = useRef<{ revision: number; resolve(): void; reject(reason: unknown): void } | null>(null);
  const [originalPlayback, setOriginalPlayback] = useState<OriginalPlayback | null>(null);
  const originalOperation = useRef<string | null>(null);
  const originalMediaActive = useRef(false);
  const originalAudioEpoch = useRef(0);
  const presentationQueue = useRef<Promise<void>>(Promise.resolve());
  const seenActions = useRef(new Set<string>());
  function clearReference() {
    const wasVisible = reference.current !== null;
    referenceEpoch.current++;
    referencePresentation.current?.reject(new CancelledError()); referencePresentation.current = null;
    reference.current = null; setMessageReference(null);
    if (wasVisible) publishVoiceState();
  }
  function awaitReferencePresentation(revision: number) {
    referencePresentation.current?.reject(new CancelledError());
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (referencePresentation.current?.revision === revision) referencePresentation.current = null;
        reject(new DeviceActionError('PRESENTATION_TIMEOUT', 'Card presentation was not confirmed; whether it appeared is unknown.'));
      }, 5000);
      referencePresentation.current = { revision, resolve() { clearTimeout(timer); resolve(); }, reject(reason) { clearTimeout(timer); reject(reason); } };
    });
  }
  function referenceIdentity(): MessageReferenceIdentity | undefined {
    const value = reference.current;
    const focus = value?.displayFocus ?? value?.focus;
    return value ? { chatId: value.chatId, messageId: value.messageId, revision: value.revision, ...(focus ? { focus } : {}) } : undefined;
  }
  function referencePresented(revision: number, success = true, focus?: { start: number; end: number }) {
    const pending = referencePresentation.current;
    if (!success && reference.current?.revision === revision && !pending) {
      clearReference(); setError('There is not enough space to display that message. Ask Mia to read it.'); return;
    }
    if (success && reference.current?.revision === revision && JSON.stringify(reference.current.displayFocus) !== JSON.stringify(focus)) {
      reference.current = { ...reference.current, displayFocus: focus }; setMessageReference(reference.current);
      publishVoiceState();
    }
    if (!pending || pending.revision !== revision) return;
    referencePresentation.current = null;
    if (success) {
      pending.resolve();
    } else { clearReference(); pending.reject(new DeviceActionError('PRESENTATION_NO_SPACE', 'There is not enough space to display that message. Ask Mia to read it.')); }
  }
  const [recording, setRecordingState] = useState<Recording | null>(null);
  const recordingRef = useRef<Recording | null>(null);
  function setRecording(value: Recording | null) { recordingRef.current = value; setRecordingState(value); }
  const localVoiceNote = useRef<VoiceNote | null>(null);
  const recordDestination = useRef<Profile | null>(null);
  const heldRecording = useRef<{ controller: AbortController; started: boolean } | null>(null);
  const finishingRecording = useRef<Promise<void> | null>(null);
  const recordingRevision = useRef(0);
  const recordingReview = useRef<AbortController | null>(null);
  const sendingRecording = useRef<Promise<void> | null>(null);
  const uploadedVoiceNote = useRef<{ recording: Recording; mediaId: string } | null>(null);
  const [devicePrompt, setDevicePrompt] = useState<DeviceAction | null>(null);
  const lease = useRef(new PresentationLease()).current; const audio = useRef<Engine | null>(null); if (!audio.current) audio.current = new Engine();
  const assistantControl = useRef(new AssistantControl()).current;
  const navigation = useRef(new NavigationContext()).current;
  const [chatScrollPositions] = useState(() => new ChatScrollPositions());
  function clientSnapshot(): ClientContext {
    return { ...navigation.snapshot(), ...(referenceIdentity() ? { reference: referenceIdentity() } : {}), ...(localVoiceNote.current ? { voiceNote: localVoiceNote.current } : {}), voice: { enabled: aiModeRef.current, microphoneMuted: microphoneIntent.current, revision: voiceControlRevision.current } };
  }
  function publishVoiceState() { socket.current?.send({ type: 'voice.context', context: clientSnapshot() }); }
  const requestContext = useRef<ClientContext | null>(null);
  const socket = useRef<Realtime | null>(null); const state = useRef({ session, activeChatId, tab, assistantSession, chats, devicePrompt, audioState, voicePhase });
  state.current = { session, activeChatId, tab, assistantSession, chats, devicePrompt, audioState, voicePhase };
  const foreground = useRef(inForeground); const authEpoch = useRef(0); const stopRef = useRef<() => Promise<void>>(async () => {});
  const identityRevision = useRef(0);
  const startingDeviceRecording = useRef<string | null>(null);
  const deviceTasks = useRef(new Map<string, Promise<void>>()).current;
  const nativeConnectTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fail = useCallback((reason: unknown) => { const message = userErrorMessage(reason); if (message) setError(message); }, []);
  const api = useMemo(() => new Api(address, session, () => { void clearSession(); }), [address, session]);
  async function clearSession() {
    heldRecording.current?.controller.abort(); heldRecording.current = null;
    recordingReview.current?.abort(); recordingReview.current = null;
    localVoiceNote.current = null; recordDestination.current = null; uploadedVoiceNote.current = null;
    clearReference(); seenActions.current.clear();
    chatScrollPositions.clear();
    finishingControl.current = null; setFinishingControlReply(false); appliedVoiceControl.current = null;
    void conversation.stop(); await stopNativeVoice();
    setManualAudio(false); setVoiceFault(false); setVoiceRecoverable(false); setRealtimeReady(false);
    navigation.reset(); requestContext.current = null; setTab('chats');
    authEpoch.current++; lease.revoke(); socket.current?.dispose(); await audio.current!.stop();
    await sessionStorage.write(null).catch(fail); setSession(null); setChats([]); setContacts([]); setDrafts([]); setMessages({}); setTurns([]); setPending([]); setComposers({}); setActiveChatId(null); setAssistantSession(null); setDevicePrompt(null); setAudioState('idle');
    if (recording) await audio.current!.disposeRecording(recording); setRecording(null);
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [stored, mode] = await Promise.all([sessionStorage.read(), preferences.get('mia.ai_mode')]);
        if (!active) return;
        aiModeRef.current = mode === 'true'; setAiMode(aiModeRef.current);
        if (aiModeRef.current) setView('assistant');
        setSession(stored);
      } catch (reason) { if (active) fail(reason); } finally { if (active) setBooting(false); }
    })();
    return () => { active = false; };
  }, []);
  async function checkHealth() {
    try { const health = await api.request<{ capabilities: Capabilities }>('/health/ready'); setCapabilities(health.capabilities); }
    catch (reason) { setCapabilities(null); fail(reason); }
  }
  async function retryAssistant() {
    const epoch = authEpoch.current; setBusy(true); setError('');
    try {
      await checkHealth();
      const current = await api.request<AssistantSession>('/v1/assistant/sessions', 'POST', {});
      const history = await api.request<{ turns: Turn[] }>(`/v1/assistant/sessions/${current.id}`);
      if (epoch === authEpoch.current) { setAssistantSession(current); setTurns(history.turns); }
    } catch (reason) { if (epoch === authEpoch.current) fail(reason); }
    finally { if (epoch === authEpoch.current) setBusy(false); }
  }
  async function refresh() {
    const epoch = authEpoch.current;
    const results = await Promise.all([api.request<Chat[]>('/v1/chats'), api.request<Contact[]>('/v1/contacts'), api.request<Draft[]>('/v1/drafts')]);
    if (epoch !== authEpoch.current) return;
    setChats(results[0]); setContacts(results[1]); setDrafts(results[2]);
  }
  async function loadMessages(chatId: string, before?: string) {
    const epoch = authEpoch.current;
    const list = await api.request<Message[]>(`/v1/chats/${chatId}/messages?limit=30${before ? `&before=${before}` : ''}`);
    if (epoch !== authEpoch.current) return;
    setMessages(previous => ({ ...previous, [chatId]: mergeMessages(previous[chatId] ?? [], list) }));
    setHasOlder(previous => ({ ...previous, [chatId]: list.length === 30 }));
    if (!before && foreground.current && state.current.activeChatId === chatId && state.current.tab === 'chats' && list[0]) await api.request(`/v1/chats/${chatId}/read`, 'POST', { messageId: list[0].id });
  }
  async function syncAssistant(signal?: AbortSignal) {
    const current = state.current.assistantSession; if (!current) return;
    const epoch = authEpoch.current;
    const result = await api.request<{ turns: Turn[] }>(`/v1/assistant/sessions/${current.id}`, 'GET', undefined, signal);
    if (epoch === authEpoch.current) setTurns(result.turns);
  }
  const handlers = useRef({ onEvent: async (_: ServerEvent, __: number, _replayed?: boolean) => {}, onFrame: (_: Frame) => {} });
  useEffect(() => {
    if (!session || booting) return;
    const epoch = authEpoch.current; const revision = identityRevision.current; let cancelled = false;
    void api.request<User>('/v1/me').then(async user => {
      if (cancelled || epoch !== authEpoch.current || revision !== identityRevision.current) return;
      const updated = { ...session, user };
      await sessionStorage.write(updated);
      if (!cancelled && epoch === authEpoch.current && revision === identityRevision.current) setSession(updated);
    }).catch(reason => { if (!cancelled && epoch === authEpoch.current) fail(reason); });
    return () => { cancelled = true; };
  }, [session?.token, address, booting]);
  useEffect(() => {
    if (!session || booting || !session.user.profileComplete) return;
    const epoch = authEpoch.current; let cancelled = false;
    void (async () => {
      try {
        await checkHealth(); await refresh();
        const current = await api.request<AssistantSession>('/v1/assistant/sessions', 'POST', {});
        const history = await api.request<{ turns: Turn[] }>(`/v1/assistant/sessions/${current.id}`);
        if (cancelled || epoch !== authEpoch.current) return;
        setAssistantSession(current); setTurns(history.turns);
      } catch (reason) { if (!cancelled) fail(reason); }
    })();
    setRealtimeReady(false);
    let snapshot = Promise.resolve<unknown>(undefined);
    const realtime = new Realtime(address, session, async (event, time, replayed) => {
      // Do not acknowledge replayed events until the replacement snapshot has
      // loaded. A failed snapshot can then reconnect without losing updates.
      await snapshot;
      await handlers.current.onEvent(event, time, replayed);
    }, frame => handlers.current.onFrame(frame), status => {
      if (cancelled) return;
      setRealtimeReady(status === 'Connected');
      if (status === 'Connected') {
        // Refresh one current snapshot instead of issuing REST requests for
        // every historical event replayed after a reconnect.
        snapshot = Promise.all([refresh(), syncAssistant(), state.current.activeChatId ? loadMessages(state.current.activeChatId) : Promise.resolve()]);
        void snapshot.catch(fail);
      }
    }, preferences);
    socket.current = realtime; void realtime.connect();
    return () => { cancelled = true; realtime.dispose(); lease.revoke(); void stopRef.current().catch(fail); };
  }, [session?.token, session?.user.profileComplete, address, booting]);
  const speech = useRef<{ requestId: string; turnId: string; epoch: number; parts: Uint8Array[]; bytes: number; settle(error?: unknown): void } | null>(null);
  async function stopNativeVoice() {
    nativeRecognitionSessions.current.clear();
    respondingTurn.current = null;
    setVoiceLevel(0);
    clearTimeout(nativeConnectTimeout.current); nativeConnectTimeout.current = undefined;
    nativeResponse.current?.abort(); nativeResponse.current = null;
    if (nativeStream.current) socket.current?.send({ type: 'voice.cancel' });
    nativeStream.current = null; nativeCandidate.current = null; nativeCapture.current = null;
    nativePCM.current = { parts: [], bytes: 0 };
    await duplex.stop();
  }
  function cancelNativeRecognition() {
    nativeRecognitionSessions.current.clear();
    clearTimeout(nativeConnectTimeout.current); nativeConnectTimeout.current = undefined;
    if (nativeStream.current) socket.current?.send({ type: 'voice.cancel' });
    nativeStream.current = null; nativeCapture.current = null;
    nativePCM.current = { parts: [], bytes: 0 };
  }
  function finishControlReply(turnId: string) {
    if (finishingControl.current !== turnId) return;
    finishingControl.current = null; setFinishingControlReply(false);
    if (!aiModeRef.current) setVoicePhase('off');
  }
  function idleNativePhase(): VoicePhase {
    if (!aiModeRef.current) return 'off';
    if (microphoneIntent.current) return 'paused';
    return duplex.hasInput && nativeStream.current !== null && nativeCapture.current === nativeStream.current ? 'listening' : 'waiting';
  }
  function startNativeRecognition(id: string) {
    if (originalMediaActive.current || manualAudioRef.current) return;
    // A natural rotation can overtake the previous session's committed turn.
    // Explicit cancellation clears this allowance; retain only one prior id.
    nativeRecognitionSessions.current.add(id);
    while (nativeRecognitionSessions.current.size > 2) nativeRecognitionSessions.current.delete(nativeRecognitionSessions.current.values().next().value!);
    clearTimeout(nativeConnectTimeout.current);
    nativeStream.current = id; nativeCapture.current = null;
    if (!socket.current?.send({ type: 'voice.start', requestId: id, sampleRate: 24000, format: 'pcm_s16le', inputProcessing: 'aec-residual-v1', context: clientSnapshot() })) {
      handleVoiceFailure(new ApiError(0, 'OFFLINE', '')); return;
    }
    nativeConnectTimeout.current = setTimeout(() => {
      if (nativeStream.current === id && nativeCapture.current !== id) handleVoiceFailure(new ApiError(503, 'ASR_UNAVAILABLE', ''));
    }, 15000);
  }
  async function stopAudio() {
    if (originalOperation.current) { const id = originalOperation.current; originalOperation.current = null; setOriginalPlayback(value => value?.operationId === id ? { ...value, state: 'stopped' } : value); }
    clearInterval(voiceEnvelope.current); voiceEnvelope.current = undefined; setVoiceLevel(0);
    speech.current?.settle(new CancelledError()); speech.current = null; socket.current?.send({ type: 'speech.cancel' });
    if (!nativeStream.current) socket.current?.send({ type: 'voice.cancel' });
    await duplex.stopPlayback();
    if (!duplex.ownsSession) await audio.current!.stop();
    setAudioState('idle');
  }
  stopRef.current = stopAudio;
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      foreground.current = next === 'active';
      setInForeground(next === 'active');
      if (next !== 'active') { heldRecording.current?.controller.abort(); heldRecording.current = null; recordingReview.current?.abort(); void conversation.stop(); void stopNativeVoice(); lease.revoke(); setDevicePrompt(null); void stopRef.current(); setManualAudio(false); }
    });
    return () => { heldRecording.current?.controller.abort(); recordingReview.current?.abort(); subscription.remove(); void stopRef.current().catch(fail); };
  }, []);
  async function interrupt() {
    heldRecording.current?.controller.abort(); heldRecording.current = null;
    recordingReview.current?.abort(); recordingReview.current = null;
    const stopped = Promise.all([conversation.stop(), stopNativeVoice()]);
    referencePresentation.current?.reject(new CancelledError()); referencePresentation.current = null;
    lease.revoke(); requestContext.current = null; setDevicePrompt(null);
    const current = state.current.assistantSession;
    try { await Promise.all([stopAudio(), stopped, current && state.current.session ? assistantControl.stop(api, current.id) : Promise.resolve()]); }
    finally { if (!heldRecording.current) setManualAudio(false); setVoiceRevision(value => value + 1); }
  }
  function presentView(next: Tab, chatId: string | null) {
    if (reference.current && (next !== 'chats' || chatId !== reference.current.chatId)) clearReference();
    setTab(next); setActiveChatId(chatId);
    publishVoiceState();
    state.current = { ...state.current, tab: next, activeChatId: chatId };
  }
  function setView(next: Tab, chatId: string | null = null) {
    navigation.move(viewRoute(next, chatId)); presentView(next, chatId);
  }
  async function navigate(next: Tab, chatId: string | null = null) {
    const stopped = interrupt(); setView(next, chatId);
    await stopped.catch(fail);
    if (next === 'chats' && chatId) await loadMessages(chatId).catch(fail);
  }
  async function navigateBack() {
    if (state.current.tab !== 'chats' || !state.current.activeChatId) return;
    const stopped = interrupt();
    const { view, chatId } = routeView(navigation.back().route);
    presentView(view, chatId);
    await stopped.catch(fail);
    if (chatId) await loadMessages(chatId).catch(fail);
  }
  async function acknowledge(action: DeviceAction, success: boolean, result: { message?: string; mediaId?: string; reference?: MessageReferenceIdentity | null; code?: string; stage?: DeviceActionStage; presentationConfirmed?: boolean }) {
    await api.request(`/v1/device-actions/${action.actionId}/result`, 'POST', { success, result: { ...result, context: clientSnapshot(),
      ...(['set_voice_mode', 'set_microphone_muted'].includes(action.kind) ? { voice: clientSnapshot().voice } : {}) } });
  }
  async function performAction(action: DeviceAction, epoch = lease.snapshot()) {
    let stage: DeviceActionStage = 'validation';
    let presentationConfirmed = false;
    const assertValid = () => {
      if (!lease.current(epoch)) throw new DeviceActionError('ACTION_SUPERSEDED', 'A newer request or manual navigation cancelled this device action.');
      if (!sameContext(action.context ?? null, requestContext.current)) throw new DeviceActionError('ACTION_CONTEXT_CHANGED', 'This action belongs to a different request view. It was not applied.');
      if (!foreground.current) throw new DeviceActionError('APP_NOT_ACTIVE', 'The application is not in the foreground.');
      if (!(Date.now() - Date.parse(action.createdAt) < (action.expiresIn ?? 18000))) throw new DeviceActionError('ACTION_EXPIRED', 'This device action expired before it could finish.');
    };
    const valid = () => { try { assertValid(); return true; } catch { return false; } };
    const presentSource = async (chatId: string, messageId: string, focus?: { start: number; end: number }, mediaId?: string) => {
      const operation = referenceEpoch.current;
      const [chat, source] = await Promise.all([
        api.request<Chat>(`/v1/chats/${chatId}`), api.request<Message>(`/v1/chats/${chatId}/messages/${messageId}`),
      ]);
      assertValid();
      if (operation !== referenceEpoch.current || !chat || source.id !== messageId || source.chatId !== chatId) throw new CancelledError();
      if (mediaId && (source.kind !== 'voice' || source.mediaId !== mediaId)) throw new DeviceActionError('SOURCE_CHANGED', 'This recording does not match the requested message.');
      setChats(previous => [...previous.filter(item => item.id !== chat.id), chat]);
      setView('chats', chat.id); await loadMessages(chat.id);
      assertValid();
      if (!aiModeRef.current || state.current.activeChatId !== chatId) throw new CancelledError();
      if (focus && (!Number.isInteger(focus.start) || !Number.isInteger(focus.end) || focus.start < 0 || focus.end <= focus.start || focus.end > (source.text?.length ?? 0))) throw new Error('Invalid source excerpt.');
      const revision = Number(action.sequence ?? Date.now());
      const value: MessageReference = { chatId, messageId, revision, source, recipient: chat.recipient, ...(focus ? { focus } : {}) };
      const presented = awaitReferencePresentation(revision);
      reference.current = value; setMessageReference(value); publishVoiceState();
      stage = 'presentation'; await presented; presentationConfirmed = true; assertValid();
    };
    try {
      assertValid(); stage = 'execution';
      if (action.kind === 'show_message') {
        if (!aiModeRef.current || typeof action.payload.chatId !== 'string' || typeof action.payload.messageId !== 'string') throw new CancelledError();
        const chatId = action.payload.chatId, messageId = action.payload.messageId;
        const focus = action.payload.focus as { start: number; end: number } | undefined;
        await presentSource(chatId, messageId, focus);
        if (typeof action.payload.narration === 'string' && action.payload.narration) {
          stage = 'narration';
          setVoicePhase('speaking'); await speak({ id: action.turnId, status: 'running' } as Turn, undefined, action.actionId);
        }
        assertValid(); stage = 'confirmation';
        await acknowledge(action, true, { message: 'Exact source displayed; requested narration finished.', reference: referenceIdentity(), presentationConfirmed });
      } else if (action.kind === 'announce_message_skip') {
        if (!aiModeRef.current || typeof action.payload.narration !== 'string' || !action.payload.narration) throw new CancelledError();
        stage = 'narration';
        setVoicePhase('speaking'); await speak({ id: action.turnId, status: 'running' } as Turn, undefined, action.actionId);
        assertValid(); stage = 'confirmation';
        await acknowledge(action, true, { message: 'Skip notice finished playing.', reference: referenceIdentity() ?? null });
      } else if (action.kind === 'dismiss_message') {
        const revision = Number(action.sequence ?? Date.now());
        if (reference.current) {
          stage = 'presentation';
          const presented = awaitReferencePresentation(revision);
          reference.current = null; setMessageReference(null); publishVoiceState();
          await presented;
        }
        assertValid(); stage = 'confirmation';
        await acknowledge(action, true, { message: 'Reference dismissed.', reference: null });
      } else if (action.kind === 'set_voice_mode'  || action.kind === 'set_microphone_muted') {
        const ownPrevious = appliedVoiceControl.current?.turnId === action.turnId && appliedVoiceControl.current.revision === voiceControlRevision.current;
        if (!action.context?.voice || action.context.voice.revision !== voiceControlRevision.current && !ownPrevious) throw new DeviceActionError('VOICE_STATE_CHANGED', 'Voice controls changed after that request.');
        if (action.kind === 'set_voice_mode') {
          if (typeof action.payload.enabled !== 'boolean') throw new Error('Voice mode state is missing.');
          const enabled = action.payload.enabled;
          if (enabled) throw new Error('Enable voice mode deliberately in Settings.');
          if (!enabled && respondingTurn.current === action.turnId) { finishingControl.current = action.turnId; setFinishingControlReply(true); }
          else { finishingControl.current = null; setFinishingControlReply(false); }
          microphoneEpoch.current++; voiceControlRevision.current++;
          aiModeRef.current = enabled; setAiMode(enabled); if (!enabled) clearReference();
          if (!enabled && state.current.tab === 'assistant') setView('chats');
          microphoneIntent.current = false; setMicrophoneMuted(false);
          duplex.setInputMuted(!enabled); conversation.setInputMuted(!enabled);
          if (!enabled) cancelNativeRecognition();
          await preferences.set('mia.ai_mode', String(enabled)); publishVoiceState();
          if (enabled && duplex.active && !nativeStream.current && realtimeReady) startNativeRecognition(Crypto.randomUUID());
        } else {
          if (typeof action.payload.muted !== 'boolean') throw new Error('Microphone state is missing.');
          await applyMicrophoneMute(action.payload.muted);
        }
        const appliedRevision = voiceControlRevision.current;
        await acknowledge(action, true, { message: 'Voice controls updated on this device.' });
        appliedVoiceControl.current = { turnId: action.turnId, revision: appliedRevision };
      } else if (action.kind === 'open_page') {
        const next = pageView(action.payload.route);
        if (!next) throw new Error('The requested page is unavailable.');
        // Load page data before presentation, then recheck ownership: manual
        // navigation during the request must not be overtaken by this action.
        if (next === 'chats' || next === 'people' || next === 'drafts') await refresh();
        assertValid();
        // Keep the original request context and lease so later actions from
        // this same turn can continue after the agent changes the visible page.
        setView(next);
        await acknowledge(action, true, { message: 'Page opened.' });
      } else if (action.kind === 'open_chat' && typeof action.payload.chatId === 'string') {
        const list = await api.request<Chat[]>('/v1/chats');
        assertValid();
        const chat = list.find(item => item.id === action.payload.chatId); if (!chat) throw new Error('The requested chat is unavailable.');
        if (state.current.audioState === 'playing' || state.current.audioState === 'loading') await stopAudio();
        assertValid();
        setChats(list); setView('chats', chat.id);
        // Acknowledge after history is actually loaded for the visible chat.
        await loadMessages(chat.id);
        assertValid();
        await acknowledge(action, true, { message: 'Chat opened.' });
      } else if (action.kind === 'stop_audio') {
        if (state.current.audioState === 'playing' || state.current.audioState === 'loading') await stopAudio();
        await acknowledge(action, true, { message: 'Audio stopped on this device.' });
      } else if (action.kind === 'play_audio' && typeof action.payload.mediaId === 'string') {
        const mediaId = action.payload.mediaId;
        const operationId = action.actionId;
        if (typeof action.payload.chatId !== 'string' || typeof action.payload.messageId !== 'string') throw new DeviceActionError('SOURCE_REQUIRED', 'The original recording needs its source message.');
        await presentSource(action.payload.chatId, action.payload.messageId, undefined, mediaId);
        stage = 'execution';
        const captureActive = state.current.voicePhase === 'listening' || state.current.voicePhase === 'transcribing';
        if (captureActive) { setManualAudio(true); await conversation.stop(); }
        try {
          await playMedia(mediaId, () => { if (valid()) setOriginalPlayback(previous => previous?.operationId === operationId ? { ...previous, state: 'playing' } : previous); }, valid, operationId);
          assertValid();
          if (originalOperation.current !== operationId) throw new CancelledError();
          originalOperation.current = null; setOriginalPlayback(previous => previous?.operationId === operationId ? { ...previous, state: 'finished', positionMs: previous.durationMs ?? previous.positionMs } : previous);
          await acknowledge(action, true, { message: 'Original recording finished playing on this device.' });
        } catch (reason) {
          if (originalOperation.current === operationId) { originalOperation.current = null; setOriginalPlayback(previous => previous?.operationId === operationId ? { ...previous, state: reason instanceof CancelledError ? 'stopped' : 'failed' } : previous); }
          throw reason;
        } finally { if (captureActive) setManualAudio(false); }
      } else if (action.kind === 'control_voice_note') {
        const note = localVoiceNote.current;
        if (!note || note.id !== action.payload.recordingId || note.recipientId !== action.payload.recipientId || !recordingRef.current) throw new DeviceActionError('RECORDING_CHANGED', 'That recording or recipient is no longer available.');
        if (action.payload.action === 'preview') await preview(true);
        else if (action.payload.action === 'send') await useRecording();
        else if (action.payload.action === 'discard') await discardRecording();
        else throw new Error('Unsupported recording action.');
        assertValid();
        await acknowledge(action, true, { message: action.payload.action === 'send' ? 'Original voice note sent.' : action.payload.action === 'preview' ? 'Original voice note finished playing.' : 'Recording discarded.' });
      } else if (action.kind === 'record_voice') {
        if (aiModeRef.current && typeof action.payload.chatId === 'string') {
          const chat = await api.request<Chat>(`/v1/chats/${action.payload.chatId}`); assertValid();
          setChats(previous => [...previous.filter(item => item.id !== chat.id), chat]);
          setView('chats', chat.id); await loadMessages(chat.id); assertValid();
          await acknowledge(action, true, { message: 'Recipient chat ready. Hold the lower forty percent to record and release to finish. Recording has not started and nothing was sent.' });
        } else setDevicePrompt(action);
      } else throw new Error('This device action is not supported.');
    } catch (reason) {
      await acknowledge(action, false, { ...deviceActionFailure(reason, stage), reference: referenceIdentity() ?? null,
        ...(['show_message', 'play_audio'].includes(action.kind) ? { presentationConfirmed } : {}) }).catch(fail);
    }
  }
  handlers.current.onEvent = async (event, connectedAt, replayed) => {
    if (replayed) return;
    const p = event.payload;
    if (event.type === 'message.created') {
      const message = p as unknown as Message;
      setMessages(previous => ({ ...previous, [message.chatId]: mergeMessages(previous[message.chatId] ?? [], [message]) }));
      await refresh();
      if (foreground.current && state.current.tab === 'chats' && state.current.activeChatId === message.chatId) await api.request(`/v1/chats/${message.chatId}/read`, 'POST', { messageId: message.id });
    } else if (event.type === 'chat.read' || event.type.startsWith('draft.') || event.type === 'contact.updated') await refresh();
    if (event.type === 'assistant.accepted') {
      const accepted = lease.accept(String(p.clientTurnId), String(p.turnId));
      if (!accepted && Date.parse(event.createdAt) >= connectedAt) { lease.revoke(); setDevicePrompt(null); await stopAudio(); }
    }
    if (['assistant.interrupted', 'assistant.audio_cancelled'].includes(event.type) && lease.owns(p.turnId)) { lease.revoke(); setDevicePrompt(null); await stopAudio(); }
    if (event.type.startsWith('assistant.')) {
      await syncAssistant();
      if (event.type === 'assistant.failed' && lease.owns(p.turnId)) setError('Mia could not finish that request. Your drafts are still saved.');
    }
    if (event.type === 'device.action_cancelled' && state.current.devicePrompt?.actionId === p.actionId) setDevicePrompt(null);
    if (event.type === 'device.action_requested' && isLiveAction(event, connectedAt) && foreground.current && lease.owns(p.turnId)) {
      const id = String(p.actionId);
      if (seenActions.current.has(id)) return;
      seenActions.current.add(id);
      while (seenActions.current.size > 200) seenActions.current.delete(seenActions.current.values().next().value!);
      const action = { ...p, createdAt: event.createdAt } as DeviceAction;
      const epoch = lease.snapshot();
      const immediate = ['stop_audio', 'set_microphone_muted', 'set_voice_mode'].includes(action.kind);
      const work = immediate ? performAction(action, epoch) : presentationQueue.current.catch(() => {}).then(() => performAction(action, epoch));
      if (!immediate) presentationQueue.current = work;
      const task = work.finally(() => deviceTasks.delete(id));
      deviceTasks.set(id, task);
    }
  };
  handlers.current.onFrame = frame => {
    if (nativeStream.current && frame.type === 'voice.ready' && frame.requestId === nativeStream.current) {
      const id = nativeStream.current;
      if (nativeCapture.current === id) return;
      clearTimeout(nativeConnectTimeout.current); nativeConnectTimeout.current = undefined;
      nativeCapture.current = id;
      if (duplex.active) {
        for (const part of nativePCM.current.parts) if (!socket.current?.sendAudio(part)) { handleVoiceFailure(new ApiError(0, 'OFFLINE', '')); break; }
        nativePCM.current = { parts: [], bytes: 0 };
        if (nativeStream.current === id && state.current.voicePhase === 'waiting') setVoicePhase(idleNativePhase());
        return;
      }
      void duplex.start(bytes => {
        if (!nativeStream.current || microphoneIntent.current || !aiModeRef.current || manualAudioRef.current || originalMediaActive.current) return;
        if (state.current.voicePhase !== 'speaking' && Date.now() - lastMeter.current >= 80) {
          lastMeter.current = Date.now(); setVoiceLevel(pcmLevel(bytes));
        }
        if (nativeCapture.current !== nativeStream.current) {
          nativePCM.current.parts.push(bytes); nativePCM.current.bytes += bytes.length;
          while (nativePCM.current.bytes > 72000) nativePCM.current.bytes -= nativePCM.current.parts.shift()!.length;
        } else {
          if (!socket.current?.sendAudio(bytes)) { handleVoiceFailure(new ApiError(0, 'OFFLINE', '')); return; }
          if (state.current.voicePhase === 'waiting') setVoicePhase('listening');
        }
      }, () => { if (nativeStream.current) setVoiceRevision(value => value + 1); }, reason => {
        if (nativeStream.current) handleVoiceFailure(reason);
      }).then(() => {
        if (nativeStream.current === id && !['thinking', 'speaking'].includes(state.current.voicePhase)) setVoicePhase(idleNativePhase());
      }).catch(reason => {
        if (nativeStream.current && !(reason instanceof CancelledError)) handleVoiceFailure(reason);
      });
      return;
    }
    if (nativeStream.current && frame.type === 'voice.interruption' && frame.requestId === nativeStream.current && typeof frame.clientTurnId === 'string') {
      if (microphoneIntent.current || manualAudioRef.current || originalMediaActive.current || typeof frame.inputRevision === 'number' && frame.inputRevision !== voiceControlRevision.current) return;
      nativeResponse.current?.abort(); nativeResponse.current = null;
      nativeCandidate.current = frame.clientTurnId;
      lease.begin(frame.clientTurnId); requestContext.current = clientSnapshot(); setDevicePrompt(null);
      void stopAudio().catch(fail); setVoicePhase(idleNativePhase());
      return;
    }
    if (duplex.available && (aiModeRef.current || finishingControl.current) && frame.type === 'turn.accepted') {
      const turn = frame.turn as Turn;
      if (!turn) return;
      if (turn.clientTurnId !== nativeCandidate.current) {
        // A committed command can arrive after a mute edge hid its earlier
        // interruption. Keep its reply; an uncommitted stale onset stays inert.
        if (typeof frame.requestId !== 'string' || !nativeRecognitionSessions.current.has(frame.requestId) || typeof frame.inputRevision !== 'number') return;
        lease.begin(turn.clientTurnId); setDevicePrompt(null);
        void stopAudio().catch(fail);
      }
      lease.accept(turn.clientTurnId, turn.id); requestContext.current = turn.context ?? clientSnapshot();
      nativeResponse.current?.abort(); const controller = nativeResponse.current = new AbortController();
      respondingTurn.current = turn.id;
      setVoicePhase('thinking');
      void respondToTurn(turn, controller.signal).then(() => {
        if (nativeResponse.current === controller && !controller.signal.aborted) setVoicePhase(idleNativePhase());
      }).catch(reason => { if (!controller.signal.aborted && !(reason instanceof CancelledError)) handleVoiceFailure(reason); })
        .finally(() => { if (respondingTurn.current === turn.id) respondingTurn.current = null; finishControlReply(turn.id); });
      return;
    }
    if (nativeStream.current && ['voice.failed', 'voice.closed'].includes(String(frame.type))) {
      if (frame.requestId && frame.requestId !== nativeStream.current) return;
      if (frame.type === 'voice.closed') {
        // ASR sessions expire periodically. Rotate recognition while retaining
        // the AEC/capture graph, playback and up to 1.5 seconds of input.
        if (state.current.voicePhase === 'listening') setVoicePhase('waiting');
        startNativeRecognition(Crypto.randomUUID());
      }
      else handleVoiceFailure(new ApiError(503, 'ASR_UNAVAILABLE', ''));
      return;
    }
    const current = speech.current;
    if (frame.type === 'error') {
      const error = frame.error as { code?: string };
      const reason = new ApiError(0, error?.code ?? 'REQUEST_FAILED', '');
      if (current && current.requestId === frame.requestId) current.settle(reason);
      else if (nativeStream.current) handleVoiceFailure(reason); else fail(reason);
    }
    if (!current || current.requestId !== frame.requestId || !lease.current(current.epoch)) return;
    if (frame.type === 'speech.chunk') {
      if (frame.sequence !== current.parts.length) { current.settle(new UserFacingError('Mia’s audio was interrupted. Tap Mia to try again.')); void stopAudio(); return; }
      const bytes = Uint8Array.from(atob(String(frame.audio)), c => c.charCodeAt(0));
      current.bytes += bytes.length;
      if (current.bytes > 12000000) { current.settle(new UserFacingError('Mia’s spoken response was too long. Tap Mia to try again.')); void stopAudio(); return; }
      current.parts.push(bytes);
    } else if (frame.type === 'speech.completed') {
      if (frame.chunks !== current.parts.length || frame.totalBytes !== current.bytes || !current.bytes) { current.settle(new UserFacingError('Mia’s audio was incomplete. Tap Mia to try again.')); void stopAudio(); return; }
      setAudioState('playing');
      socket.current?.send({ type: 'speech.playback', turnId: current.turnId, playing: true });
      const bytes = concatBytes(current.parts);
      const startedAt = Date.now();
      clearInterval(voiceEnvelope.current);
      const envelope = setInterval(() => setVoiceLevel(pcmLevel(bytes, (Date.now() - startedAt) * 24)), 80);
      voiceEnvelope.current = envelope;
      const playback = duplex.active ? duplex.playPcm(bytes, current.requestId) : audio.current!.playPcm(bytes);
      void playback.then(() => current.settle(), error => current.settle(error)).finally(() => {
        clearInterval(envelope);
        if (voiceEnvelope.current === envelope) { voiceEnvelope.current = undefined; setVoiceLevel(0); }
        socket.current?.send({ type: 'speech.playback', turnId: current.turnId, playing: false });
      });
    } else if (frame.type === 'speech.failed' || frame.type === 'speech.cancelled') { current.settle(frame.type === 'speech.failed' ? speechFailure(frame.code) : new CancelledError()); }
  };
  async function requestOtp(phoneNumber: string) {
    return api.request<OtpChallenge>('/v1/auth/otp/request', 'POST', { phoneNumber });
  }
  async function verifyOtp(challengeId: string, code: string) {
    const result = await api.request<Session>('/v1/auth/otp/verify', 'POST', { challengeId, code });
    await sessionStorage.write(result); setSession(result);
  }
  async function completeProfile(username: string, displayName: string) {
    if (!session) return;
    const epoch = authEpoch.current; identityRevision.current++;
    setBusy(true); setError('');
    try {
      const user = await api.request<User>('/v1/me', 'PATCH', { username, displayName });
      if (epoch !== authEpoch.current) return;
      const updated = { ...session, user }; await sessionStorage.write(updated); setSession(updated);
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  }
  async function logout() { try { await api.request('/v1/auth/logout', 'POST'); } finally { await clearSession(); } }
  async function saveAiMode(enabled: boolean) {
    const wasFinishing = Boolean(finishingControl.current);
    finishingControl.current = null; setFinishingControlReply(false);
    microphoneEpoch.current++;
    voiceControlRevision.current++;
    microphoneIntent.current = false; setMicrophoneMuted(false);
    duplex.setInputMuted(!enabled); conversation.setInputMuted(!enabled);
    aiModeRef.current = enabled; setAiMode(enabled); if (!enabled) clearReference(); setVoiceFault(false); setVoiceRecoverable(false); setError('');
    if (enabled) {
      referencePresentation.current?.reject(new CancelledError()); referencePresentation.current = null;
    lease.revoke(); requestContext.current = null; setDevicePrompt(null);
      setView('assistant');
    } else if (state.current.tab === 'assistant') setView('chats');
    if (!enabled) setVoicePhase('off');
    publishVoiceState();
    await Promise.all([preferences.set('mia.ai_mode', String(enabled)), enabled && !wasFinishing ? Promise.resolve() : interrupt()]);
  }
  async function resumeAssistant() {
    await recoveryBarrier.current;
    setVoiceFault(false); setVoiceRecoverable(false); setError('');
    await retryAssistant();
    setVoiceRevision(value => value + 1);
  }
  function toggleMicrophone() {
    return applyMicrophoneMute(!microphoneIntent.current);
  }
  function applyMicrophoneMute(muted: boolean) {
    if (!aiModeRef.current) return Promise.resolve();
    const epoch = microphoneEpoch.current;
    voiceControlRevision.current++;
    microphoneIntent.current = muted;
    duplex.setInputMuted(muted); conversation.setInputMuted(muted);
    setMicrophoneMuted(muted);
    // Only input acquisition is serialized. Current work/playback continues.
    if (muted) {
      nativePCM.current = { parts: [], bytes: 0 };
      if (!['thinking', 'speaking'].includes(state.current.voicePhase)) { setVoicePhase('paused'); setVoiceLevel(0); }
    } else if (nativeStream.current && !['thinking', 'speaking'].includes(state.current.voicePhase)) {
      setVoicePhase(idleNativePhase());
    }
    if (nativeStream.current && !socket.current?.send({ type: 'voice.mute', requestId: nativeStream.current, muted, revision: voiceControlRevision.current })) {
      handleVoiceFailure(new ApiError(0, 'OFFLINE', ''));
    }
    publishVoiceState();
    const transition = microphoneTransition.current.catch(() => {}).then(async () => {
      if (epoch !== microphoneEpoch.current) return;
      if (!muted) {
        if (nativeStream.current && !voiceFault) return;
        await recoveryBarrier.current;
        if (state.current.assistantSession) await assistantControl.beforeTurn(api, state.current.assistantSession.id);
        if (!aiModeRef.current || microphoneIntent.current || epoch !== microphoneEpoch.current) return;
        if (voiceFault) await resumeAssistant();
        if (!aiModeRef.current || microphoneIntent.current || epoch !== microphoneEpoch.current) return;
        if (duplex.available && realtimeReady && foreground.current && !nativeStream.current && !originalMediaActive.current && !manualAudioRef.current) {
          if (!['thinking', 'speaking'].includes(state.current.voicePhase)) setVoicePhase('waiting');
          startNativeRecognition(Crypto.randomUUID());
        }
      }
    });
    microphoneTransition.current = transition;
    return transition;
  }
  async function stopAssistantReply() {
    const epoch = microphoneEpoch.current;
    nativeResponse.current?.abort(); nativeResponse.current = null;
    nativeCandidate.current = null; cancelNativeRecognition();
    referencePresentation.current?.reject(new CancelledError()); referencePresentation.current = null;
    lease.revoke(); requestContext.current = null; setDevicePrompt(null);
    const current = state.current.assistantSession;
    await Promise.all([stopAudio(), conversation.stop(), current ? assistantControl.stop(api, current.id) : Promise.resolve()]);
    if (epoch !== microphoneEpoch.current || !aiModeRef.current || !foreground.current) return;
    if (duplex.available && !microphoneIntent.current) {
      if (!nativeStream.current) { setVoicePhase('waiting'); startNativeRecognition(Crypto.randomUUID()); }
      else setVoicePhase(idleNativePhase());
    } else if (duplex.available) setVoicePhase('paused');
    else setVoiceRevision(value => value + 1);
  }
  async function startChat(profile: Profile, add = false) {
    if (add) await api.request('/v1/contacts', 'POST', { userId: profile.id });
    const chat = await api.request<{ id: string }>('/v1/chats', 'POST', { recipientId: profile.id });
    await refresh(); await navigate('chats', chat.id);
  }
  async function sendPending(item: PendingMessage, throwOnError = false) {
    const epoch = authEpoch.current;
    setPending(previous => [...previous.filter(p => p.clientMessageId !== item.clientMessageId), { ...item, status: 'sending' }]);
    try {
      const message = await api.request<Message>(`/v1/chats/${item.chatId}/messages`, 'POST', { clientMessageId: item.clientMessageId, content: item.content });
      if (epoch !== authEpoch.current) return;
      setPending(previous => previous.filter(p => p.clientMessageId !== item.clientMessageId));
      setMessages(previous => ({ ...previous, [item.chatId]: mergeMessages(previous[item.chatId] ?? [], [message]) })); await refresh();
    } catch (reason) { if (epoch !== authEpoch.current) return; setPending(previous => previous.map(p => p.clientMessageId === item.clientMessageId ? { ...p, status: 'failed' } : p)); fail(reason); if (throwOnError) throw reason; }
  }
  async function sendText() {
    const chatId = activeChatId; const text = chatId ? composers[chatId]?.trim() : ''; if (!chatId || !text) return;
    setComposers(previous => ({ ...previous, [chatId]: '' }));
    await sendPending({ chatId, content: { kind: 'text', text }, clientMessageId: Crypto.randomUUID(), status: 'sending' });
  }
  async function draftAction(draft: Draft, action: 'review' | 'confirm' | 'discard' | 'edit', text?: string) {
    await api.request(`/v1/drafts/${draft.id}${action === 'review' || action === 'confirm' ? `/${action}` : ''}`, action === 'discard' ? 'DELETE' : action === 'edit' ? 'PATCH' : 'POST', { version: draft.version, ...(action === 'edit' ? { content: { kind: 'text', text } } : {}) });
    await refresh();
  }
  async function submitAssistant(text: string, signal: AbortSignal) {
    if (!assistantSession || !text.trim()) return;
    checkVoice(signal);
    const item = { text, clientTurnId: Crypto.randomUUID(), context: clientSnapshot() };
    lease.begin(item.clientTurnId); setDevicePrompt(null);
    requestContext.current = item.context;
    const epoch = lease.snapshot();
    await assistantControl.beforeTurn(api, assistantSession.id);
    checkVoice(signal);
    if (!lease.current(epoch)) return;
    await stopAudio();
    checkVoice(signal);
    if (!lease.current(epoch)) return;
    const response = await api.request<{ turn: Turn }>(`/v1/assistant/sessions/${assistantSession.id}/turns`, 'POST', item, signal);
    checkVoice(signal);
    if (lease.current(epoch)) lease.accept(item.clientTurnId, response.turn.id);
    await syncAssistant(signal);
    return response.turn;
  }
  async function speak(turn: Turn, signal?: AbortSignal, actionId?: string) {
    const epoch = lease.snapshot();
    await stopAudio();
    if (signal) checkVoice(signal);
    if (!lease.current(epoch) || !foreground.current || (!actionId && turn.status !== 'completed')) return;
    const requestId = Crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { void stopAudio(); };
      const timer = setTimeout(() => {
        current.settle(new UserFacingError('Mia’s audio did not finish. Tap Mia to try again.'));
        void stopAudio();
      }, 145000);
      const current = { requestId, turnId: turn.id, epoch, parts: [] as Uint8Array[], bytes: 0,
        settle(reason?: unknown) {
          clearTimeout(timer); signal?.removeEventListener('abort', cancel);
          if (speech.current === current) { speech.current = null; setAudioState('idle'); }
          if (reason) reject(reason); else resolve();
        },
      };
      speech.current = current;
      signal?.addEventListener('abort', cancel, { once: true });
      if (!socket.current?.send({ type: 'speech.request', requestId, turnId: turn.id, ...(actionId ? { actionId } : {}) })) current.settle(new ApiError(0, 'OFFLINE', ''));
      else setAudioState('loading');
    });
  }
  async function playMedia(mediaId: string, onStarted?: () => void, allowed = () => true, operationId?: string) {
    const operation = ++originalAudioEpoch.current;
    originalMediaActive.current = true;
    duplex.setInputMuted(true); conversation.setInputMuted(true);
    try {
      if (!onStarted) { setManualAudio(true); await Promise.all([conversation.stop(), stopNativeVoice()]); }
      else if (duplex.available) { cancelNativeRecognition(); await duplex.stop(); }
      await stopAudio(); if (!allowed() || !foreground.current) throw new CancelledError();
      if (operationId) { originalOperation.current = operationId; setOriginalPlayback({ mediaId, operationId, state: 'preparing', positionMs: 0 }); }
      setAudioState('playing');
      await audio.current!.play(`${address}/v1/media/${mediaId}`, { Authorization: `Bearer ${session!.token}` }, onStarted, progress => {
        if (!operationId || originalOperation.current !== operationId || !allowed()) return;
        setOriginalPlayback(previous => previous?.operationId === operationId ? { ...previous,
          positionMs: progress.positionMs, durationMs: progress.durationMs ?? previous.durationMs,
          state: progress.buffering ? 'buffering' : progress.playing ? 'playing' : previous.state } : previous);
      });
    }
    finally {
      if (originalAudioEpoch.current === operation) {
        originalMediaActive.current = false;
        duplex.setInputMuted(microphoneIntent.current); conversation.setInputMuted(microphoneIntent.current);
        setAudioState('idle');
        if (!onStarted) { setManualAudio(false); setVoiceRevision(value => value + 1); }
        else if (duplex.available && foreground.current && aiModeRef.current && !microphoneIntent.current && !nativeStream.current) startNativeRecognition(Crypto.randomUUID());
      }
    }
  }
  async function startRecording(signal?: AbortSignal) {
    if (recordingRef.current) throw new UserFacingError('Send or discard your current voice note before recording another.');
    if (signal) checkVoice(signal);
    const chatId = state.current.activeChatId;
    const recipient = state.current.chats.find(chat => chat.id === chatId)?.recipient ?? null;
    setManualAudio(true); await Promise.all([conversation.stop(), stopNativeVoice()]);
    const epoch = lease.snapshot();
    try {
      if (signal) checkVoice(signal);
      await stopAudio();
      if (await AccessibilityInfo.isScreenReaderEnabled()) await new Promise(resolve => setTimeout(resolve, 350));
      if (signal) checkVoice(signal);
      if (!lease.current(epoch) || !foreground.current) throw new CancelledError();
      await audio.current!.start(signal);
      if (!lease.current(epoch) || !foreground.current) { await stopAudio(); throw new CancelledError(); }
      if (signal) checkVoice(signal);
      recordDestination.current = recipient;
      setRecording(null); setAudioState('recording');
    } catch (error) { if (!signal || !heldRecording.current || heldRecording.current.controller.signal === signal) setManualAudio(false); throw error; }
  }
  async function beginHeldRecording() {
    if (heldRecording.current || sendingRecording.current || !aiModeRef.current || !foreground.current || state.current.tab !== 'chats' || !state.current.activeChatId) return;
    const previousFinish = finishingRecording.current;
    recordingRevision.current++;
    const chatId = state.current.activeChatId;
    const stopped = interrupt();
    const held = { controller: new AbortController(), started: false };
    heldRecording.current = held;
    setManualAudio(true);
    try {
      await stopped;
      await previousFinish?.catch(() => {});
      checkVoice(held.controller.signal);
      if (!aiModeRef.current || state.current.tab !== 'chats' || state.current.activeChatId !== chatId) throw new CancelledError();
      if (recordingRef.current) {
        const previousId = localVoiceNote.current?.id;
        await audio.current!.disposeRecording(recordingRef.current);
        setRecording(null); localVoiceNote.current = null; uploadedVoiceNote.current = null;
        if (previousId) setPending(items => items.filter(item => item.clientMessageId !== previousId));
        publishVoiceState();
      }
      checkVoice(held.controller.signal);
      await startRecording(held.controller.signal);
      checkVoice(held.controller.signal);
      held.started = true; Vibration.vibrate(35);
    } catch (reason) {
      if (heldRecording.current === held) heldRecording.current = null;
      if (!heldRecording.current) setManualAudio(false);
      if (!(reason instanceof CancelledError)) throw reason;
    }
  }
  async function endHeldRecording(cancel = false) {
    const held = heldRecording.current;
    if (!held) return;
    if (!held.started || cancel) {
      held.controller.abort(); heldRecording.current = null;
      await stopAudio(); if (!heldRecording.current) setManualAudio(false);
      return;
    }
    await finishRecording();
  }
  function finishRecording(): Promise<void> {
    if (finishingRecording.current) return finishingRecording.current;
    const held = heldRecording.current;
    const revision = recordingRevision.current;
    heldRecording.current = null;
    const task = (async () => {
      try {
        const result = await audio.current!.finish(); setRecording(result);
        if (recordDestination.current) localVoiceNote.current = { id: Crypto.randomUUID(), recipientId: recordDestination.current.id, durationMs: result.durationMs };
        setAudioState('idle'); publishVoiceState();
        if (held && revision === recordingRevision.current && aiModeRef.current && foreground.current && localVoiceNote.current && state.current.assistantSession) {
          Vibration.vibrate(35);
          const controller = recordingReview.current = new AbortController();
          try {
            const turn = await submitAssistant('I finished recording my voice note for its recipient. Ask me whether to send it; keep it unsent until I answer.', controller.signal);
            if (turn) await respondToTurn(turn, controller.signal);
          } catch (reason) { if (!controller.signal.aborted && !(reason instanceof CancelledError)) fail(reason); }
          finally { if (recordingReview.current === controller) recordingReview.current = null; }
        }
      } finally { setAudioState('idle'); if (!heldRecording.current) setManualAudio(false); }
    })();
    finishingRecording.current = task;
    void task.finally(() => { if (finishingRecording.current === task) finishingRecording.current = null; }).catch(() => {});
    return task;
  }
  async function uploadRecording(value: Recording, signal?: AbortSignal) {
    const data = new FormData();
    data.append('file', { uri: value.uri, name: 'voice.wav', type: 'audio/wav' } as unknown as Blob);
    return api.request<{ id: string }>('/v1/media', 'POST', data, signal);
  }
  function useRecording(): Promise<void> {
    if (sendingRecording.current) return sendingRecording.current;
    const value = recordingRef.current, note = localVoiceNote.current;
    const recipientId = note?.recipientId ?? recordDestination.current?.id;
    if (!value || !recipientId) return Promise.resolve();
    const userEpoch = authEpoch.current;
    setBusy(true);
    const task = (async () => {
      try {
        const destination = await api.request<{ id: string }>('/v1/chats', 'POST', { recipientId });
        if (userEpoch !== authEpoch.current || recordingRef.current !== value) throw new CancelledError();
        const media = uploadedVoiceNote.current?.recording === value ? { id: uploadedVoiceNote.current.mediaId } : await uploadRecording(value);
        uploadedVoiceNote.current = { recording: value, mediaId: media.id };
        if (userEpoch !== authEpoch.current || recordingRef.current !== value) throw new CancelledError();
        await sendPending({ chatId: destination.id, content: { kind: 'voice', mediaId: media.id }, clientMessageId: note?.id ?? Crypto.randomUUID(), status: 'sending' }, true);
        await audio.current!.disposeRecording(value); setRecording(null); localVoiceNote.current = null; uploadedVoiceNote.current = null; publishVoiceState();
      } finally { setBusy(false); }
    })();
    sendingRecording.current = task;
    void task.finally(() => { if (sendingRecording.current === task) sendingRecording.current = null; }).catch(() => {});
    return task;
  }
  async function discardRecording() {
    if (sendingRecording.current) throw new UserFacingError('Wait for your voice note to finish sending.');
    await stopAudio(); if (recordingRef.current) await audio.current!.disposeRecording(recordingRef.current);
    setRecording(null); localVoiceNote.current = null; uploadedVoiceNote.current = null; publishVoiceState(); setManualAudio(false);
  }
  async function preview(fromAgent = false) {
    const value = recordingRef.current; if (!value) return;
    const operation = ++originalAudioEpoch.current;
    originalMediaActive.current = true;
    duplex.setInputMuted(true); conversation.setInputMuted(true);
    try {
      if (!fromAgent) { setManualAudio(true); await Promise.all([conversation.stop(), stopNativeVoice()]); }
      else if (duplex.available) { cancelNativeRecognition(); await duplex.stop(); }
      await stopAudio(); if (!foreground.current) throw new CancelledError();
      setAudioState('playing'); await audio.current!.play(value.uri);
    } finally {
      if (originalAudioEpoch.current === operation) {
        originalMediaActive.current = false;
        duplex.setInputMuted(microphoneIntent.current); conversation.setInputMuted(microphoneIntent.current);
        setAudioState('idle');
        if (!fromAgent) { setManualAudio(false); setVoiceRevision(value => value + 1); }
        else if (duplex.available && foreground.current && aiModeRef.current && !microphoneIntent.current && !nativeStream.current) startNativeRecognition(Crypto.randomUUID());
      }
    }
  }
  async function declineDevice() { const action = devicePrompt; setDevicePrompt(null); if (action && startingDeviceRecording.current === action.actionId) { startingDeviceRecording.current = null; await stopAudio(); setManualAudio(false); } if (action) await acknowledge(action, false, { message: 'The user declined this recording request.' }); }
  async function acceptDeviceRecording() {
    const action = devicePrompt; if (!action || !lease.owns(action.turnId) || !sameContext(action.context ?? null, requestContext.current) || startingDeviceRecording.current) return;
    startingDeviceRecording.current = action.actionId;
    const epoch = lease.snapshot();
    const valid = () => lease.current(epoch) && startingDeviceRecording.current === action.actionId && Date.now() - Date.parse(action.createdAt) < 18000;
    try {
      const recipientId = action.payload.recipientId;
      if (typeof recipientId !== 'string') throw new Error('The recording recipient is missing.');
      const chat = await api.request<{ id: string }>('/v1/chats', 'POST', { recipientId });
      const destination = await api.request<Chat>(`/v1/chats/${chat.id}`);
      if (!valid()) throw new Error('This recording request has expired.');
      await refresh();
      await startRecording();
      if (!valid()) { await stopAudio(); throw new CancelledError(); }
      recordDestination.current = destination.recipient; setView('chats', chat.id); setDevicePrompt(null);
      await acknowledge(action, true, { message: 'Recording started after the user chose Record. The recording is not yet uploaded or sent.' });
    } catch (reason) { setDevicePrompt(null); setManualAudio(false); await acknowledge(action, false, { message: userErrorMessage(reason) ?? 'Recording was cancelled.' }).catch(fail); fail(reason); }
    finally { if (startingDeviceRecording.current === action.actionId) startingDeviceRecording.current = null; }
  }
  useEffect(() => {
    if (!devicePrompt) return;
    const timer = setTimeout(() => { setDevicePrompt(null); if (startingDeviceRecording.current === devicePrompt.actionId) { startingDeviceRecording.current = null; void stopRef.current(); setManualAudio(false); } }, Math.max(0, 18000 - (Date.now() - Date.parse(devicePrompt.createdAt))));
    return () => clearTimeout(timer);
  }, [devicePrompt]);
  async function respondToTurn(accepted: Turn, signal: AbortSignal) {
    const deadline = Date.now() + 660000;
    let turn = accepted;
    while (turn.status === 'queued' || turn.status === 'running') {
      await voiceDelay(1000, signal);
      if (!lease.owns(turn.id)) throw new CancelledError();
      if (Date.now() > deadline) throw new UserFacingError('Mia is taking longer than usual. Tap Mia to try again.');
      turn = await api.request<Turn>(`/v1/assistant/sessions/${turn.sessionId}/turns/${turn.id}`, 'GET', undefined, signal);
      checkVoice(signal);
    }
    if (!lease.owns(turn.id) || turn.status === 'interrupted') throw new CancelledError();
    if (turn.status === 'failed') throw new UserFacingError('Mia could not finish that request. Tap Mia to try again.');
    while (deviceTasks.size) await voiceDelay(100, signal);
    checkVoice(signal);
    if (!lease.owns(turn.id)) throw new CancelledError();
    setTurns(previous => [...previous.filter(item => item.id !== turn.id), turn]);
    setVoicePhase('speaking'); await speak(turn, signal);
  }
  function handleVoiceFailure(reason: unknown) {
    const recoverable = reason instanceof VoiceCaptureUnavailable || reason instanceof ApiError && (reason.status === 0 || reason.status === 429 || reason.status >= 500);
    voiceFailureMessage.current = userErrorMessage(reason) ?? '';
    setVoiceFault(true); setVoiceRecoverable(recoverable); setVoicePhase(recoverable ? 'waiting' : 'error'); fail(reason);
    recoveryBarrier.current = interrupt().catch(reason => {
      voiceFailureMessage.current = userErrorMessage(reason) ?? ''; fail(reason);
    });
  }
  const voiceRuntime = useRef<VoiceRuntime>(null!);
  voiceRuntime.current = {
    ready: () => deviceTasks.size === 0 && !manualAudioRef.current && !originalMediaActive.current,
    phase: setVoicePhase,
    capture: signal => audio.current!.captureCommand(signal, level => {
      if (Date.now() - lastMeter.current >= 80) { lastMeter.current = Date.now(); setVoiceLevel(level); }
    }),
    async transcribe(value, signal) {
      const media = await uploadRecording(value, signal);
      checkVoice(signal);
      const result = await api.request<{ text: string }>('/v1/speech/transcriptions', 'POST', { mediaId: media.id }, signal);
      checkVoice(signal);
      return result.text;
    },
    discard: value => audio.current!.disposeRecording(value),
    async respond(text, signal) {
      const accepted = await submitAssistant(text, signal);
      checkVoice(signal);
      if (!accepted) throw new CancelledError();
      respondingTurn.current = accepted.id;
      try { await respondToTurn(accepted, signal); }
      finally { if (respondingTurn.current === accepted.id) respondingTurn.current = null; finishControlReply(accepted.id); }
    },
  };
  useEffect(() => {
    const configured = capabilities?.agent && capabilities.speechRecognition && capabilities.speechSynthesis;
    if (!aiMode || microphoneMuted || !session?.user.profileComplete || !inForeground || manualAudio || (voiceFault && !voiceRecoverable)) return;
    if (configured && assistantSession && !voiceRecoverable) return;
    const controller = new AbortController(); const { signal } = controller;
    const epoch = authEpoch.current;
    void (async () => {
      let delay = 2000;
      while (!signal.aborted) {
        try {
          await voiceDelay(delay, signal);
          await recoveryBarrier.current;
          checkVoice(signal);
          const health = await api.request<{ capabilities: Capabilities }>('/health/ready', 'GET', undefined, signal);
          if (!health.capabilities.agent || !health.capabilities.speechRecognition || !health.capabilities.speechSynthesis) {
            delay = Math.min(delay * 2, 15000); continue;
          }
          const current = await api.request<AssistantSession>('/v1/assistant/sessions', 'POST', {}, signal);
          if (voiceRecoverable) await assistantControl.stop(api, current.id);
          checkVoice(signal);
          const history = await api.request<{ turns: Turn[] }>(`/v1/assistant/sessions/${current.id}`, 'GET', undefined, signal);
          checkVoice(signal);
          if (epoch !== authEpoch.current) return;
          setCapabilities(health.capabilities); setAssistantSession(current); setTurns(history.turns);
          setVoiceFault(false); setVoiceRecoverable(false);
          setError(previous => previous === voiceFailureMessage.current ? '' : previous);
          return;
        } catch {
          if (signal.aborted || epoch !== authEpoch.current) return;
          delay = Math.min(delay * 2, 15000);
        }
      }
    })();
    return () => controller.abort();
  }, [aiMode, microphoneMuted, session?.token, session?.user.profileComplete, inForeground, manualAudio, voiceFault, voiceRecoverable, capabilities?.agent, capabilities?.speechRecognition, capabilities?.speechSynthesis, assistantSession?.id]);
  useEffect(() => {
    if (!voiceSessionEnabled || !session?.user.profileComplete) { setVoicePhase('off'); return; }
    if (!inForeground || manualAudio) { setVoicePhase('paused'); return; }
    if (voiceFault) { setVoicePhase(voiceRecoverable ? 'waiting' : 'error'); return; }
    if (!assistantSession || !realtimeReady || capabilities?.agent !== true || !capabilities.speechRecognition || !capabilities.speechSynthesis) {
      setVoicePhase('waiting'); return;
    }
    let cancelled = false;
    if (duplex.available) {
      if (originalMediaActive.current) return;
      if (!aiModeRef.current) return () => { void stopNativeVoice(); };
      const id = Crypto.randomUUID(); nativeStream.current = id; nativeCandidate.current = null;
      setVoicePhase('waiting');
      void assistantControl.beforeTurn(api, assistantSession.id).then(() => {
        if (cancelled || nativeStream.current !== id) return;
        startNativeRecognition(id);
      });
      return () => { cancelled = true; void stopNativeVoice(); };
    }
    void conversation.start({
      ready: () => voiceRuntime.current.ready(),
      phase: phase => { if (!cancelled) setVoicePhase(phase); },
      capture: signal => voiceRuntime.current.capture(signal),
      transcribe: (value, signal) => voiceRuntime.current.transcribe(value, signal),
      discard: value => voiceRuntime.current.discard(value),
      respond: (text, signal) => voiceRuntime.current.respond(text, signal),
    }).catch(reason => {
      if (cancelled || conversation.stopped) return;
      if (reason instanceof CancelledError) { setVoiceRevision(value => value + 1); return; }
      handleVoiceFailure(reason);
    });
    return () => { cancelled = true; void conversation.stop(); };
  }, [voiceSessionEnabled, session?.token, session?.user.profileComplete, assistantSession?.id, capabilities?.agent, capabilities?.speechRecognition, capabilities?.speechSynthesis, inForeground, manualAudio, voiceRevision, voiceFault, voiceRecoverable, realtimeReady]);
  return { messageReference, originalPlayback, referencePresented, referenceDismissalRevision: referencePresentation.current?.revision, booting, session, aiMode, microphoneMuted, toggleMicrophone, stopAssistantReply, voiceLevel, voicePhase, voiceFault, error, setError, busy, tab, capabilities, chats, contacts, drafts, messages, chatScrollPositions, hasOlder, activeChatId, composers, pending, turns, assistantSession, audioState, recording, devicePrompt, api, fail, requestOtp, verifyOtp, completeProfile, logout, saveAiMode, resumeAssistant, retryAssistant, refresh, loadMessages, navigate, navigateBack, startChat, sendText, sendPending, draftAction, interrupt, playMedia, startRecording, beginHeldRecording, endHeldRecording, finishRecording, useRecording, discardRecording, preview, stopAudio, declineDevice, acceptDeviceRecording,
    setComposer: (text: string) => { if (activeChatId) setComposers(previous => ({ ...previous, [activeChatId]: text })); },
  };
}
export type Mia = ReturnType<typeof useMia>;
