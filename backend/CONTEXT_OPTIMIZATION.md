# Context and latency

Mia keeps the same model, low reasoning setting, conversational voice and
model-authored progress narration. This change reduces what is sent to the
model and how often routine workflows need to call it.

## Context assembly

Shared instructions define the conversational and consent contracts once.
Task-specific guidance is loaded with its tools. A stable common tool catalog
contains ordinary lookups, composition, memory saving and conversation recall.
Voice tools follow actual reported voice context; a visible source enables
source tools; a draft/chat context enables draft editing. Further tool sets are
chosen by the model through `load_tools` or become available after relevant
lookups. This is state-based availability, not a keyword intent classifier.
Already loaded groups are excluded from the loader schema. Specialist tool
permissions remain separate; hiding a definition is not an access-control gate.

Tool descriptions are concise, but complete parameter schemas and server-side
authorization, generation fencing and consent review remain in place. Bulk
message lists have explicitly marked text previews with original IDs and a path
to exact text. `get_message`, exact drafts and approval evidence are not shortened.
Device-action snapshots shorten redundant long narration, not completion state
or presentation evidence. Memory context omits redundant provenance metadata;
exact records and all persistent knowledge remain in storage.
Only the latest continuously discussed reviewed draft or an explicitly visible
draft is preloaded as active. A small dormant ID/recipient index and historical
review evidence allow deliberate recovery without repeating approval. Neither
is current intent. Time/navigation evidence accompanies proposals; preloading
never grants consent. The original detailed recipient/approval contract remains
while its repeated copy in tool descriptions is removed.

Short dialogue is retained in full. When more than six historical turns exceed
16,000 characters, older turns become labeled extractive excerpts with original
generation, timestamp, navigation visit and completion state. The newest six
turns and the current utterance remain exact, including interrupted speech and
confirmed narration. Excerpts are historical data, never newly inferred consent.
Turns from a verifiably different navigation visit are also historical records,
rather than replayed as an adjacent live assistant question. Confirmed device
navigation at the end of a turn is accounted for, so opening a chat inside an
ongoing conversation does not break that conversation's proposal. Legacy
contexts without navigation session identifiers remain unclassified.
`recall_conversation` pages exact earlier records in the same authorized account
and session. A narration action ID retrieves its exact text only if the phone
confirmed complete playback. Nothing is deleted or summarized back into storage.
Current-loop encrypted reasoning and function-call/result pairing remain intact.

## Fewer model round trips

Contact search already returns verified identity and phone fields, so an
unambiguous result can be reused directly. Navigation tools wait up to eight
seconds for real phone feedback when request context is present, while optional
progress speech runs independently. A completed result needs no separate model
poll. Failure, timeout and cancellation never become invented success.

`prepare_draft_for_review` and `revise_draft_for_review` atomically prepare the
exact version and register it for presentation. The model still presents the
recipient and exact content in its own words and waits for a later user turn.
Sending still requires an earlier completed review of that exact version plus
the independent current-consent check. Separate unfinished-draft tools remain
available, and revisions invalidate old approval.

## Cache and measurements

Stable public instructions/tool definitions precede account context, action
state and timestamps. Definition order is deterministic. Meta requests include
the documented `prompt_cache_key` and retention hint, defaulting to `in_memory`.
The key hashes only the public prefix and schemas. `META_PROMPT_CACHE=off`
disables explicit hints; `24h` is an opt-in retention hint. Provider retention and
hits are not guaranteed; inspect actual cached-token usage.

The application logs model duration, input/tool/instruction character counts,
input/output/reasoning/cached tokens and turn/role identifiers to its structured
log and `.data/agent-metrics.ndjson`. It does not log prompts, message text,
credentials or encrypted reasoning. Metrics failures cannot fail a conversation.
Per-step `agent.model_completed` events also make coordinator timing available
alongside tool events. Policy reviewer requests carry their turn/role trace.

## Validation

```sh
npm run check
npm run test:postgres
npm run bench:context
npm run test:progress:live
node --env-file-if-exists=.env --import tsx test/live-history-recall.ts
```

`bench:context` runs two identical fictional conversations (greeting, phone
lookup, unsent draft, revision, later approval), using the real configured model
and an isolated local schema. Phone feedback is simulated and TTS is excluded
from its timings. The JSON report contains a source fingerprint, duration,
tokens, cache hits, call counts and explicit quality checks for each scenario.
Use `MIA_BENCHMARK_BACKEND` to point at an archived backend snapshot and
`MIA_BENCHMARK_OUTPUT` to save a separate baseline. Run variants serially to
avoid competing API traffic. These are small-sample measurements, not a load test.

### Observed A/B result, 2026-11-02

Baseline: `dd2ff85`. Same configured `muse-spark-1.3` provider, two repetitions
per scenario, variants run serially with isolated fictional accounts. Arithmetic
mean backend turn duration (includes model, tools and simulated phone ACK;
excludes TTS, microphone recognition and physical phone/network playback):

| Scenario | Baseline | Optimized | Model calls before → after |
| --- | ---: | ---: | ---: |
| Greeting | 2.31 s | 1.10 s | 1 → 1 |
| Contact phone lookup | 4.63 s | 3.06 s | 2 → 2 |
| Open chat + prepare unsent draft | 10.91 s | 7.96 s | 6–7 → 4 |
| Revise unsent draft | 7.56 s | 6.69 s | 4 → 3 |
| Approve and send | 6.98 s | 5.13 s | 3 → 3 |

All ten quality checks passed in each variant. The optimized first greeting
request used about 7,689 input tokens versus 16,987 (55% fewer). Summed input
tokens for draft preparation fell from 118,363 to 40,524 (66% fewer). Real
responses reported cache hits; this was not inferred from a configured hint.
The unchanged three calls on approval include the independent consent reviewer.
Timing varies with provider latency; two samples do not establish a production
percentile or a guaranteed speedup.

Local raw reports: `.data/context-benchmark-before.json` and
`.data/context-benchmark.json`. Optimized source fingerprint:
`aa7ffce79bdaa6a01ddef090bd9bec394aeaf9b16bc255f0092a6da64246b52a`.

The existing real-model regressions cover corrections, passive cards, old
drafts, contact forms, memory, delivery, reading failures and voice controls.
Their simulated phones skip optional status audio; the separate progress test
uses real TTS and writes an audition WAV. Physical iPhone playback is a separate
manual check.

Verified on local PostgreSQL: 134 automated tests, TypeScript check and build.
Real-provider checks include 10 draft-intent cases, 17 voice-control exchanges,
7 conversation regressions, 16 memory cases, 12 contact-continuity cases,
15 speech-delivery cases, reading recovery and retrieval of exact words omitted
from a long-history excerpt. The progress-narration check also synthesizes real
audio while the draft remains unsent. These are fixture accounts, not real-user
messages. They do not replace a physical phone playback check.

Provider reference: [Meta prompt caching](https://dev.meta.ai/docs/cookbook/prompt-caching)
and [stateless reasoning replay](https://dev.meta.ai/docs/protocols/responses).
