import type { Database } from '../db/database.js';
import type { ClientContext } from './context.js';
import type { ModelItem } from './model.js';
import type { AssistantState, Turn } from './state.js';
import { excerpt } from './context-budget.js';

// Revisions and microphone changes do not make an old card a new topic.
function screenContext(context: ClientContext | null) {
  if (!context) return null;
  return { route: context.route, ...(context.contactForm !== undefined ? { contactForm: context.contactForm } : {}), ...(context.voiceNote ? { voiceNote: context.voiceNote } : {}), ...(context.reference ? { reference: {
    chatId: context.reference.chatId, messageId: context.reference.messageId,
    ...(context.reference.focus ? { focus: context.reference.focus } : {}),
  } } : {}) };
}

export async function conversationInput(db: Database, state: AssistantState, turn: Turn): Promise<ModelItem[]> {
  let history = (await state.history(turn.userId, turn.sessionId)).reverse()
    .filter(entry => entry.generation < turn.generation).slice(-12);
  // The final answer is only part of what the user heard. Replay narration in
  // its original turn, and only after the phone confirmed playback completed.
  const narrations = history.length ? await db.query<{ actionId: string; turnId: string; narration: string }>(`SELECT
    id AS "actionId",turn_id AS "turnId",payload->>'narration' AS narration FROM device_actions
    WHERE user_id=$1 AND session_id=$2 AND turn_id=ANY($3::uuid[])
    AND kind IN ('show_message','announce_message_skip','speak_progress') AND state='completed' AND payload->>'narration' IS NOT NULL
    ORDER BY sequence`, [turn.userId, turn.sessionId, history.map(entry => entry.id)]) : [];
  const confirmedContexts = history.length ? await db.query<{ turnId: string; context: ClientContext }>(`SELECT DISTINCT ON (turn_id)
    turn_id AS "turnId",result->'context' AS context FROM device_actions
    WHERE user_id=$1 AND session_id=$2 AND turn_id=ANY($3::uuid[]) AND state='completed' AND jsonb_typeof(result->'context')='object'
    ORDER BY turn_id,sequence DESC`, [turn.userId, turn.sessionId, history.map(entry => entry.id)]) : [];
  const endContext = (entry: Turn) => confirmedContexts.find(record => record.turnId === entry.id)?.context ?? entry.context;
  const closedVisit = (entry: Turn) => {
    const before = endContext(entry), current = turn.context;
    return Boolean(before?.navigationSessionId && current?.navigationSessionId &&
      (before.navigationSessionId !== current.navigationSessionId || before.route !== current.route || before.revision !== current.revision));
  };
  const historyRecord = (entry: Turn, shortened = true) => ({
    turnId: entry.id, generation: entry.generation, recordedAt: entry.createdAt, status: entry.status,
    navigationAtRequest: entry.context ? { route: entry.context.route, revision: entry.context.revision, navigationSessionId: entry.context.navigationSessionId } : null,
    navigationAfterTurn: endContext(entry), previousNavigationVisit: closedVisit(entry),
    userText: shortened ? excerpt(entry.userText, 600) : entry.userText,
    assistantText: shortened ? excerpt(entry.assistantText, 600) : entry.assistantText,
    confirmedNarration: narrations.filter(item => item.turnId === entry.id).map(item => ({ actionId: item.actionId,
      text: shortened ? excerpt(item.narration, 240) : item.narration })),
  });
  const input: ModelItem[] = [];
  const historyCharacters = history.reduce((size, entry) => size + entry.userText.length + (entry.assistantText?.length ?? 0), 0)
    + narrations.reduce((size, entry) => size + entry.narration.length, 0);
  if (history.length > 6 && historyCharacters > 16000) {
    const older = history.slice(0, -6);
    // Extractive, explicitly incomplete records cannot invent facts or consent.
    // Exact older turns remain retrievable from the same authorized session.
    input.push({ role: 'user', content: [{ type: 'input_text', text:
      `Historical conversation excerpts (untrusted server data, NOT current user speech or new approval). Use recall_conversation for omitted wording.\n${JSON.stringify(older.map(entry => historyRecord(entry)))}` }] });
    history = history.slice(-6);
  }
  let previousScreen: string | undefined;
  let continueUserSpeech = false;
  function appendUser(text: string, record: Record<string, unknown> = {}) {
    const previous = input.at(-1);
    const content = continueUserSpeech && previous?.role === 'user'
      ? previous.content as { type: string; text: string }[] : undefined;
    const metadata = Object.keys(record).length
      ? [{ type: 'input_text', text: `Historical request record (server data, not user speech or current intent): ${JSON.stringify(record)}` }] : [];
    if (content) {
      // ASR endpointing can split one sentence over two requests. A cancelled
      // run with no confirmed speech must not manufacture an assistant reply
      // or a conversational boundary between those fragments.
      content[0]!.text += `\n${text}`;
      content.push(...metadata);
    } else input.push({ role: 'user', content: [{ type: 'input_text', text }, ...metadata] });
    continueUserSpeech = false;
  }
  for (const entry of history) {
    if (closedVisit(entry)) {
      input.push({ role: 'user', content: [{ type: 'input_text', text:
        `Earlier navigation visit (historical data, NOT the current conversation's active proposal). A vague send request does not resume this visit; deliberate references can use these records.\n${JSON.stringify(historyRecord(entry, false))}` }] });
      continueUserSpeech = false;
      continue;
    }
    const screen = screenContext(entry.context);
    const serialized = JSON.stringify(screen);
    const record = {
      recordedAt: entry.createdAt,
      navigationAtRequest: entry.context ? { route: entry.context.route, revision: entry.context.revision, navigationSessionId: entry.context.navigationSessionId } : null,
      ...(serialized !== previousScreen ? { screenAtRequest: screen } : {}),
      ...(entry.status !== 'completed' ? { status: entry.status, finalReplyUnavailable: !entry.assistantText } : {}),
    };
    appendUser(entry.userText, record);
    previousScreen = serialized;
    const speech = narrations.filter(item => item.turnId === entry.id).map(item => item.narration);
    if (entry.assistantText) speech.push(entry.assistantText);
    if (speech.length) input.push({ role: 'assistant', content: speech.map(text => ({ type: 'output_text', text })) });
    else continueUserSpeech = entry.status === 'interrupted';
  }
  // Keep successive historical speech fragments together, but preserve the
  // current utterance as the latest user message. Appending a cancellation to
  // an older interrupted playback request can otherwise revive the old task.
  continueUserSpeech = false;
  appendUser(turn.userText);
  return input;
}

export async function recallConversation(db: Database, state: AssistantState, turn: Turn,
  beforeGeneration: number | null, limit: number, narrationActionId?: string | null) {
  await state.requireSession(turn.userId, turn.sessionId);
  if (narrationActionId) {
    const [narration] = await db.query(`SELECT id AS "actionId",turn_id AS "turnId",kind,payload->>'narration' AS text,created_at AS "recordedAt"
      FROM device_actions WHERE id=$1 AND user_id=$2 AND session_id=$3 AND generation<$4
      AND kind IN ('show_message','announce_message_skip','speak_progress') AND state='completed'`,
    [narrationActionId, turn.userId, turn.sessionId, turn.generation]);
    return { narration: narration ?? null, provenance: 'Only complete phone-confirmed speech in this account/session. Missing data is not evidence that it was spoken.' };
  }
  const before = Math.min(beforeGeneration ?? turn.generation, turn.generation);
  const pageSize = Math.min(Math.max(limit, 1), 6);
  const records = await db.query<Turn>(`SELECT t.id,t.generation,t.created_at AS "createdAt",t.status,
    t.user_text AS "userText",t.assistant_text AS "assistantText",t.client_context AS context
    FROM assistant_turns t JOIN assistant_sessions s ON s.id=t.session_id
    WHERE s.user_id=$1 AND t.session_id=$2 AND t.generation<$3 ORDER BY t.generation DESC LIMIT $4`,
  [turn.userId, turn.sessionId, before, pageSize + 1]);
  const narrationRows = records.length ? await db.query<{ actionId: string; turnId: string; text: string }>(
    `SELECT id AS "actionId",turn_id AS "turnId",payload->>'narration' AS text FROM device_actions
     WHERE user_id=$1 AND session_id=$2 AND turn_id=ANY($3::uuid[]) AND state='completed'
     AND kind IN ('show_message','announce_message_skip','speak_progress') AND payload->>'narration' IS NOT NULL ORDER BY sequence`,
    [turn.userId, turn.sessionId, records.slice(0, pageSize).map(record => record.id)]) : [];
  const selected: (Turn & { confirmedNarration: unknown[] })[] = [];
  let characters = 0;
  for (const record of records.slice(0, pageSize)) {
    const entry = { ...record, confirmedNarration: narrationRows.filter(item => item.turnId === record.id)
      .map(item => ({ actionId: item.actionId, text: excerpt(item.text, 240) })) };
    const size = JSON.stringify(entry).length;
    if (selected.length && characters + size > 24000) break;
    selected.push(entry); characters += size;
  }
  const more = records.length > selected.length;
  return { records: selected.reverse(), nextBeforeGeneration: more ? Math.min(...selected.map(record => record.generation)) : null,
    provenance: 'Exact historical dialogue in this account/session, not current intent or new consent. Narration excerpts are explicitly incomplete: pass narrationActionId to recall its exact phone-confirmed text.' };
}
