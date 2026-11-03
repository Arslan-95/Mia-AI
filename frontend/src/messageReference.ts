import type { MessageReference } from './types';
export function referenceKey(value: MessageReference | null) {
  return value ? `${value.chatId}/${value.messageId}/${value.focus?.start ?? 0}/${value.focus?.end ?? value.source.text?.length ?? 0}` : null;
}
export function referenceDate(date: string) {
  return new Date(date).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function referenceDirection(value: MessageReference, userId: string) {
  return value.source.senderId === userId ? `You → ${value.recipient.displayName}` : `From ${value.recipient.displayName}`;
}
/** Exact UTF-16 source slice, ending at a word/grapheme boundary. */
export function sourceExcerpt(text: string, focus: { start: number; end: number } | undefined, maximum: number) {
  const requestedStart = focus?.start ?? 0, requestedEnd = focus?.end ?? text.length;
  const boundaries: number[] = [0];
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    for (const item of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) boundaries.push(item.index);
  } else {
    // Hermes versions without Segmenter still keep combining marks, emoji
    // modifiers, joined emoji, flag pairs and CRLF together.
    let index = 0, previous = '', regionalCount = 0;
    for (const char of text) {
      const code = char.codePointAt(0)!;
      const regional = code >= 0x1f1e6 && code <= 0x1f1ff;
      const attached = /\p{Mark}/u.test(char) || code === 0x200d || previous === '\u200d' || code === 0xfe0f || code === 0xfe0e
        || code >= 0x1f3fb && code <= 0x1f3ff || code >= 0xe0020 && code <= 0xe007f
        || regional && regionalCount % 2 === 1 || char === '\n' && previous === '\r';
      if (!attached) boundaries.push(index);
      regionalCount = regional ? regionalCount + 1 : 0;
      index += char.length; previous = char;
    }
  }
  boundaries.push(text.length);
  const start = boundaries.find(index => index >= requestedStart) ?? text.length;
  let end = boundaries.filter(index => index <= Math.min(requestedEnd, start + Math.max(0, maximum))).at(-1) ?? start;
  if (end < requestedEnd) {
    const piece = text.slice(start, end), word = Math.max(piece.lastIndexOf(' '), piece.lastIndexOf('\n'));
    if (word > piece.length * .55) end = start + word;
  }
  return { text: text.slice(start, end), start, end, partial: start > 0 || end < text.length, total: text.length };
}
