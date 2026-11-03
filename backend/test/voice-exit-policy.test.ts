import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceExitReviewer } from '../src/agents/voice-exit-policy.js';
import type { Turn } from '../src/agents/state.js';

test('exit consent review fails closed on missing, malformed or duplicate verdicts and honors a semantic denial', async () => {
  const turn = { userText: 'Yes, send the message.' } as Turn;
  const question = { userText: 'Leave voice mode.', assistantText: 'Are you sure you want to leave voice mode?' };
  for (const calls of [[], [{name:'wrong',arguments:'{"approved":true}'}], [{name:'voice_exit_verdict',arguments:'{}'}],
    [{name:'voice_exit_verdict',arguments:'{"approved":true}'},{name:'voice_exit_verdict',arguments:'{"approved":true}'}]]) {
    const review = createVoiceExitReviewer({configured:true,respond:async()=>({text:'',calls:calls as any,output:[]})},turn,new AbortController().signal);
    await assert.rejects(review(question), {code:'VOICE_EXIT_REVIEW_UNAVAILABLE'});
  }
  const review = createVoiceExitReviewer({configured:true,respond:async request=>{
    assert.ok(JSON.stringify(request.input).includes(turn.userText));
    return {text:'',calls:[{name:'voice_exit_verdict',arguments:'{"approved":false}',callId:'verdict'}],output:[]};
  }},turn,new AbortController().signal);
  assert.equal(await review(question),false);
});
