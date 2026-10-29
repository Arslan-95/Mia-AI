import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Api, ApiError } from './api';
import { CancelledError, UserFacingError, VoiceCaptureUnavailable, userErrorMessage } from './errors';
import { AssistantControl } from './assistantControl';
import { NavigationContext, routeView, sameContext, viewRoute } from './navigationContext';
import { preferences, sessionStorage } from './storage';
import { Realtime, type Frame } from './realtime';
import { PresentationLease, isLiveAction, mergeMessages } from './coordination';
import { ChatScrollPositions } from './chatScrollPositions';
import { Engine } from './audio/engine';
import { DuplexAudio } from './audio/duplex';
import { concatBytes } from './audio/wav';
import { pcmLevel } from './audio/level';
import { VoiceConversation, checkVoice, voiceDelay, type VoicePhase, type VoiceRuntime } from './voiceConversation';
import type { Recording } from './audio/types';
import type { AssistantSession, Capabilities, Chat, ClientContext, Contact, DeviceAction, Draft, Message, OtpChallenge, PendingMessage, Profile, ServerEvent, Session, Turn, User } from './types';
export type Tab = 'chats' | 'people' | 'settings' | 'drafts';
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
  const [manualAudio, setManualAudio] = useState(false);
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
  const [recording, setRecording] = useState<Recording | null>(null);
  const [recordChatId, setRecordChatId] = useState<string | null>(null); const [devicePrompt, setDevicePrompt] = useState<DeviceAction | null>(null);
  const lease = useRef(new PresentationLease()).current; const audio = useRef<Engine | null>(null); if (!audio.current) audio.current = new Engine();
  const assistantControl = useRef(new AssistantControl()).current;
  const navigation = useRef(new NavigationContext()).current;
  const [chatScrollPositions] = useState(() => new ChatScrollPositions());
  function clientSnapshot(): ClientContext {
    return { ...navigation.snapshot(), voice: { enabled: aiModeRef.current, microphoneMuted: microphoneIntent.current, revision: voiceControlRevision.current } };
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
        aiModeRef.current = mode === 'true'; setAiMode(aiModeRef.current); setSession(stored);
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
      if (next !== 'active') { void conversation.stop(); void stopNativeVoice(); lease.revoke(); setDevicePrompt(null); void stopRef.current(); }
    });
    return () => { subscription.remove(); void stopRef.current().catch(fail); };
  }, []);
  async function interrupt() {
    const stopped = Promise.all([conversation.stop(), stopNativeVoice()]);
    lease.revoke(); requestContext.current = null; setDevicePrompt(null);
    const current = state.current.assistantSession;
    try { await Promise.all([stopAudio(), stopped, current && state.current.session ? assistantControl.stop(api, current.id) : Promise.resolve()]); }
    finally { if (!recording) setManualAudio(false); setVoiceRevision(value => value + 1); }
  }
  function presentView(next: Tab, chatId: string | null) {
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
  async function acknowledge(action: DeviceAction, success: boolean, result: { message?: string; mediaId?: string }) {
    await api.request(`/v1/device-actions/${action.actionId}/result`, 'POST', { success, result: { ...result, context: clientSnapshot(),
      ...(['set_voice_mode', 'set_microphone_muted'].includes(action.kind) ? { voice: clientSnapshot().voice } : {}) } });
  }
  async function performAction(action: DeviceAction) {
    const epoch = lease.snapshot();
    const valid = () => lease.current(epoch) && sameContext(action.context ?? null, requestContext.current)
      && foreground.current && Date.now() - Date.parse(action.createdAt) < 18000;
    try {
      if (!valid()) throw new Error('This device request belongs to a previous view.');
      if (action.kind === 'set_voice_mode' || action.kind === 'set_microphone_muted') {
        const ownPrevious = appliedVoiceControl.current?.turnId === action.turnId && appliedVoiceControl.current.revision === voiceControlRevision.current;
        if (!action.context?.voice || action.context.voice.revision !== voiceControlRevision.current && !ownPrevious) throw new Error('Voice controls changed after that request.');
        if (action.kind === 'set_voice_mode') {
          if (typeof action.payload.enabled !== 'boolean') throw new Error('Voice mode state is missing.');
          const enabled = action.payload.enabled;
          if (enabled) throw new Error('Enable voice mode deliberately in Settings.');
          if (!enabled && respondingTurn.current === action.turnId) { finishingControl.current = action.turnId; setFinishingControlReply(true); }
          else { finishingControl.current = null; setFinishingControlReply(false); }
          microphoneEpoch.current++; voiceControlRevision.current++;
          aiModeRef.current = enabled; setAiMode(enabled);
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
      } else if (action.kind === 'open_chat' && typeof action.payload.chatId === 'string') {
        const list = await api.request<Chat[]>('/v1/chats');
        if (!valid()) throw new Error('This device request is no longer current.');
        const chat = list.find(item => item.id === action.payload.chatId); if (!chat) throw new Error('The requested chat is unavailable.');
        if (state.current.audioState === 'playing' || state.current.audioState === 'loading') await stopAudio();
        if (!valid()) throw new Error('This device request is no longer current.');
        setChats(list); setView('chats', chat.id);
        // Acknowledge after history is actually loaded for the visible chat.
        await loadMessages(chat.id);
        if (!lease.current(epoch)) throw new Error('A newer conversation is active.');
        await acknowledge(action, true, { message: 'Chat opened.' });
      } else if (action.kind === 'stop_audio') {
        if (state.current.audioState === 'playing' || state.current.audioState === 'loading') await stopAudio();
        await acknowledge(action, true, { message: 'Audio stopped on this device.' });
      } else if (action.kind === 'play_audio' && typeof action.payload.mediaId === 'string') {
        let acknowledged = false;
        const captureActive = state.current.voicePhase === 'listening' || state.current.voicePhase === 'transcribing';
        if (captureActive) { setManualAudio(true); await conversation.stop(); }
        try { await playMedia(action.payload.mediaId, () => {
          if (valid()) {
            acknowledged = true;
            void acknowledge(action, true, { message: 'Playback started on this device.' }).catch(fail);
          }
        }, valid); } finally { if (captureActive) setManualAudio(false); }
        if (!acknowledged) throw new Error('Playback did not start.');
      } else if (action.kind === 'record_voice') {
        setDevicePrompt(action);
      } else throw new Error('This device action is not supported.');
    } catch (reason) { await acknowledge(action, false, { message: userErrorMessage(reason) ?? 'The action was cancelled.' }).catch(fail); }
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
      const task = performAction({ ...p, createdAt: event.createdAt } as DeviceAction).finally(() => deviceTasks.delete(id));
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
        if (!nativeStream.current || microphoneIntent.current || !aiModeRef.current) return;
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
      if (microphoneIntent.current || typeof frame.inputRevision === 'number' && frame.inputRevision !== voiceControlRevision.current) return;
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
    } else if (frame.type === 'speech.failed' || frame.type === 'speech.cancelled') { current.settle(frame.type === 'speech.failed' ? new ApiError(503, 'TTS_UNAVAILABLE', '') : new CancelledError()); }
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
    aiModeRef.current = enabled; setAiMode(enabled); setVoiceFault(false); setVoiceRecoverable(false); setError('');
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
        if (duplex.available && realtimeReady && foreground.current && !nativeStream.current) {
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
  async function sendPending(item: PendingMessage) {
    const epoch = authEpoch.current;
    setPending(previous => [...previous.filter(p => p.clientMessageId !== item.clientMessageId), { ...item, status: 'sending' }]);
    try {
      const message = await api.request<Message>(`/v1/chats/${item.chatId}/messages`, 'POST', { clientMessageId: item.clientMessageId, content: item.content });
      if (epoch !== authEpoch.current) return;
      setPending(previous => previous.filter(p => p.clientMessageId !== item.clientMessageId));
      setMessages(previous => ({ ...previous, [item.chatId]: mergeMessages(previous[item.chatId] ?? [], [message]) })); await refresh();
    } catch (reason) { if (epoch !== authEpoch.current) return; setPending(previous => previous.map(p => p.clientMessageId === item.clientMessageId ? { ...p, status: 'failed' } : p)); fail(reason); }
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
  async function speak(turn: Turn, signal?: AbortSignal) {
    const epoch = lease.snapshot();
    await stopAudio();
    if (signal) checkVoice(signal);
    if (!lease.current(epoch) || !foreground.current || turn.status !== 'completed') return;
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
      if (!socket.current?.send({ type: 'speech.request', requestId, turnId: turn.id })) current.settle(new ApiError(0, 'OFFLINE', ''));
      else setAudioState('loading');
    });
  }
  async function playMedia(mediaId: string, onStarted?: () => void, allowed = () => true) {
    const pauseNative = duplex.ownsSession;
    if (!onStarted || pauseNative) { setManualAudio(true); await Promise.all([conversation.stop(), stopNativeVoice()]); }
    try {
      await stopAudio(); if (!allowed() || !foreground.current) throw new CancelledError(); setAudioState('playing');
      await audio.current!.play(`${address}/v1/media/${mediaId}`, { Authorization: `Bearer ${session!.token}` }, onStarted);
    }
    finally { setAudioState('idle'); if (!onStarted || pauseNative) setManualAudio(false); }
  }
  async function startRecording() {
    setManualAudio(true); await Promise.all([conversation.stop(), stopNativeVoice()]);
    const epoch = lease.snapshot();
    try {
      await stopAudio();
      if (await AccessibilityInfo.isScreenReaderEnabled()) await new Promise(resolve => setTimeout(resolve, 350));
      if (!lease.current(epoch) || !foreground.current) throw new CancelledError();
      await audio.current!.start();
      if (!lease.current(epoch) || !foreground.current) { await stopAudio(); throw new CancelledError(); }
      setRecordChatId(activeChatId); setRecording(null); setAudioState('recording');
    } catch (error) { setManualAudio(false); throw error; }
  }
  async function finishRecording() {
    try { const result = await audio.current!.finish(); setRecording(result); }
    catch (reason) { setManualAudio(false); throw reason; }
    finally { setAudioState('idle'); }
  }
  async function uploadRecording(value: Recording, signal?: AbortSignal) {
    const data = new FormData();
    data.append('file', { uri: value.uri, name: 'voice.wav', type: 'audio/wav' } as unknown as Blob);
    return api.request<{ id: string }>('/v1/media', 'POST', data, signal);
  }
  async function useRecording() {
    if (!recording) return;
    const userEpoch = authEpoch.current;
    setBusy(true);
    try {
      const media = await uploadRecording(recording);
      if (userEpoch !== authEpoch.current) return;
      if (recordChatId) await sendPending({ chatId: recordChatId, content: { kind: 'voice', mediaId: media.id }, clientMessageId: Crypto.randomUUID(), status: 'sending' });
      await audio.current!.disposeRecording(recording); setRecording(null); setManualAudio(false);
    } finally { setBusy(false); }
  }
  async function discardRecording() { await stopAudio(); if (recording) await audio.current!.disposeRecording(recording); setRecording(null); setManualAudio(false); }
  async function preview() { if (!recording) return; await stopAudio(); setAudioState('playing'); try { await audio.current!.play(recording.uri); } finally { setAudioState('idle'); } }
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
      if (!valid()) throw new Error('This recording request has expired.');
      await refresh();
      await startRecording();
      if (!valid()) { await stopAudio(); throw new CancelledError(); }
      setRecordChatId(chat.id); setView('chats', chat.id); setDevicePrompt(null);
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
    const deadline = Date.now() + 90000;
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
    ready: () => deviceTasks.size === 0,
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
  return { booting, session, aiMode, microphoneMuted, toggleMicrophone, stopAssistantReply, voiceLevel, voicePhase, voiceFault, error, setError, busy, tab, capabilities, chats, contacts, drafts, messages, chatScrollPositions, hasOlder, activeChatId, composers, pending, turns, assistantSession, audioState, recording, devicePrompt, api, fail, requestOtp, verifyOtp, completeProfile, logout, saveAiMode, resumeAssistant, retryAssistant, refresh, loadMessages, navigate, navigateBack, startChat, sendText, sendPending, draftAction, interrupt, playMedia, startRecording, finishRecording, useRecording, discardRecording, preview, stopAudio, declineDevice, acceptDeviceRecording,
    setComposer: (text: string) => { if (activeChatId) setComposers(previous => ({ ...previous, [activeChatId]: text })); },
  };
}
export type Mia = ReturnType<typeof useMia>;
