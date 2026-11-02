type Data = Record<string, unknown>;

function messagePreview(value: unknown, maximum = 600): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Data;
  if (typeof record.text !== 'string' || record.text.length <= maximum) return value;
  return { ...record, text: record.text.slice(0, maximum), textTruncated: true, textLength: record.text.length,
    retrieveExactText: 'get_message with this record\'s chatId and id before quoting or reading omitted text' };
}

// Only list previews are shortened. Individual source text, draft versions,
// recipients, approval evidence and encrypted reasoning are kept intact.
export function compactToolResult(tool: string, result: unknown): unknown {
  if (['read_messages', 'search_messages'].includes(tool)) {
    if (Array.isArray(result)) return result.map(item => messagePreview(item));
    if (result && typeof result === 'object') {
      const record = result as Data;
      if (Array.isArray(record.messages)) return { ...record, messages: record.messages.map(item => messagePreview(item)) };
    }
  }
  if (tool === 'list_chats' && Array.isArray(result)) return result.map(item => {
    if (!item || typeof item !== 'object') return item;
    const record = item as Data;
    return { ...record, lastMessage: messagePreview(record.lastMessage, 240) };
  });
  return result;
}

export function compactDeviceAction(record: Data) {
  const payload = record.payload as Data | null;
  if (!payload || typeof payload.narration !== 'string' || payload.narration.length <= 240) return record;
  return { ...record, payload: { ...payload, narration: payload.narration.slice(0, 240), narrationTruncated: true } };
}

export function excerpt(text: string | null, maximum: number) {
  if (!text || text.length <= maximum) return text;
  return { excerpt: text.slice(0, maximum), omittedCharacters: text.length - maximum };
}
