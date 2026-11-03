# Mia account memory

Long-term memory is PostgreSQL-backed account data, independent of the last 12
conversation turns and of a particular runtime process. The model decides by
meaning when a current utterance asserts a useful fact, corrects one, requests
forgetting, or changes the automatic-learning preference. There is no utterance
keyword router and no model-weight training step.

## Behavior

- Clear casual assertions may be saved automatically. Examples such as “People
  call me Arslan” and “Anna is my sister” do not require a remember command.
- Facts have an identity/preference/relationship/context kind and a stable
  semantic key. Corrections use the existing memory ID and version.
- Relationships refer to an owned contact ID. The current contact label is
  joined at read time, so a rename does not invent a person or change kinship.
- `rename_contact` changes the messenger label only. `add_contact` cannot be
  used to overwrite an existing contact label from the agent.
- Quoted/dictated message text, hypotheticals and other people's tool data are
  not assertions about the user. Stored preferences do not authorize sending.
- Automatic learning may be paused/resumed conversationally. Explicit requests
  to save a supported fact remain possible while automatic learning is paused.
- The user can ask what is remembered, correct a fact, forget one, or forget
  everything. Forgetting memory does not delete contacts, messages, drafts or
  conversation history. Deleted-slot metadata contains no saved value and tells
  the agent not to reconstruct that fact from earlier conversation.
- Temporary context requires an expiry; expired facts are hidden immediately
  and pruned when another memory is saved.

## Integration and invariants

`AgentMemory` owns persistence. `toolsFor` exposes read tools to specialists and
memory mutations only to the coordinator. Each proposed memory mutation and
contact rename receives a separate semantic model review against the original
current user utterance. Same-name contacts are provided to that review to catch
unresolved ambiguity. Review responses are structured and validated; rejection
or malformed output cannot produce a mutation.

Every save quotes evidence from the current owner utterance. Evidence is kept
for provenance but not re-injected as memory content. Mutations run inside the
existing turn-generation guard and account lock. Foreign contacts/memories and
stale versions are rejected. Aborted or superseded reviews cannot write later.

Before every coordinator model step, core memories are refreshed, including
after save/forget in the same loop. Up to 32 core/recent memories are supplied;
`list_memories` provides account-scoped pagination and optional literal search.
Semantic interpretation belongs to the model; a literal search miss is not
proof the memory is absent. The account cap is 1000 saved records.

Provider adaptation converts string `"null"` to JSON null only in fields whose
declared tool schema allows null. It does not alter ordinary message/value
strings. Tool argument errors report field paths so the model can correct them.

## Deployment and verification

Run `npm run db:migrate` before starting an updated backend. Migrations 005/006
create the memory tables and preserve memory when source conversation rows are
deleted. No frontend/native dependency or iOS permission changes are required.

- `npm run check`
- `npm test`
- `npm run test:postgres`
- `npm run build`

`npm run test:memory:live` is an opt-in acceptance suite using the configured
real Meta model and PostgreSQL. It makes provider calls and creates a disposable
database schema; it never operates on the owner's account. It checks 16 full
conversational cases and 14 independent semantic-review cases, saving synthetic
results under `.data/`. The schema is dropped in cleanup. Do not run it as part
of the default offline test suite.

`test/memory.test.ts` covers ownership, provenance, version conflicts, expiry and
renewal, deletion, rename identity, learning controls, cancelled writes,
provider scalar adaptation and recall beyond history after runtime restart.
Real-model acceptance additionally needs natural conversations exercising
implicit learning, examples/dictation, corrections, rename, recall and forgetting;
mock planner tests alone do not establish those semantic decisions.
