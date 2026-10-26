import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Api } from './api';
import { preferences, sessionStorage } from './storage';
import { Realtime, type Frame } from './realtime';
import { PresentationLease, isLiveAction, mergeMessages } from './coordination';
import { Engine } from './audio/engine';
import { concatBytes } from './audio/wav';
import type { Recording } from './audio/types';
import type { AssistantSession, Capabilities, Chat, Contact, Content, DeviceAction, Draft, Message, OtpChallenge, PendingMessage, Profile, ServerEvent, Session, Turn, User } from './types';
export type Tab = 'chats' | 'mia' | 'people' | 'settings' | 'drafts';
const defaultAddress = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
export function useMia() {
  const [booting, setBooting] = useState(true); const [session, setSession] = useState<Session | null>(null);
  const [address, setAddress] = useState(defaultAddress); const [voiceMode, setVoiceMode] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('chats'); const [connection, setConnection] = useState('Offline');
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [chats, setChats] = useState<Chat[]>([]); const [contacts, setContacts] = useState<Contact[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]); const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [hasOlder, setHasOlder] = useState<Record<string, boolean>>({}); const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [composers, setComposers] = useState<Record<string, string>>({}); const [pending, setPending] = useState<PendingMessage[]>([]);
  const [assistantSession, setAssistantSession] = useState<AssistantSession | null>(null); const [turns, setTurns] = useState<Turn[]>([]);
  const [assistantText, setAssistantText] = useState(''); const [assistantRetry, setAssistantRetry] = useState<{ clientTurnId: string; text: string } | null>(null);
  const [audioState, setAudioState] = useState<'idle' | 'recording' | 'loading' | 'playing'>('idle');
  const [recording, setRecording] = useState<Recording | null>(null); const [recordPurpose, setRecordPurpose] = useState<'note' | 'assistant'>('note');
  const [recordChatId, setRecordChatId] = useState<string | null>(null); const [devicePrompt, setDevicePrompt] = useState<DeviceAction | null>(null);
  const lease = useRef(new PresentationLease()).current; const audio = useRef<Engine | null>(null); if (!audio.current) audio.current = new Engine();
  const socket = useRef<Realtime | null>(null); const state = useRef({ session, activeChatId, tab, assistantSession, chats, devicePrompt });
  state.current = { session, activeChatId, tab, assistantSession, chats, devicePrompt };
  const foreground = useRef(true); const authEpoch = useRef(0); const stopRef = useRef<() => Promise<void>>(async () => {});
  const identityRevision = useRef(0);
  const startingDeviceRecording = useRef<string | null>(null);
  const fail = useCallback((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Something went wrong. Please try again.'), []);
  const api = useMemo(() => new Api(address, session, () => { void clearSession(); }), [address, session]);
  async function clearSession() {
    authEpoch.current++; lease.revoke(); socket.current?.dispose(); await audio.current!.stop();
    await sessionStorage.write(null).catch(fail); setSession(null); setChats([]); setContacts([]); setDrafts([]); setMessages({}); setTurns([]); setPending([]); setComposers({}); setActiveChatId(null); setAssistantSession(null); setAssistantRetry(null); setAssistantText(''); setDevicePrompt(null); setAudioState('idle');
    if (recording) await audio.current!.disposeRecording(recording); setRecording(null);
  }
  useEffect(() => { void (async () => {
    try {
      const [stored, server, mode] = await Promise.all([sessionStorage.read(), preferences.get('mia.address'), preferences.get('mia.voice')]);
      if (server) setAddress(server); setVoiceMode(mode === 'true'); setSession(stored);
    } catch (reason) { fail(reason); } finally { setBooting(false); }
  })(); }, []);
  async function checkHealth() {
    try { const health = await api.request<{ capabilities: Capabilities }>('/health/ready'); setCapabilities(health.capabilities); }
    catch (reason) { setCapabilities(null); fail(reason); }
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
  async function syncAssistant() {
    const current = state.current.assistantSession; if (!current) return;
    const epoch = authEpoch.current;
    const result = await api.request<{ turns: Turn[] }>(`/v1/assistant/sessions/${current.id}`);
    if (epoch === authEpoch.current) setTurns(result.turns);
  }
  const handlers = useRef({ onEvent: async (_: ServerEvent, __: number) => {}, onFrame: (_: Frame) => {} });
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
    const realtime = new Realtime(address, session, (event, time) => handlers.current.onEvent(event, time), frame => handlers.current.onFrame(frame), setConnection, preferences);
    socket.current = realtime; void realtime.connect();
    return () => { cancelled = true; realtime.dispose(); lease.revoke(); void audio.current!.stop(); };
  }, [session?.token, session?.user.profileComplete, address, booting]);
  const speech = useRef<{ requestId: string; turnId: string; epoch: number; parts: Uint8Array[]; bytes: number } | null>(null);
  async function stopAudio() {
    speech.current = null; socket.current?.send({ type: 'speech.cancel' }); socket.current?.send({ type: 'voice.cancel' });
    await audio.current!.stop(); setAudioState('idle');
  }
  stopRef.current = stopAudio;
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      foreground.current = next === 'active';
      if (next !== 'active') { lease.revoke(); setDevicePrompt(null); void stopRef.current(); }
    });
    return () => { subscription.remove(); void audio.current!.stop(); };
  }, []);
  async function interrupt() { lease.revoke(); setDevicePrompt(null); socket.current?.send({ type: 'assistant.stop' }); await stopAudio(); }
  async function navigate(next: Tab, chatId: string | null = null) {
    void interrupt().catch(fail); setTab(next); setActiveChatId(chatId);
    state.current = { ...state.current, tab: next, activeChatId: chatId };
    if (next === 'chats' && chatId) await loadMessages(chatId).catch(fail);
  }
  async function acknowledge(action: DeviceAction, success: boolean, result: { message?: string; mediaId?: string }) {
    await api.request(`/v1/device-actions/${action.actionId}/result`, 'POST', { success, result });
  }
  async function performAction(action: DeviceAction) {
    const epoch = lease.snapshot();
    const valid = () => lease.current(epoch) && foreground.current && Date.now() - Date.parse(action.createdAt) < 18000;
    try {
      if (action.kind === 'open_chat' && typeof action.payload.chatId === 'string') {
        const list = await api.request<Chat[]>('/v1/chats');
        if (!valid()) throw new Error('This device request is no longer current.');
        const chat = list.find(item => item.id === action.payload.chatId); if (!chat) throw new Error('The requested chat is unavailable.');
        await stopAudio();
        if (!valid()) throw new Error('This device request is no longer current.');
        setChats(list); setActiveChatId(chat.id); setTab('chats');
        // Acknowledge after history is actually loaded for the visible chat.
        await loadMessages(chat.id);
        if (!lease.current(epoch)) throw new Error('A newer conversation is active.');
        await acknowledge(action, true, { message: 'Chat opened.' });
      } else if (action.kind === 'stop_audio') {
        await stopAudio(); await acknowledge(action, true, { message: 'Audio stopped on this device.' });
      } else if (action.kind === 'play_audio' && typeof action.payload.mediaId === 'string') {
        let acknowledged = false;
        await playMedia(action.payload.mediaId, () => {
          if (valid()) {
            acknowledged = true;
            void acknowledge(action, true, { message: 'Playback started on this device.' }).catch(fail);
          }
        }, valid);
        if (!acknowledged) throw new Error('Playback did not start.');
      } else if (action.kind === 'record_voice') {
        setDevicePrompt(action);
      } else throw new Error('This device action is not supported.');
    } catch (reason) { await acknowledge(action, false, { message: reason instanceof Error ? reason.message : 'Device action failed.' }).catch(fail); }
  }
  handlers.current.onEvent = async (event, connectedAt) => {
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
      if (event.type === 'assistant.failed' && lease.owns(p.turnId)) setError(String(p.message ?? 'Mia could not complete your request. Your drafts are saved.'));
    }
    if (event.type === 'device.action_cancelled' && state.current.devicePrompt?.actionId === p.actionId) setDevicePrompt(null);
    if (event.type === 'device.action_requested' && isLiveAction(event, connectedAt) && foreground.current && lease.owns(p.turnId)) void performAction({ ...p, createdAt: event.createdAt } as DeviceAction);
  };
  handlers.current.onFrame = frame => {
    const current = speech.current;
    if (frame.type === 'error') { const error = frame.error as { message?: string }; setError(error?.message ?? 'The live connection could not process that request.'); }
    if (!current || current.requestId !== frame.requestId || !lease.current(current.epoch)) return;
    if (frame.type === 'speech.chunk') {
      if (frame.sequence !== current.parts.length) { void stopAudio(); fail(new Error('Speech arrived out of order. Try again.')); return; }
      const bytes = Uint8Array.from(atob(String(frame.audio)), c => c.charCodeAt(0));
      current.bytes += bytes.length;
      if (current.bytes > 12000000) { void stopAudio(); fail(new Error('This spoken response is too long.')); return; }
      current.parts.push(bytes);
    } else if (frame.type === 'speech.completed') {
      if (frame.chunks !== current.parts.length || frame.totalBytes !== current.bytes || !current.bytes) { void stopAudio(); fail(new Error('The spoken response was incomplete.')); return; }
      setAudioState('playing');
      void audio.current!.playPcm(concatBytes(current.parts)).catch(fail).finally(() => { if (speech.current === current) { speech.current = null; setAudioState('idle'); } });
    } else if (frame.type === 'speech.failed' || frame.type === 'speech.cancelled') { speech.current = null; setAudioState('idle'); if (frame.type === 'speech.failed') setError('Speech is unavailable on this server. The response is still available as text.'); }
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
  async function saveSettings(server: string, voice: boolean) {
    await interrupt();
    if (server !== address && session) { try { await api.request('/v1/auth/logout', 'POST'); } catch { /* Local sign-out remains available while offline. */ } await clearSession(); }
    await preferences.set('mia.address', server); await preferences.set('mia.voice', String(voice)); setAddress(server); setVoiceMode(voice); setCapabilities(null);
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
  async function saveDraft() {
    const chat = chats.find(item => item.id === activeChatId); const text = chat ? composers[chat.id]?.trim() : ''; if (!chat || !text) return;
    await api.request('/v1/drafts', 'POST', { recipientId: chat.recipient.id, content: { kind: 'text', text } });
    setComposers(previous => ({ ...previous, [chat.id]: '' })); await refresh();
  }
  async function draftAction(draft: Draft, action: 'review' | 'confirm' | 'discard' | 'edit', text?: string) {
    await api.request(`/v1/drafts/${draft.id}${action === 'review' || action === 'confirm' ? `/${action}` : ''}`, action === 'discard' ? 'DELETE' : action === 'edit' ? 'PATCH' : 'POST', { version: draft.version, ...(action === 'edit' ? { content: { kind: 'text', text } } : {}) });
    await refresh();
  }
  async function submitAssistant(retry?: { clientTurnId: string; text: string }) {
    const text = retry?.text ?? assistantText.trim(); if (!assistantSession || !text) return;
    await stopAudio(); const item = retry ?? { text, clientTurnId: Crypto.randomUUID() };
    lease.begin(item.clientTurnId); setDevicePrompt(null); setAssistantRetry(item); setAssistantText('');
    const epoch = lease.snapshot();
    try {
      const response = await api.request<{ turn: Turn }>(`/v1/assistant/sessions/${assistantSession.id}/turns`, 'POST', item);
      if (lease.current(epoch)) lease.accept(item.clientTurnId, response.turn.id);
      if (lease.current(epoch)) setAssistantRetry(null); await syncAssistant();
    } catch (reason) { if (lease.current(epoch)) fail(reason); }
  }
  async function speak(turn: Turn) {
    const epoch = lease.snapshot();
    await stopAudio();
    if (!lease.current(epoch) || !foreground.current || turn.status !== 'completed') return;
    const requestId = Crypto.randomUUID();
    speech.current = { requestId, turnId: turn.id, epoch, parts: [], bytes: 0 };
    if (!socket.current?.send({ type: 'speech.request', requestId, turnId: turn.id })) { speech.current = null; throw new Error('Reconnect before requesting speech.'); }
    setAudioState('loading');
  }
  async function playMedia(mediaId: string, onStarted?: () => void, allowed = () => true) {
    await stopAudio(); if (!allowed() || !foreground.current) throw new Error('Playback was cancelled.'); setAudioState('playing');
    try { await audio.current!.play(`${address}/v1/media/${mediaId}`, { Authorization: `Bearer ${session!.token}` }, onStarted); }
    finally { setAudioState('idle'); }
  }
  async function startRecording(purpose: 'note' | 'assistant') {
    const epoch = lease.snapshot();
    await stopAudio();
    if (await AccessibilityInfo.isScreenReaderEnabled()) {
      // Explicit half duplex: no automatic spoken announcements while the microphone is open.
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    if (!lease.current(epoch) || !foreground.current) throw new Error('Recording was cancelled.');
    await audio.current!.start();
    if (!lease.current(epoch) || !foreground.current) { await stopAudio(); throw new Error('Recording was cancelled.'); }
    setRecordPurpose(purpose); setRecordChatId(activeChatId); setRecording(null); setAudioState('recording');
  }
  async function finishRecording() {
    try { const result = await audio.current!.finish(); setRecording(result); } finally { setAudioState('idle'); }
  }
  async function uploadRecording(value: Recording) {
    const data = new FormData();
    data.append('file', { uri: value.uri, name: 'voice.wav', type: 'audio/wav' } as unknown as Blob);
    return api.request<{ id: string }>('/v1/media', 'POST', data);
  }
  async function useRecording() {
    if (!recording) return;
    const epoch = lease.snapshot(); const userEpoch = authEpoch.current;
    setBusy(true);
    try {
      const media = await uploadRecording(recording);
      if (userEpoch !== authEpoch.current) return;
      if (recordPurpose === 'assistant') {
        const result = await api.request<{ text: string }>('/v1/speech/transcriptions', 'POST', { mediaId: media.id });
        if (userEpoch !== authEpoch.current) return;
        setAssistantText(result.text); if (lease.current(epoch)) setTab('mia');
      } else if (recordChatId) await sendPending({ chatId: recordChatId, content: { kind: 'voice', mediaId: media.id }, clientMessageId: Crypto.randomUUID(), status: 'sending' });
      await audio.current!.disposeRecording(recording); setRecording(null);
    } finally { setBusy(false); }
  }
  async function discardRecording() { await stopAudio(); if (recording) await audio.current!.disposeRecording(recording); setRecording(null); }
  async function preview() { if (!recording) return; await stopAudio(); setAudioState('playing'); try { await audio.current!.play(recording.uri); } finally { setAudioState('idle'); } }
  async function declineDevice() { const action = devicePrompt; setDevicePrompt(null); if (action && startingDeviceRecording.current === action.actionId) { startingDeviceRecording.current = null; await stopAudio(); } if (action) await acknowledge(action, false, { message: 'The user declined this recording request.' }); }
  async function acceptDeviceRecording() {
    const action = devicePrompt; if (!action || !lease.owns(action.turnId) || startingDeviceRecording.current) return;
    startingDeviceRecording.current = action.actionId;
    const epoch = lease.snapshot();
    const valid = () => lease.current(epoch) && startingDeviceRecording.current === action.actionId && Date.now() - Date.parse(action.createdAt) < 18000;
    try {
      const recipientId = action.payload.recipientId;
      if (typeof recipientId !== 'string') throw new Error('The recording recipient is missing.');
      const chat = await api.request<{ id: string }>('/v1/chats', 'POST', { recipientId });
      if (!valid()) throw new Error('This recording request has expired.');
      await refresh();
      await startRecording('note');
      if (!valid()) { await stopAudio(); throw new Error('Recording was cancelled.'); }
      setRecordChatId(chat.id); setTab('chats'); setActiveChatId(chat.id); setDevicePrompt(null);
      await acknowledge(action, true, { message: 'Recording started after the user chose Record. The recording is not yet uploaded or sent.' });
    } catch (reason) { setDevicePrompt(null); await acknowledge(action, false, { message: reason instanceof Error ? reason.message : 'Recording did not start.' }).catch(fail); fail(reason); }
    finally { if (startingDeviceRecording.current === action.actionId) startingDeviceRecording.current = null; }
  }
  useEffect(() => {
    if (!devicePrompt) return;
    const timer = setTimeout(() => { setDevicePrompt(null); if (startingDeviceRecording.current === devicePrompt.actionId) { startingDeviceRecording.current = null; void stopRef.current(); } }, Math.max(0, 18000 - (Date.now() - Date.parse(devicePrompt.createdAt))));
    return () => clearTimeout(timer);
  }, [devicePrompt]);
  return { booting, session, address, voiceMode, error, setError, busy, tab, connection, capabilities, chats, contacts, drafts, messages, hasOlder, activeChatId, composers, pending, turns, assistantText, setAssistantText, assistantRetry, assistantSession, audioState, recording, recordPurpose, devicePrompt, api, fail, requestOtp, verifyOtp, completeProfile, logout, saveSettings, checkHealth, refresh, loadMessages, navigate, startChat, sendText, sendPending, saveDraft, draftAction, submitAssistant, interrupt, speak, playMedia, startRecording, finishRecording, useRecording, discardRecording, preview, stopAudio, declineDevice, acceptDeviceRecording,
    setComposer: (text: string) => { if (activeChatId) setComposers(previous => ({ ...previous, [activeChatId]: text })); },
  };
}
export type Mia = ReturnType<typeof useMia>;
