import { z } from 'zod';
import type { Database } from '../db/database.js';
import { AppError, conflict } from '../errors.js';
import { MessagingService } from '../messaging.js';
import { contentSchema } from '../routes/messaging.js';
import { AssistantState, type Turn } from './state.js';
import type { FunctionDefinition } from './model.js';

export type AgentName = 'mia' | 'messaging' | 'contacts';
export type Tool = { definition: FunctionDefinition; execute(input: unknown): Promise<unknown> };
export type ToolContext = { db: Database; state: AssistantState; turn: Turn; signal: AbortSignal;
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

export function toolsFor(agent: AgentName, context: ToolContext): Map<string, Tool> {
  const { db, state, turn, signal } = context;
  const messaging = new MessagingService(db);
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
      ({ userId, name }) => mutate((service) => service.addContact(turn.userId, userId, name))),
    define('list_chats', 'Get current direct chats, participants, last message and unread counts.', empty,
      () => messaging.chats(turn.userId)),
    define('get_chat', 'Read one authorized direct chat by chat ID, including its recipient and unread count.',
      z.object({ chatId: uuid }).strict(), ({ chatId }) => messaging.chat(turn.userId, chatId)),
    define('read_messages', 'Read actual messages in a chat, newest first. Use a before ID to read older messages.',
      z.object({ chatId: uuid, limit: z.int().min(1).max(30), before: uuid.nullable() }).strict(),
      ({ chatId, limit, before }) => messaging.messages(turn.userId, chatId, limit, before ?? undefined)),
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
    define('open_chat', 'Request that the app open the direct chat with a verified recipient. This does not send or discard drafts.',
      z.object({ recipientId: uuid }).strict(), async ({ recipientId }) => {
        const chat = await mutate(service => service.createDirectChat(turn.userId, recipientId));
        return state.action(turn, signal, 'open_chat', { chatId: chat.id });
      }),
    define('play_voice_message', 'Request playback of an authorized voice message on the phone. Pending means requested, not yet played.',
      z.object({ messageId: uuid }).strict(), async ({ messageId }) => {
        const message = await messaging.message(turn.userId, messageId);
        if (message.kind !== 'voice' || !message.mediaId) throw new AppError(400, 'NOT_VOICE', 'This message has no voice recording.');
        return state.action(turn, signal, 'play_audio', { messageId, mediaId: message.mediaId, path: `/v1/media/${message.mediaId}` });
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
    ? tools.filter((tool) => ['list_contacts', 'get_contact', 'search_users', 'add_contact'].includes(tool.definition.name))
    : agent === 'messaging' ? tools.filter((tool) => tool.definition.name !== 'add_contact') : [...tools, ...coordinator];
  return new Map(allowed.map((tool) => [tool.definition.name, tool]));
}
