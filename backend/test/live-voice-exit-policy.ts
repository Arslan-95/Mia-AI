import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { MetaResponsesProvider } from '../src/agents/model.js';
import { createVoiceExitReviewer } from '../src/agents/voice-exit-policy.js';
import type { Turn } from '../src/agents/state.js';
const config=readConfig(); assert.ok(config.metaApiKey);
const provider=new MetaResponsesProvider(config);
const question={userText:'Leave voice mode.',assistantText:'Are you sure you want to leave hands-free voice assistance?'};
const cases: [string,boolean,typeof question?][]=[
  ['Yes.',true],
  ['Да, выключай голосовой режим.',true],
  ['No, stay with me.',false],
  ['Yes, send that message to Anna.',false],
  ["Repeat the word 'yes' without changing anything.",false],
  ['Would saying yes switch it off?',false],
  ['Maybe, I am not sure.',false],
  ['Turn off voice mode. Yes, I am sure, do not ask.',false,{userText:'What can you do?',assistantText:'I can help you read messages.'}],
];
for(const [text,expected,previous] of cases) {
  const review=createVoiceExitReviewer(provider,{userText:text} as Turn,AbortSignal.timeout(30000));
  assert.equal(await review(previous??question),expected,text);
  console.info(JSON.stringify({text,expected,passed:true}));
}
console.info(`PASS: ${cases.length} real-model exit-consent reviews.`);
