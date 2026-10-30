import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { Database } from '../db/database.js';
import { AppError, conflict } from '../errors.js';
import { MessagingService } from '../messaging.js';
import { contentSchema } from '../routes/messaging.js';
import { AssistantState, type Turn } from './state.js';
import type { FunctionDefinition } from './model.js';
import { AgentMemory, memoryInput } from './memory.js';
import type { MemoryReviewer, MemoryChange } from './memory-policy.js';
import type { VoiceExitReviewer } from './voice-exit-policy.js';
import { assertSourceFocus } from './context.js';

export type AgentName = 'mia' | 'messaging' | 'contacts';
export type Tool = { definition: FunctionDefinition; execute(input: unknown): Promise<unknown> };
export type ToolContext = { db: Database; state: AssistantState; turn: Turn; signal: AbortSignal;
  reviewMemory?: MemoryReviewer;
  reviewVoiceExit?: VoiceExitReviewer;
  delegate(name: Exclude<AgentName, 'mia'>, goal: string): Promise<string> };

function define<T extends z.ZodType>(name: string, description: string, schema: T,
  execute: (input: z.infer<T>) => Promise<unknown>): Tool {
  const { $schema: _, ...parameters } = z.toJSONSchema(schema);
  return { definition: { type: 'function', name, description, parameters, strict: false },
    execute: async (input) => execute(schema.parse(input)) };
}

const uuid = z.uuid();
const empty = z.object({}).strict();
const versionedDraft = z.object({ draftId: uuid, version: z.int().positive() }).strict();
const pageRoutes = { assistant: '/mia', chats: '/chats', contacts: '/contacts', drafts: '/drafts', settings: '/settings' } as const;

export function toolsFor(agent: AgentName, context: ToolContext): Map<string, Tool> {
  const { db, state, turn, signal } = context;
  const messaging = new MessagingService(db);
  const memory = new AgentMemory(db);
  const resolution = async (contact: Awaited<ReturnType<MessagingService['contact']>>) => ({ contact,
    sameNameContacts: await db.query(`SELECT c.id AS "contactId",c.name,u.username FROM contacts c JOIN users u ON u.id=c.user_id
      WHERE c.owner_id=$1 AND lower(c.name)=lower($2) ORDER BY c.id LIMIT 50`, [turn.userId, contact.name]),
  });
  const review = (change: MemoryChange) => {
    if (!context.reviewMemory) throw new AppError(503, 'MEMORY_REVIEW_UNAVAILABLE', 'The change could not be checked.');
    return context.reviewMemory(change);
  };
  const voiceAction = async (kind: string, payload: unknown) => {
    if (!turn.context?.voice) throw new AppError(409, 'VOICE_CONTROLS_UNAVAILABLE', 'This device has not reported voice controls. Do not guess its mode or claim it changed.');
    const action = await state.action(turn, signal, kind, payload);
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      signal.throwIfAborted();
      const [current] = await db.query(`SELECT id,kind,state,result FROM device_actions WHERE id=$1 AND user_id=$2`, [action.id, turn.userId]);
      if (current?.state !== 'pending') return current;
      await delay(80, undefined, { signal });
    }
    return action;
  };
  const presentationAction = async (kind: string, payload: unknown) => {
    const action = await state.action(turn, signal, kind, payload);
    const until = Date.now() + 175000;
    while (Date.now() < until) {
      signal.throwIfAborted();
      const [current] = await db.query(`SELECT id,kind,state,result FROM device_actions WHERE id=$1 AND user_id=$2`, [action.id, turn.userId]);
      if (current?.state !== 'pending') return current;
      await delay(100, undefined, { signal });
    }
    return { ...action, message: 'Device completion was not confirmed. Do not claim it displayed or played.' };
  };
  const mutate = <T>(fn: (service: MessagingService, scoped: Database) => Promise<T>) =>
    state.mutate(turn, signal, (scoped) => fn(new MessagingService(scoped), scoped));
  const tools = [
    define('list_contacts', 'Search saved contacts by name, username or full international phone number; an empty query lists contacts.',
      z.object({ query: z.string().max(100) }).strict(), ({ query }) => messaging.contacts(turn.userId, query)),
    define('get_contact', 'Read a saved contact by its contact ID, including the registered user ID and name.',
      z.object({ contactId: uuid }).strict(), ({ contactId }) => messaging.contact(turn.userId, contactId)),
    define('search_users', 'Find registered people by username prefix or exact full international phone number with country code (for example +1 202 555 0101). Never guess a country code or search a phone prefix. A result does not expose the person\'s phone number.',
      z.object({ query: z.string().min(2).max(50) }).strict(), ({ query }) => messaging.searchUsers(turn.userId, query)),
    define('add_contact', 'Save a registered person as a contact when the user requests it.',
      z.object({ userId: uuid, name: z.string().min(1).max(80) }).strict(),
      ({ userId, name }) => mutate(async (service, scoped) => {
        const [existing] = await scoped.query<{ id: string; name: string }>('SELECT id,name FROM contacts WHERE owner_id=$1 AND user_id=$2', [turn.userId, userId]);
        if (existing) {
          if (existing.name !== name) throw conflict('This person is already saved. Use rename_contact for a requested name change.');
          return service.contact(turn.userId, existing.id);
        }
        return service.addContact(turn.userId, userId, name);
      })),
    define('rename_contact', 'Change only the saved display label of an existing contact when requested. Resolve its contact ID first. This does not change personal memory, a legal name, or a family relationship.',
      z.object({ contactId: uuid, name: z.string().trim().min(1).max(80) }).strict(), async ({ contactId, name }) => {
        const contact = await messaging.contact(turn.userId, contactId);
        await review({ action: 'rename_contact', data: { ...await resolution(contact), name } });
        return mutate(service => service.renameContact(turn.userId, contactId, name));
      }),
    define('list_memories', 'Read saved long-term knowledge. Empty query lists ALL kinds, including relationships. For semantic recall, inspect the supplied memory context or list memories rather than guessing a name. Follow next cursors to see further records. Contacts include their CURRENT label and stable IDs.',
      z.object({ query: z.string().trim().max(100).nullable(), contactId: uuid.nullable(), after: uuid.nullable() }).strict(),
      ({ query, contactId, after }) => memory.list(turn.userId, { query: query ?? undefined, contactId: contactId ?? undefined, after: after ?? undefined })),
    define('get_memory', 'Read the current saved fact and version before correcting or deleting it.', z.object({ memoryId: uuid }).strict(),
      ({ memoryId }) => memory.get(turn.userId, memoryId)),
    define('list_chats', 'Get current direct chats, participants, last message and unread counts.', empty,
      () => messaging.chats(turn.userId)),
    define('get_chat', 'Read one authorized direct chat by chat ID, including its recipient and unread count.',
      z.object({ chatId: uuid }).strict(), ({ chatId }) => messaging.chat(turn.userId, chatId)),
    define('read_messages', 'Read actual messages in a chat, newest first. Use a before ID to read older messages.',
      z.object({ chatId: uuid, limit: z.int().min(1).max(30), before: uuid.nullable() }).strict(),
      ({ chatId, limit, before }) => messaging.messages(turn.userId, chatId, limit, before ?? undefined)),
    define('get_message', 'Fetch one exact authorized source even when it is years old. Chat and message IDs must match.',
      z.object({ chatId: uuid, messageId: uuid }).strict(), ({ chatId, messageId }) => messaging.source(turn.userId, chatId, messageId)),
    define('search_messages', 'Search stored messages in one resolved chat by literal text and/or absolute date window, newest first. Bounded pages, next cursor; use for old sources instead of reading an entire history.',
      z.object({ chatId: uuid, query: z.string().trim().max(200).nullable(), afterDate: z.iso.datetime().nullable(), beforeDate: z.iso.datetime().nullable(), before: uuid.nullable(), limit: z.int().min(1).max(20) }).strict(),
      ({ chatId, query, afterDate, beforeDate, before, limit }) => messaging.searchMessages(turn.userId, chatId, { query: query ?? undefined, afterDate: afterDate ?? undefined, beforeDate: beforeDate ?? undefined, before: before ?? undefined, limit })),
    define('list_drafts', 'List saved unsent drafts, including drafts parked when the user changed tasks.', empty,
      () => messaging.drafts(turn.userId)),
    define('get_draft', 'Read the exact saved content and current version of a draft.', z.object({ draftId: uuid }).strict(),
      ({ draftId }) => messaging.draft(turn.userId, draftId)),
    define('create_draft', 'Prepare an unsent text or original voice-recording message for a verified recipient.',
      z.object({ recipientId: uuid, content: contentSchema }).strict(),
      ({ recipientId, content }) => mutate((service) => service.createDraft(turn.userId, recipientId, content, signal))),
    define('update_draft', 'Revise an existing draft at its current version. This invalidates any earlier review.',
      z.object({ draftId: uuid, version: z.int().positive(), content: contentSchema }).strict(),
      ({ draftId, version, content }) => mutate((service) => service.updateDraft(turn.userId, draftId, version, content, signal))),
    define('discard_draft', 'Discard a draft only when the user wants that message discarded; changing chats is not discarding.',
      versionedDraft, ({ draftId, version }) => mutate((service) => service.discardDraft(turn.userId, draftId, version, signal))),
  ];
  const coordinator = [
    define('show_message', 'Show or replace a passive visual reference to an exact stored source, opening its real chat. Optional narration is your natural spoken explanation about THIS source (not an automatic reading); it plays before this tool completes. Wait for completed device feedback before claiming success or advancing to another source. Keep it visible for follow-up. focus uses exact UTF-16 offsets into source text, never replacement display text.',
      z.object({ chatId: uuid, messageId: uuid, focus: z.object({ start: z.int().nonnegative(), end: z.int().positive() }).strict().nullable(), narration: z.string().trim().min(1).max(1800).nullable() }).strict(), async ({ chatId, messageId, focus, narration }) => {
        const message = await messaging.source(turn.userId, chatId, messageId);
        if (focus && (focus.start >= focus.end || focus.end > (message.text?.length ?? 0))) throw new AppError(400, 'INVALID_FOCUS', 'Select exact valid source offsets.');
        if (focus) assertSourceFocus(message.text ?? '', focus);
        return presentationAction('show_message', { chatId, messageId, ...(focus ? { focus } : {}), ...(narration ? { narration } : {}) });
      }),
    define('dismiss_message', 'Dismiss the current visual reference when it no longer helps or the user wants it put away. No fixed end-of-speech dismissal. Wait for device feedback.', empty,
      () => presentationAction('dismiss_message', {})),
    define('get_voice_mode', 'Read the actual voice-mode and microphone state reported with this request. This is a device snapshot, not an inferred/default mode. If unreported, say you cannot verify it.',
      empty, async () => {
        const [confirmed] = await db.query<{ result: { voice?: unknown } }>(`SELECT result FROM device_actions
          WHERE user_id=$1 AND turn_id=$2 AND kind IN ('set_voice_mode','set_microphone_muted') AND state='completed'
          ORDER BY created_at DESC,id DESC LIMIT 1`, [turn.userId, turn.id]);
        if (confirmed?.result.voice) return { reported: true, source: 'device confirmation', ...(confirmed.result.voice as Record<string, unknown>) };
        return turn.context?.voice ? { reported: true, source: 'request snapshot', ...turn.context.voice } : { reported: false };
      }),
    define('set_voice_mode', 'Request exit from hands-free voice mode. enabled=true is forbidden: activation is only in Settings. On the first exit request, returns confirmationRequired without changing the phone. Ask a short explicit confirmation question and wait for a LATER user answer. Call again only if that later answer approves leaving voice mode. Success requires completed phone feedback.',
      z.object({ enabled: z.boolean() }).strict(), async ({ enabled }) => {
        if (enabled) throw new AppError(409, 'VOICE_ENABLE_SETTINGS_ONLY', 'Voice mode can only be enabled deliberately in Settings.');
        if (!turn.context?.voice) throw new AppError(409, 'VOICE_CONTROLS_UNAVAILABLE', 'Voice state is unreported. Keep the current mode.');
        if (!turn.context.voice.enabled) return { alreadyOff: true };
        // The request permits asking, not exiting. A repeated question may be
        // a later turn; consent is always reviewed against the latest reply.
        const [pending] = await db.query<{ requestTurnId: string; userText: string; assistantText: string }>(`SELECT r.request_turn_id AS "requestTurnId",question.user_text AS "userText",question.assistant_text AS "assistantText"
          FROM voice_exit_requests r JOIN assistant_turns request ON request.id=r.request_turn_id
          JOIN assistant_turns question ON question.id=(SELECT id FROM assistant_turns WHERE session_id=$1 AND generation<$3 ORDER BY generation DESC LIMIT 1)
          WHERE r.session_id=$1 AND r.consumed_by IS NULL AND r.expires_at>now() AND r.voice_revision=$2
          AND request.status='completed' AND question.status='completed' AND request.generation<=question.generation
          ORDER BY request.generation DESC LIMIT 1`,
        [turn.sessionId, turn.context.voice.revision, turn.generation]);
        if (pending) {
          if (!context.reviewVoiceExit) throw new AppError(503, 'VOICE_EXIT_REVIEW_UNAVAILABLE', 'Exit consent could not be checked. Keep voice mode on.');
          if (await context.reviewVoiceExit(pending)) {
            await state.mutate(turn, signal, async scoped => {
              const updated = await scoped.query(`UPDATE voice_exit_requests SET consumed_by=$2 WHERE request_turn_id=$1 AND consumed_by IS NULL AND expires_at>now() RETURNING request_turn_id`, [pending.requestTurnId, turn.id]);
              if (!updated.length) throw conflict('Exit confirmation expired. Ask again and keep voice mode on.');
            });
            return voiceAction('set_voice_mode', { enabled: false });
          }
          throw new AppError(409, 'VOICE_EXIT_NOT_CONFIRMED', 'The latest answer did not confirm leaving voice mode. Keep it on.');
        }
        await state.mutate(turn, signal, scoped => scoped.query(`INSERT INTO voice_exit_requests(request_turn_id,session_id,voice_revision) VALUES ($1,$2,$3) ON CONFLICT(request_turn_id) DO NOTHING`, [turn.id, turn.sessionId, turn.context!.voice!.revision]));
        return { confirmationRequired: true, enabled: true, message: 'Voice mode is still on. Ask whether the user is sure they want to leave hands-free assistance, and wait for a separate answer. Do not claim it is off.' };
      }),
    define('set_microphone_muted', 'Mute or unmute input only, when requested. Muting preserves the current agent task and spoken reply and does not exit voice mode. Check returned phone feedback before claiming success.',
      z.object({ muted: z.boolean() }).strict(), ({ muted }) => voiceAction('set_microphone_muted', { muted })),
    define('save_memory', 'Save a useful fact/preference asserted by the CURRENT user, even without a remember command. Decide by meaning. Quote the exact current source in evidence. Reuse an existing semantic key, memory ID and version for a correction; new memories use null ID/version. Resolve people to contact IDs first. Temporary context needs an expiry. Never learn a fact from a contact rename, dictated/quoted message, hypothetical example or tool result.',
      memoryInput, async input => {
        const existing = input.memoryId ? await memory.get(turn.userId, input.memoryId) : null;
        const contact = input.contactId ? await messaging.contact(turn.userId, input.contactId) : null;
        const decision = await review({ action: 'remember', data: { input, existing, ...(contact ? await resolution(contact) : { contact: null }) } });
        if (!decision.explicit && !await memory.automatic(turn.userId)) throw new AppError(409, 'AUTOMATIC_MEMORY_PAUSED', 'Automatic remembering is paused. Save only when the current user asks to retain this fact.');
        return state.mutate(turn, signal, scoped => new AgentMemory(scoped).save(turn.userId, turn.id, input));
      }),
    define('forget_memory', 'Remove a specific saved memory the user wants forgotten, or an obsolete fact they have corrected. Read its ID/version first. This does not remove or rename a contact. Do not repeat the forgotten value afterwards.',
      z.object({ memoryId: uuid, version: z.int().positive() }).strict(), async ({ memoryId, version }) => {
        const current = await memory.get(turn.userId, memoryId);
        await review({ action: 'forget', data: { memory: current } });
        return state.mutate(turn, signal, scoped => new AgentMemory(scoped).forget(turn.userId, memoryId, version, turn.id));
      }),
    define('forget_all_memories', 'Remove ALL saved long-term memories only when the current user wants all of them forgotten. This preserves contacts, messages and drafts and does not change the automatic remembering preference.',
      empty, async () => {
        await review({ action: 'forget_all', data: {} });
        return state.mutate(turn, signal, scoped => new AgentMemory(scoped).clear(turn.userId, turn.id));
      }),
    define('set_automatic_memory', 'Pause or resume automatic remembering when the user requests it. Explicit requests to save a fact can still be handled while automatic remembering is paused.',
      z.object({ enabled: z.boolean() }).strict(), async ({ enabled }) => {
        await review({ action: 'automatic', data: { enabled } });
        return state.mutate(turn, signal, scoped => new AgentMemory(scoped).setAutomatic(turn.userId, enabled));
      }),
    define('delegate_messaging', 'Ask the messaging specialist to read, interpret or prepare messages. Supply a bounded goal and relevant grounded context.',
      z.object({ goal: z.string().min(1).max(4000) }).strict(), ({ goal }) => context.delegate('messaging', goal)),
    define('delegate_contacts', 'Ask the contacts specialist to resolve a person or manage a requested contact.',
      z.object({ goal: z.string().min(1).max(4000) }).strict(), ({ goal }) => context.delegate('contacts', goal)),
    define('review_draft', 'Present an unreviewed draft version and ask whether to send. If this unchanged version was already reviewed in a completed earlier turn and the current user approves it, call send_approved_draft directly instead.',
      versionedDraft, ({ draftId, version }) => mutate(async (service, scoped) => {
        const draft = await service.reviewDraft(turn.userId, draftId, version, signal);
        const [earlier] = await scoped.query(`SELECT r.turn_id FROM draft_reviews r JOIN assistant_turns t ON t.id=r.turn_id
          WHERE r.draft_id=$1 AND r.version=$2 AND t.session_id=$3 AND t.status='completed' AND t.generation<$4`,
          [draftId, version, turn.sessionId, turn.generation]);
        if (!earlier) await scoped.query(`INSERT INTO draft_reviews(draft_id,version,turn_id) VALUES ($1,$2,$3)
          ON CONFLICT(draft_id,version) DO UPDATE SET turn_id = EXCLUDED.turn_id`, [draftId, version, turn.id]);
        return { draft, recipient: await service.profile(draft.recipientId), reviewedInEarlierTurn: Boolean(earlier),
          requiresLaterUserApproval: !earlier,
          approvalRule: earlier ? 'This exact version was already presented. Send only if the CURRENT user utterance approves it; do not ask them to confirm the same approval again.' : 'Present the exact recipient and content, then wait for a later user utterance to approve it.' };
      })),
    define('send_approved_draft', 'Send a previously reviewed draft only if the CURRENT user utterance approves that exact recipient and content. A changed topic is not approval. Review must be from a completed EARLIER turn.',
      versionedDraft, ({ draftId, version }) => mutate(async (service, scoped) => {
        const [review] = await scoped.query(`SELECT r.turn_id FROM draft_reviews r JOIN assistant_turns t ON t.id = r.turn_id
          WHERE r.draft_id = $1 AND r.version = $2 AND t.session_id = $3 AND t.status = 'completed'
          AND t.generation < $4`, [draftId, version, turn.sessionId, turn.generation]);
        if (!review) throw conflict('Review the current draft and wait for a later user turn to approve it.');
        return service.confirmDraft(turn.userId, draftId, version, signal);
      })),
    define('open_page', 'Show the assistant home, chat list, contacts, saved drafts or settings on the phone. Navigation preserves voice mode and the current task. Pending means requested; check get_device_action before claiming the page opened.',
      z.object({ page: z.enum(['assistant', 'chats', 'contacts', 'drafts', 'settings']) }).strict(),
      ({ page }) => state.action(turn, signal, 'open_page', { route: pageRoutes[page] })),
    define('open_chat', 'Request that the app open the direct chat with a verified recipient. This does not send or discard drafts.',
      z.object({ recipientId: uuid }).strict(), async ({ recipientId }) => {
        const chat = await mutate(service => service.createDirectChat(turn.userId, recipientId));
        return state.action(turn, signal, 'open_chat', { chatId: chat.id });
      }),
    define('play_voice_message', 'Request playback of an authorized voice message on the phone. Pending means requested, not yet played.',
      z.object({ messageId: uuid }).strict(), async ({ messageId }) => {
        const message = await messaging.message(turn.userId, messageId);
        if (message.kind !== 'voice' || !message.mediaId) throw new AppError(400, 'NOT_VOICE', 'This message has no voice recording.');
        return presentationAction('play_audio', { chatId: message.chatId, messageId, mediaId: message.mediaId, path: `/v1/media/${message.mediaId}` });
      }),
    define('stop_audio', 'Request that the phone stop current audio playback.', empty,
      () => state.action(turn, signal, 'stop_audio', {})),
    define('request_voice_recording', 'Ask the phone to let the user record an original voice note for a verified recipient.',
      z.object({ recipientId: uuid }).strict(), async ({ recipientId }) => {
        await messaging.profile(recipientId);
        return state.action(turn, signal, 'record_voice', { recipientId });
      }),
    define('get_device_action', 'Check whether a requested device action really completed, failed or is still pending.',
      z.object({ actionId: uuid }).strict(), async ({ actionId }) => {
        const [action] = await db.query(`SELECT id,kind,state,result,expires_at <= now() AS expired FROM device_actions WHERE id = $1 AND user_id = $2`, [actionId, turn.userId]);
        if (!action) throw new AppError(404, 'NOT_FOUND', 'The device action was not found.');
        return action;
      }),
  ];
  const allowed = agent === 'contacts'
    ? tools.filter((tool) => ['list_contacts', 'get_contact', 'search_users', 'add_contact', 'rename_contact', 'list_memories', 'get_memory'].includes(tool.definition.name))
    : agent === 'messaging' ? tools.filter((tool) => !['add_contact', 'rename_contact'].includes(tool.definition.name)) : [...tools, ...coordinator];
  return new Map(allowed.map((tool) => [tool.definition.name, tool]));
}
