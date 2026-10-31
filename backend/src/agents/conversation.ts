import type { Database } from '../db/database.js';
import type { ClientContext } from './context.js';
import type { ModelItem } from './model.js';
import type { AssistantState, Turn } from './state.js';

// Revisions and microphone changes do not make an old card a new topic.
function screenContext(context: ClientContext | null) {
  if (!context) return null;
  return { route: context.route, ...(context.voiceNote ? { voiceNote: context.voiceNote } : {}), ...(context.reference ? { reference: {
    chatId: context.reference.chatId, messageId: context.reference.messageId,
    ...(context.reference.focus ? { focus: context.reference.focus } : {}),
  } } : {}) };
}

export async function conversationInput(db: Database, state: AssistantState, turn: Turn): Promise<ModelItem[]> {
  const history = (await state.history(turn.userId, turn.sessionId)).reverse()
    .filter(entry => entry.generation < turn.generation).slice(-12);
  // The final answer is only part of what the user heard. Replay narration in
  // its original turn, and only after the phone confirmed playback completed.
  const narrations = history.length ? await db.query<{ turnId: string; narration: string }>(`SELECT
    turn_id AS "turnId",payload->>'narration' AS narration FROM device_actions
    WHERE user_id=$1 AND session_id=$2 AND turn_id=ANY($3::uuid[])
    AND kind IN ('show_message','announce_message_skip') AND state='completed' AND payload->>'narration' IS NOT NULL
    ORDER BY sequence`, [turn.userId, turn.sessionId, history.map(entry => entry.id)]) : [];
  const input: ModelItem[] = [];
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
    const screen = screenContext(entry.context);
    const serialized = JSON.stringify(screen);
    const record = {
      ...(serialized !== previousScreen ? { screenAtRequest: screen } : {}),
      ...(entry.status !== 'completed' ? { status: entry.status, finalReplyUnavailable: !entry.assistantText } : {}),
    };
    appendUser(entry.userText.slice(0, 4000), record);
    previousScreen = serialized;
    const speech = narrations.filter(item => item.turnId === entry.id).map(item => item.narration.slice(0, 1800));
    if (entry.assistantText) speech.push(entry.assistantText.slice(0, 4000));
    if (speech.length) input.push({ role: 'assistant', content: speech.map(text => ({ type: 'output_text', text })) });
    else continueUserSpeech = entry.status === 'interrupted';
  }
  appendUser(turn.userText);
  return input;
}
