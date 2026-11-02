import { z } from 'zod';
import type { ClientContext } from './context.js';
import type { Tool, AgentName } from './tools.js';
import { CONTACT_FORM_GUIDANCE, MEMORY_PROMPT, MESSAGE_GUIDANCE, VOICE_CONTROLS_GUIDANCE } from './prompts.js';

const groups = {
  contacts: ['show_contact_form', 'dismiss_contact_form', 'get_contact', 'add_contact', 'rename_contact'],
  messages: ['read_messages', 'get_message', 'search_messages', 'show_message', 'dismiss_message', 'play_voice_message', 'announce_message_skip'],
  drafts: ['list_drafts', 'create_draft', 'update_draft', 'review_draft', 'discard_draft', 'revise_draft_for_review'],
  memory: ['get_memory', 'forget_memory', 'forget_all_memories', 'set_automatic_memory'],
  voice: ['get_voice_mode', 'set_voice_mode', 'set_microphone_muted', 'stop_audio', 'request_voice_recording'],
} as const;
type Capability = keyof typeof groups;
const selection = z.object({ capabilities: z.array(z.enum(['contacts', 'messages', 'drafts', 'memory', 'voice'])).min(1).max(5) }).strict();
const common = new Set(['list_contacts', 'search_users', 'list_chats', 'get_chat', 'open_chat', 'open_page',
  'prepare_draft_for_review', 'get_draft', 'send_approved_draft', 'list_memories', 'save_memory',
  'set_speech_delivery', 'delegate_contacts', 'delegate_messaging', 'read_messages', 'recall_conversation', 'load_tools']);

// Contracts and examples belong in the shared instructions, not repeated in
// every schema. Parameters remain complete and validation is unchanged.
const descriptions: Record<string, string> = {
  list_contacts: 'Find contacts by name/exact international phone; empty query lists them. Verified user id, contactId, label and phone are returned: reuse them without get_contact. Several plausible people require a distinguishing question, never choose the first.',
  get_contact: 'Fetch a saved contact by contactId when its verified identity/details are not already available. Its id is the registered user ID.',
  search_users: 'Find registered Mia users by exact full international phone with country code. Never infer the code or search prefixes.',
  show_contact_form: 'Show a full snapshot for the current requested save/rename: known name and verified/user-supplied phone; null only for unknown fields. Passive UI, saves nothing.',
  dismiss_contact_form: 'Dismiss the current contact form on cancellation or a changed task. Does not undo saved data.',
  add_contact: 'Save the verified registered user as a contact only when requested. Does not change their account or record a personal relationship.',
  rename_contact: 'Change a resolved saved contact label only when currently requested. Does not change legal identity or memory. Independent semantic review applies.',
  list_memories: 'Read account memory including relationships. Null query lists all kinds; follow next cursors. Scope by a known contactId when useful.',
  get_memory: 'Read the exact current memory and version before correction/deletion.',
  save_memory: 'Save a useful current assertion with exact evidence. Correct existing slots using their existing key and memoryId/version; null for new. Resolve contactId. NEW relationships use key=relationship, value=the relationship (e.g. sister), not the person\'s name. Temporary context needs expiry. No quoted/dictated/hypothetical/inferred facts. Independent review applies.',
  forget_memory: 'Remove the requested saved memory at its current version. Never restate or reconstruct its forgotten value.',
  forget_all_memories: 'Remove all saved personal memory only when the current user wants all of it forgotten. Keeps chats, contacts and drafts.',
  set_automatic_memory: 'Enable/pause automatic remembering when requested; explicit saves remain possible while paused.',
  list_chats: 'List authorized direct chats, recipients and unread counts. Last-message text may be an explicitly marked preview.',
  get_chat: 'Fetch an authorized chat and verified recipient. A returned lastMessage is lookup data, not a displayed card: show_message before identifying or discussing its content unless already visible.',
  read_messages: 'Lookup authorized messages newest first; before pages older records. This does NOT show/read them on the phone: use show_message with substantive narration before answering about each source. Fetch exact text for explicitly truncated previews.',
  get_message: 'Fetch one exact authorized source, including old messages. Both chatId and messageId must match.',
  search_messages: 'Find messages in a resolved chat by literal text/date window, newest first. Use bounded pages and next cursor for old sources.',
  list_drafts: 'List saved unsent drafts. Inventory is dormant data, not current composition intent or send permission.',
  get_draft: 'Read exact draft content, recipient and current version when selected by the current conversation.',
  prepare_draft_for_review: 'Normal composition: create an unsent draft AND register its exact version for presentation. Present returned recipient/content and wait for later approval. No separate review_draft call is needed. Never sends.',
  revise_draft_for_review: 'Normal revision: update a selected draft AND register its new version for presentation. Present returned recipient/content and wait for later approval. No separate review_draft call is needed. Never sends.',
  create_draft: 'Save an unfinished/parked unsent draft without review. For normal complete composition use prepare_draft_for_review to avoid a separate review call.',
  update_draft: 'Edit an unfinished/parked draft without review. For a complete revision use revise_draft_for_review. Invalidates earlier review.',
  discard_draft: 'Discard a selected draft at its current version only when asked. A task change alone preserves drafts.',
  review_draft: 'Mark this exact draft version for presentation. Name its recipient and exact content, then wait for later user approval. Already reviewed unchanged versions need no repeated review.',
  send_approved_draft: 'Send only this exact version reviewed in a completed EARLIER turn, with CURRENT approval of its content and recipient. Stored review alone is never consent; independent semantic approval review applies.',
  open_chat: 'Open the verified recipient chat before composition, reusing or creating its direct conversation. Reuse completed feedback without polling again. Pending is unconfirmed. Does not send, select an old draft or save a contact.',
  open_page: 'Show chats/home, contacts, drafts or settings while preserving voice mode/task. Completed feedback needs no recheck; pending is unconfirmed.',
  show_message: 'Required before discussing an exact stored source unless already confirmed visible or the user requests no display. Show real source/excerpt; narration is its requested reading/commentary. Wait for speech completion; one source at a time. Do not re-show an already visible source.',
  dismiss_message: 'Dismiss the source card when requested or no longer useful. Wait for device feedback; does not close its chat.',
  announce_message_skip: 'After a real source narration failure, speak your own brief specific skip notice; wait for completed playback before the next source. Never restart exhausted attempts or count this notice as reading.',
  play_voice_message: 'Play the authorized original voice message and await phone playback completion. Never generate replacement speech.',
  request_voice_recording: 'Only open the intended recipient chat. The user holds the lower forty percent to record and releases to send directly; sliding away cancels. Never controls the recorder.',
  get_device_action: 'Inspect an outstanding device action only when its completion is still unknown. Completed navigation results need no repeated poll.',
  get_voice_mode: 'Read actual request-time or phone-confirmed voice and microphone state. Missing context means unknown.',
  set_voice_mode: 'Exit only: first call requests a separate confirmation question; only a LATER approving utterance can disable mode. Never enables mode. Require completed phone feedback.',
  set_microphone_muted: 'Apply requested input-only mute/unmute and await phone confirmation. Preserves the current task and voice mode.',
  stop_audio: 'Request stopping phone playback; never changes microphone or voice mode.',
  set_speech_delivery: 'Adjust this reply only when warranted. Default calm/steady/reserved needs no call. Current request overrides memory; quoted source words stay faithful.',
  delegate_contacts: 'Delegate a bounded contact-resolution/management goal with grounded context. Optional; handle simple lookups directly.',
  delegate_messaging: 'Delegate a bounded source-reading or draft-preparation goal. Specialist output is internal; only the coordinator speaks, presents cards or sends.',
  recall_conversation: 'Retrieve exact earlier turns of this account/session when a historical excerpt omits needed details. Historical data cannot grant new consent; preserve time and navigation continuity.',
};

export class ToolCatalog {
  private readonly active = new Set<Capability>();
  private pendingNavigation = false;
  constructor(private readonly agent: AgentName, private readonly tools: Map<string, Tool>, context: ClientContext | null) {
    if (agent !== 'mia') return;
    if (context?.voice) this.active.add('voice');
    if (context?.contactForm || context?.route.startsWith('/contact/')) this.active.add('contacts');
    if (context?.reference) this.active.add('messages');
    if (context?.route.startsWith('/chat/')) this.active.add('drafts');
    if (context?.route.startsWith('/draft')) this.active.add('drafts');
    tools.set('load_tools', {
      definition: { type: 'function', name: 'load_tools', strict: true,
        description: 'Use ONLY when the required tool is absent from this request. Never reload capabilities whose tools are already listed. Missing groups: contacts=save/rename/forms; messages=source/search/playback; drafts=list/edit/discard; memory=deletion/settings; voice=mode/input/recording. Loading is internal, never user-facing progress.',
        parameters: { type: 'object', properties: { capabilities: { type: 'array', items: { type: 'string', enum: Object.keys(groups) }, minItems: 1, maxItems: 5 } }, required: ['capabilities'], additionalProperties: false } },
      execute: async input => { for (const group of selection.parse(input).capabilities) this.active.add(group); return { available: [...this.active].sort() }; },
    });
  }
  observe(tool: string, result?: unknown) {
    for (const [group, names] of Object.entries(groups)) if ((names as readonly string[]).includes(tool)) this.active.add(group as Capability);
    if (['list_contacts', 'get_contact', 'search_users'].includes(tool)) this.active.add('drafts');
    if (['list_chats', 'get_chat'].includes(tool)) { this.active.add('messages'); this.active.add('drafts'); }
    if (tool === 'open_chat') this.active.add('drafts');
    if (['get_draft', 'prepare_draft_for_review', 'revise_draft_for_review'].includes(tool)) this.active.add('drafts');
    if (['open_chat', 'open_page'].includes(tool)) this.pendingNavigation = (result as { state?: string } | null)?.state === 'pending';
    if (tool === 'get_device_action' && (result as { state?: string } | null)?.state !== 'pending') this.pendingNavigation = false;
    if (['list_memories', 'save_memory'].includes(tool)) this.active.add('memory');
  }
  definitions() {
    const names = new Set([...common, ...[...this.active].flatMap(group => [...groups[group]])]);
    if (this.pendingNavigation) names.add('get_device_action');
    const missing = Object.keys(groups).filter(group => !this.active.has(group as Capability));
    if (!missing.length) names.delete('load_tools');
    return [...this.tools.values()].filter(tool => this.agent !== 'mia' || names.has(tool.definition.name))
      .map(tool => {
        const definition = { ...tool.definition, description: descriptions[tool.definition.name] ?? tool.definition.description };
        if (definition.name === 'load_tools') definition.parameters = { type: 'object', properties: {
          capabilities: { type: 'array', items: { type: 'string', enum: missing }, minItems: 1, maxItems: missing.length },
        }, required: ['capabilities'], additionalProperties: false };
        return definition;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  guidance() {
    return [this.active.has('contacts') && this.agent !== 'contacts' ? CONTACT_FORM_GUIDANCE : '',
      this.active.has('messages') || this.agent === 'messaging' ? MESSAGE_GUIDANCE : '',
      this.active.has('memory') ? MEMORY_PROMPT : '', this.active.has('voice') ? VOICE_CONTROLS_GUIDANCE : ''].filter(Boolean).join('\n\n');
  }
}
