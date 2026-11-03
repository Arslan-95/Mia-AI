// Real model and TTS, isolated fictional users, simulated phone acknowledgements.
// This checks generated words and concurrency; listen to the WAV to assess delivery.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.js';
import { MetaResponsesProvider, type ModelProvider } from '../src/agents/model.js';
import { AssistantRuntime } from '../src/agents/runtime.js';
import { CloudSpeechProvider } from '../src/speech/providers.js';
import { MessagingService } from '../src/messaging.js';
import type { ClientContext } from '../src/agents/context.js';
import { testDatabase } from './helpers.js';

const config = readConfig();
assert.ok(config.metaApiKey, 'Configure META_API_KEY for the live test.');
delete process.env.TEST_DATABASE_URL; // Always use an isolated in-memory database.
const db = await testDatabase(), live = new MetaResponsesProvider(config), speech = new CloudSpeechProvider(config);
const modelCalls: { ms: number; tools: string[]; text: string }[] = [];
const provider: ModelProvider = { configured: true, async respond(request) {
  const start = performance.now(), result = await live.respond(request);
  modelCalls.push({ ms: Math.round(performance.now() - start), tools: result.calls.map(call => call.name), text: result.text });
  return result;
} };
const runtime = new AssistantRuntime(db, provider), messaging = new MessagingService(db);
const owner = randomUUID(), ben = randomUUID();
for (const [id, name, phone] of [[owner, 'Progress QA', '+15550009701'], [ben, 'Ben Demo', '+15550009702']]) await db.query(
  "INSERT INTO users(id,email,username,display_name,password_hash,phone_number) VALUES ($1,$2,$3,$4,'unused',$5)",
  [id, `${id}@example.test`, `qa_${id!.slice(0, 8)}`, name, phone]);
await messaging.addContact(owner, ben, 'Ben Demo');
const session = await runtime.state.session(owner);
let context: ClientContext = { route: '/chats', revision: 1, voice: { enabled: true, microphoneMuted: false, revision: 1 } };
const seen = new Set<string>(), narrationJobs = new Set<Promise<void>>();
const updates: { text: string; state: string; pcm?: Buffer }[] = [];
let active: AbortController | undefined, polling = false;
const failures: string[] = [];
const timer = setInterval(() => {
  if (polling) return;
  polling = true;
  void (async () => {
    const actions = await db.query<{ id: string; turnId: string; kind: string; payload: { narration?: string; chatId?: string } }>(
      `SELECT id,turn_id AS "turnId",kind,payload FROM device_actions WHERE user_id=$1 AND state='pending' ORDER BY sequence`, [owner]);
    for (const action of actions) {
      if (seen.has(action.id)) continue;
      seen.add(action.id);
      if (action.kind === 'speak_progress') {
        const update = { text: action.payload.narration!, state: 'pending' } as typeof updates[number]; updates.push(update);
        if (active && !active.signal.aborted) {
          update.state = 'skipped';
          await runtime.state.acknowledgeAction(owner, action.id, false, { code: 'ACTION_CANCELLED', stage: 'narration', context });
          continue;
        }
        const controller = active = new AbortController();
        const work = (async () => {
          try {
            const segment = await runtime.state.actionSpeech(owner, session.id, action.turnId, action.id);
            const pcm: Buffer[] = [];
            for await (const bytes of speech.synthesize(segment.text, controller.signal, { delivery: segment.delivery })) {
              controller.signal.throwIfAborted();
              if ((await runtime.state.turn(owner, session.id, action.turnId)).status !== 'running') { controller.abort(); break; }
              pcm.push(Buffer.from(bytes));
            }
            controller.signal.throwIfAborted();
            assert.ok(pcm.length, 'Progress synthesis returned no audio.');
            update.pcm = Buffer.concat(pcm); update.state = 'synthesized';
            // A simulated phone confirms this complete segment, never partial audio.
            await runtime.state.acknowledgeAction(owner, action.id, true, { context });
          } catch (error) {
            update.state = controller.signal.aborted ? 'cancelled' : 'failed';
            if (!controller.signal.aborted) failures.push(error instanceof Error ? error.message : 'Narration failed');
            await runtime.state.acknowledgeAction(owner, action.id, false, { code: 'ACTION_CANCELLED', stage: 'narration', context }).catch(() => {});
          } finally { if (active === controller) active = undefined; }
        })();
        narrationJobs.add(work); void work.finally(() => narrationJobs.delete(work));
      } else if (action.kind === 'open_chat') {
        assert.ok(action.payload.chatId);
        const chat = await messaging.chat(owner, action.payload.chatId);
        assert.equal(chat.recipient.id, ben);
        context = { ...context, route: `/chat/${action.payload.chatId}`, revision: context.revision + 1 };
        await runtime.state.acknowledgeAction(owner, action.id, true, { context });
      } else throw new Error(`Unexpected action in this fixture: ${action.kind}`);
    }
  })().catch(error => failures.push(String(error))).finally(() => { polling = false; });
}, 30);
runtime.start();
try {
  const { turn: accepted } = await runtime.submit(owner, session.id, randomUUID(),
    'Find Ben Demo and open his chat. Prepare an unsent text draft telling him I will be ten minutes late. Keep me posted as you work, but do not send the message.', undefined, context);
  const deadline = Date.now() + 180000;
  let turn = accepted;
  while (turn.status === 'queued' || turn.status === 'running') {
    if (Date.now() > deadline) throw new Error('Live narration test timed out.');
    await delay(30); turn = await runtime.state.turn(owner, session.id, accepted.id);
  }
  active?.abort(); await Promise.all(narrationJobs);
  assert.equal(turn.status, 'completed');
  assert.ok(updates.length > 0 && updates.length <= 3, 'The model must choose bounded progress wording for this explicit request.');
  assert.equal(failures.length, 0, failures.join('\n'));
  assert.equal((await messaging.drafts(owner)).length, 1);
  const [messages] = await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM messages');
  assert.equal(messages!.count, 0, 'The draft must remain unsent.');
  const events = await db.query<{ id: string; type: string; payload: { kind?: string; tool?: string } }>(
    'SELECT id::text,type,payload FROM events WHERE user_id=$1 ORDER BY id', [owner]);
  const firstProgress = events.findIndex(event => event.payload.kind === 'speak_progress');
  assert.ok(events.some((event, index) => index > firstProgress && event.type === 'agent.tool_completed'));
  const sample: Buffer[] = [];
  for (const update of updates) {
    if (update.pcm) sample.push(update.pcm, Buffer.alloc(12000));
  }
  for await (const bytes of speech.synthesize(turn.assistantText!, AbortSignal.timeout(95000), { delivery: turn.speechDelivery })) sample.push(Buffer.from(bytes));
  const pcm = Buffer.concat(sample), wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  await mkdir('.data', { recursive: true });
  const report = { model: config.metaModel, tts: config.googleTtsModel, modelCalls, updates: updates.map(({ text, state }) => ({ text, state })),
    finalReply: turn.assistantText, unsentDrafts: 1, sentMessages: 0, note: 'Simulated client; WAV joins completed generated segments with short gaps, not original timing.' };
  await writeFile('.data/progress-narration-sample.wav', wav);
  await writeFile('.data/progress-narration-live.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearInterval(timer); active?.abort();
  while (polling) await delay(5);
  await Promise.all(narrationJobs); await runtime.close(); await db.close();
}
