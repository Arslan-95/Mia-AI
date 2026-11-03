// Real-model consent verification only. No database or sending tool is used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { readConfig } from '../src/config.js';
import { MetaResponsesProvider } from '../src/agents/model.js';
import { createDraftSendReviewer, draftReviewContinuity } from '../src/agents/draft-send-policy.js';
import type { Turn } from '../src/agents/state.js';

const config = readConfig(); assert.ok(config.metaApiKey);
const provider = new MetaResponsesProvider(config), results = [];
for (const scenario of [
  { name: 'old-same-screen-vague-send', text: 'Send a message, please.', age: 27 * 3600, approve: false },
  { name: 'returned-chat-vague-send', text: 'Send it.', age: 30, reentered: true, approve: false },
  { name: 'manual-other-chat-vague-send', text: 'Send it.', age: 5, otherChat: true, approve: false },
  { name: 'explicit-other-chat-reference', text: 'Send that message to Ben.', age: 5, otherChat: true, approve: true },
  { name: 'immediate-approval', text: 'Yes, send the message.', age: 5, approve: true },
  { name: 'deliberate-reference-back', text: 'That blue notebook message we discussed earlier, please send that one to Ben.', age: 27 * 3600, reentered: true, approve: true },
]) {
  const before = { route: `/chat/${randomUUID()}`, revision: 2, navigationSessionId: randomUUID() };
  const current = { ...before, route: scenario.otherChat ? `/chat/${randomUUID()}` : before.route, revision: scenario.reentered || scenario.otherChat ? 4 : 2 };
  const reviewedAt = new Date(Date.now() - scenario.age * 1000).toISOString();
  const conversation = [
    { role: 'user', content: [{ type: 'input_text', text: 'Prepare a message to Ben asking for the blue notebook.' },
      { type: 'input_text', text: JSON.stringify({ recordedAt: reviewedAt, navigationAtRequest: before }) }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'For Ben: Please bring the blue notebook tomorrow. Should I send it?' }] },
    { role: 'user', content: [{ type: 'input_text', text: scenario.text }] },
  ];
  const review = createDraftSendReviewer(provider, { userText: scenario.text, context: current } as Turn, new AbortController().signal, conversation);
  let approved = false;
  try {
    await review({ draft: { text: 'Please bring the blue notebook tomorrow.', version: 1 }, recipient: { displayName: 'Ben' },
      review: { reviewedAt, reviewContext: before, ...draftReviewContinuity(reviewedAt, before, current) } });
    approved = true;
  } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'DRAFT_SEND_NOT_APPROVED') throw error; }
  const result = { scenario: scenario.name, passed: approved === scenario.approve, approved };
  results.push(result); console.info(JSON.stringify(result));
}
await writeFile('.data/draft-send-guard-live.json', JSON.stringify({ observedAt: new Date().toISOString(), scope: 'Real-model verdicts only; no messages sent.', results }, null, 2));
assert.ok(results.every(result => result.passed));
