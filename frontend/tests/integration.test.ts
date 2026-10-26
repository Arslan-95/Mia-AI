import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Api, ApiError } from '../src/api';
import { pcmWav } from '../src/audio/wav';
import type { Chat, Contact, Draft, Message, OtpChallenge, Profile, Session, User } from '../src/types';

const integrationEnabled = !!process.env.MIA_TEST_API && !!process.env.MIA_TEST_OTP;

test('real backend: phone OTP, profile, contacts, stable retries, pagination, read markers, versioned drafts and authorized WAV', { skip: !integrationEnabled }, async () => {
  const base = process.env.MIA_TEST_API!;
  const developmentCode = process.env.MIA_TEST_OTP!;
  assert.match(developmentCode, /^\d{6}$/, 'Provide the configured server development code through MIA_TEST_OTP.');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const phonePrefix = '+1999' + String(Date.now()).slice(-8);
  const publicApi = new Api(base, null);

  async function create(role: string, phoneNumber: string): Promise<Session> {
    const challenge = await publicApi.request<OtpChallenge>('/v1/auth/otp/request', 'POST', { phoneNumber });
    assert.equal(challenge.delivery, 'development');
    assert.ok(Date.parse(challenge.expiresAt) > Date.now());
    const session = await publicApi.request<Session>('/v1/auth/otp/verify', 'POST', { challengeId: challenge.challengeId, code: developmentCode });
    assert.equal(session.user.phoneNumber, phoneNumber);
    assert.equal(session.user.profileComplete, false);
    const api = new Api(base, session);
    const user = await api.request<User>('/v1/me', 'PATCH', { username: role + suffix, displayName: `Frontend QA ${role}` });
    assert.equal(user.profileComplete, true);
    assert.equal((await api.request<User>('/v1/me')).username, role + suffix);
    return { ...session, user };
  }

  const [sender, recipient] = await Promise.all([create('sender', phonePrefix + '01'), create('recipient', phonePrefix + '02')]);
  const api = new Api(base, sender); const other = new Api(base, recipient);
  try {
    const challenge = await publicApi.request<OtpChallenge>('/v1/auth/otp/request', 'POST', { phoneNumber: sender.user.phoneNumber });
    const wrongCode = String((Number(developmentCode[0]) + 1) % 10) + developmentCode.slice(1);
    await assert.rejects(publicApi.request('/v1/auth/otp/verify', 'POST', { challengeId: challenge.challengeId, code: wrongCode }), error => error instanceof ApiError && error.status >= 400 && error.status < 500);
    const login = await publicApi.request<Session>('/v1/auth/otp/verify', 'POST', { challengeId: challenge.challengeId, code: developmentCode });
    assert.equal(login.user.id, sender.user.id); assert.equal(login.user.profileComplete, true);
    await new Api(base, login).request('/v1/auth/logout', 'POST');
    assert.equal((await api.request<Profile>('/v1/me')).id, sender.user.id);
    assert.equal((await api.request<Profile[]>(`/v1/users?query=recipient${suffix}`))[0]?.id, recipient.user.id);
    assert.equal((await api.request<Contact>('/v1/contacts', 'POST', { userId: recipient.user.id })).id, recipient.user.id);
    const chat = await api.request<{ id: string }>('/v1/chats', 'POST', { recipientId: recipient.user.id });
    const input = { clientMessageId: randomUUID(), content: { kind: 'text', text: 'Frontend integration hello.' } };
    const first = await api.request<Message>(`/v1/chats/${chat.id}/messages`, 'POST', input);
    const retry = await api.request<Message>(`/v1/chats/${chat.id}/messages`, 'POST', input); assert.equal(first.id, retry.id);
    const second = await api.request<Message>(`/v1/chats/${chat.id}/messages`, 'POST', { clientMessageId: randomUUID(), content: { kind: 'text', text: 'Pagination check.' } });
    const newest = await api.request<Message[]>(`/v1/chats/${chat.id}/messages?limit=1`); assert.equal(newest[0]?.id, second.id);
    const older = await api.request<Message[]>(`/v1/chats/${chat.id}/messages?before=${second.id}`); assert.equal(older[0]?.id, first.id);
    await other.request(`/v1/chats/${chat.id}/read`, 'POST', { messageId: second.id }); assert.equal((await other.request<Chat[]>('/v1/chats'))[0]?.unreadCount, 0);
    const draft = await api.request<Draft>('/v1/drafts', 'POST', { recipientId: recipient.user.id, content: { kind: 'text', text: 'A saved thought.' } });
    await assert.rejects(api.request(`/v1/drafts/${draft.id}/confirm`, 'POST', { version: draft.version }), e => e instanceof ApiError && e.status === 409);
    const edited = await api.request<Draft>(`/v1/drafts/${draft.id}`, 'PATCH', { version: draft.version, content: { kind: 'text', text: 'An edited thought.' } });
    assert.equal(edited.version, draft.version + 1);
    await assert.rejects(api.request(`/v1/drafts/${draft.id}/review`, 'POST', { version: draft.version }), e => e instanceof ApiError && e.status === 409);
    await api.request(`/v1/drafts/${draft.id}/review`, 'POST', { version: edited.version });
    await api.request(`/v1/drafts/${draft.id}/confirm`, 'POST', { version: edited.version });
    const upload = new FormData(); upload.append('file', new Blob([pcmWav(new Uint8Array(4800)).buffer as ArrayBuffer], { type: 'audio/wav' }), 'qa.wav');
    const media = await api.request<{ id: string }>('/v1/media', 'POST', upload);
    await api.request(`/v1/chats/${chat.id}/messages`, 'POST', { clientMessageId: randomUUID(), content: { kind: 'voice', mediaId: media.id } });
    const response = await fetch(`${base}/v1/media/${media.id}`, { headers: { Authorization: `Bearer ${recipient.token}` } }); assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, 4844);
    const unauthenticated = await fetch(`${base}/v1/media/${media.id}`); assert.equal(unauthenticated.status, 401);
  } finally { await Promise.all([api.request('/v1/auth/logout', 'POST'), other.request('/v1/auth/logout', 'POST')]); }
});
