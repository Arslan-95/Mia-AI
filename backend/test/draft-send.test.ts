import assert from 'node:assert/strict';
import test from 'node:test';
import { createDraftSendReviewer, draftReviewContinuity } from '../src/agents/draft-send-policy.js';
import type { ModelProvider } from '../src/agents/model.js';
import type { Turn } from '../src/agents/state.js';
import { randomUUID } from 'node:crypto';

test('draft continuity distinguishes the same visit, navigation away and back, app restart and missing evidence without an age cutoff', () => {
  const context = { route: '/chat/ben', revision: 2, navigationSessionId: randomUUID() };
  const reviewedAt = new Date(Date.now() - 27 * 3600000);
  // Real routes use UUIDs; this example intentionally tests valid context data.
  context.route = `/chat/${randomUUID()}`;
  const same = draftReviewContinuity(reviewedAt, context, context);
  assert.equal(same.navigationVisit, 'same');
  assert.ok(Math.abs(same.secondsSincePresentation! - 27 * 3600) < 2);
  assert.equal(draftReviewContinuity(reviewedAt, context, { ...context, revision: 4 }).navigationVisit, 'different');
  assert.equal(draftReviewContinuity(reviewedAt, context, { ...context, navigationSessionId: randomUUID() }).navigationVisit, 'different');
  assert.equal(draftReviewContinuity(reviewedAt, { route: context.route, revision: 2 }, context).navigationVisit, 'unknown');
  assert.equal(draftReviewContinuity(undefined, null, context).secondsSincePresentation, null);
});

test('draft send review uses real chronology and current context; rejects denied, missing, malformed or duplicate verdicts', async () => {
  const turn = { userText: 'Send a message, please.', context: { route: '/chat/ben', revision: 3 } } as Turn;
  const conversation = [{ role: 'user', content: [{ type: 'input_text', text: 'Open Ben.' }] }];
  const proposal = { text: 'An old proposal', review: { reviewedAt: '2026-10-30T17:15:16.372Z', reviewContext: { route: '/chat/ben', revision: 1 } } };
  for (const args of ['{"approved":true}', '{"approved":false}', '{"approved":"true"}', '{}', 'malformed', 'duplicate', 'missing']) {
    const provider: ModelProvider = { configured: true, async respond(request) {
      const data = JSON.parse((request.input[0]!.content as { text: string }[])[0]!.text);
      assert.equal(data.currentUtterance, turn.userText); assert.deepEqual(data.currentContext, turn.context);
      assert.deepEqual(data.proposal, proposal); assert.deepEqual(data.conversation, conversation);
      assert.ok(data.currentTime); assert.equal(request.tools[0]!.name, 'draft_send_verdict');
      const call = { callId: 'verdict', name: 'draft_send_verdict', arguments: args };
      return { output: [], text: '', calls: args === 'missing' ? [] : args === 'duplicate' ? [call, call] : [call] };
    } };
    const review = createDraftSendReviewer(provider, turn, new AbortController().signal, conversation);
    if (args === '{"approved":true}') await review(proposal);
    else await assert.rejects(review(proposal), { code: args === '{"approved":false}' ? 'DRAFT_SEND_NOT_APPROVED' : 'DRAFT_SEND_REVIEW_UNAVAILABLE' });
  }
});
