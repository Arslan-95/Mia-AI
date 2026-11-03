import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceExcerpt, referenceKey } from '../src/messageReference';
import { sameContext } from '../src/navigationContext';
test('long source excerpts remain exact and explicit, keeping emoji graphemes intact', () => {
  const text = 'Hello 👩‍💻 café and family 👨‍👩‍👧‍👦. '.repeat(80);
  for (const budget of [0, 5, 8, 10, 20, 150, 800]) {
    const result = sourceExcerpt(text, undefined, budget);
    assert.equal(result.text, text.slice(result.start, result.end)); assert.equal(result.partial, true);
    assert.ok(result.end <= budget);
    const boundaries = new Set([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(s => s.index));
    assert.ok(boundaries.has(result.end));
  }
  assert.deepEqual(sourceExcerpt('Exact source.', undefined, 100), { text: 'Exact source.', start: 0, end: 13, partial: false, total: 13 });
  assert.equal(sourceExcerpt('First. Second sentence. Last.', { start: 7, end: 23 }, 100).text, 'Second sentence.');
});
test('request identity includes visible source, fragment and revision', () => {
  const a = { route: '/chat/one', revision: 1, reference: { chatId: 'one', messageId: 'old', revision: 4, focus: { start: 2, end: 8 } } };
  assert.equal(sameContext(a, structuredClone(a)), true);
  assert.equal(sameContext(a, { ...a, reference: { ...a.reference, messageId: 'other' } }), false);
  assert.equal(sameContext(a, { ...a, reference: { ...a.reference, focus: { start: 8, end: 12 } } }), false);
  assert.equal(referenceKey(null), null);
});
test('the Hermes fallback keeps combining and joined emoji intact without Intl.Segmenter', () => {
  const original = Intl.Segmenter;
  const text = 'A 👩‍💻 café 🇬🇪 👍🏽 family 👨‍👩‍👧‍👦.';
  const expected = new Set([...new original(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.index)); expected.add(text.length);
  try {
    Object.defineProperty(Intl, 'Segmenter', { configurable: true, writable: true, value: undefined });
    for (let budget = 0; budget <= text.length; budget++) assert.ok(expected.has(sourceExcerpt(text, undefined, budget).end));
  } finally { Object.defineProperty(Intl, 'Segmenter', { configurable: true, writable: true, value: original }); }
});
