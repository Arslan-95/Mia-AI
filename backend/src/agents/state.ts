import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '../db/database.js';
import { AppError, conflict, notFound, throwIfAborted } from '../errors.js';
import { publish } from '../events.js';
import { assertContextAccess, clientContextSchema, deviceResultSchema, sameContext, type ClientContext } from './context.js';
import { speechDeliverySchema, defaultSpeechDelivery, type SpeechDelivery } from '../speech/delivery.js';

export type Session = { id: string; userId: string; generation: number; activeChatId: string | null };
export type Turn = { id: string; sessionId: string; userId: string; generation: number; userText: string;
  status: 'queued' | 'running' | 'completed' | 'interrupted' | 'failed'; assistantText: string | null; clientTurnId: string; context: ClientContext | null; speechDelivery?: SpeechDelivery | null };
export type DeviceAction = { id: string; kind: string; payload: unknown; state: string; result: unknown };
const sessionColumns = 'id,user_id AS "userId",generation,active_chat_id AS "activeChatId"';
const turnColumns = 't.id,t.session_id AS "sessionId",s.user_id AS "userId",t.generation,t.user_text AS "userText",t.status,t.assistant_text AS "assistantText",t.client_turn_id AS "clientTurnId",t.client_context AS context,t.speech_delivery AS "speechDelivery"';

export class AssistantState {
  constructor(readonly db: Database) {}

  async session(userId: string) {
    const [session] = await this.db.query<Session>(`INSERT INTO assistant_sessions(id,user_id) VALUES ($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET updated_at = now() RETURNING ${sessionColumns}`, [randomUUID(), userId]);
    return session!;
  }

  async requireSession(userId: string, sessionId: string, sql: Sql = this.db, lock = false) {
    const [session] = await sql.query<Session>(`SELECT ${sessionColumns} FROM assistant_sessions
      WHERE id = $1 AND user_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [sessionId, userId]);
    if (!session) throw notFound();
    return session;
  }

  async accept(userId: string, sessionId: string, clientTurnId: string, text: string, signal?: AbortSignal, context?: ClientContext) {
    const snapshot = context ? clientContextSchema.parse(context) : null;
    return this.db.transaction(async (sql) => {
      const session = await this.requireSession(userId, sessionId, sql, true);
      throwIfAborted(signal);
      await assertContextAccess(sql, userId, snapshot);
      const [existing] = await sql.query<Turn>(`SELECT ${turnColumns} FROM assistant_turns t
        JOIN assistant_sessions s ON s.id = t.session_id WHERE t.session_id = $1 AND t.client_turn_id = $2`, [sessionId, clientTurnId]);
      if (existing) {
        if (existing.userText !== text || !sameContext(existing.context, snapshot)) throw conflict('This turn ID was used with different content or context.');
        return { turn: existing, duplicate: true };
      }
      const [recent] = await sql.query<{ count: number }>(`SELECT count(*)::integer AS count FROM assistant_turns
        WHERE session_id = $1 AND created_at > now() - interval '1 minute'`, [sessionId]);
      if (recent!.count >= 20) throw new AppError(429, 'TURN_RATE_LIMIT', 'Please wait a moment before asking again.');
      throwIfAborted(signal);
      const generation = session.generation + 1;
      await sql.query('UPDATE assistant_sessions SET generation = $2,updated_at = now() WHERE id = $1', [sessionId, generation]);
      const interrupted = await sql.query<{ id: string }>(`UPDATE assistant_turns SET status = 'interrupted',completed_at = now()
        WHERE session_id = $1 AND status IN ('queued','running') RETURNING id`, [sessionId]);
      for (const previous of interrupted) await publish(sql, userId, 'assistant.interrupted', { sessionId, turnId: previous.id });
      const actions = await sql.query<{ id: string }>(`UPDATE device_actions SET state = 'cancelled'
        WHERE session_id = $1 AND state = 'pending' RETURNING id`, [sessionId]);
      for (const action of actions) await publish(sql, userId, 'device.action_cancelled', { actionId: action.id, sessionId });
      const id = randomUUID();
      await sql.query(`INSERT INTO assistant_turns(id,session_id,client_turn_id,generation,user_text,client_context) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [id, sessionId, clientTurnId, generation, text, snapshot ? JSON.stringify(snapshot) : null]);
      const turn: Turn = { id, sessionId, userId, generation, userText: text, status: 'queued', assistantText: null, clientTurnId, context: snapshot };
      await publish(sql, userId, 'assistant.accepted', { sessionId, turnId: id, clientTurnId });
      return { turn, duplicate: false };
    });
  }

  async interrupt(userId: string, sessionId: string, signal?: AbortSignal, reason: 'user' | 'speech' = 'user') {
    return this.db.transaction(async (sql) => {
      await this.requireSession(userId, sessionId, sql, true);
      throwIfAborted(signal);
      const [session] = await sql.query<{ generation: number }>(`UPDATE assistant_sessions SET generation = generation + 1,
        updated_at = now() WHERE id = $1 RETURNING generation`, [sessionId]);
      const turns = await sql.query<{ id: string }>(`UPDATE assistant_turns SET status = 'interrupted',completed_at = now()
        WHERE session_id = $1 AND status IN ('queued','running') RETURNING id`, [sessionId]);
      for (const turn of turns) await publish(sql, userId, 'assistant.interrupted', { sessionId, turnId: turn.id });
      const actions = await sql.query<{ id: string }>(`UPDATE device_actions SET state = 'cancelled'
        WHERE session_id = $1 AND state = 'pending' RETURNING id`, [sessionId]);
      for (const action of actions) await publish(sql, userId, 'device.action_cancelled', { sessionId, actionId: action.id });
      await publish(sql, userId, 'assistant.audio_cancelled', { sessionId });
      if (reason === 'user') await publish(sql, userId, 'assistant.stopped', { sessionId, generation: session!.generation });
      return { sessionId, generation: session!.generation, stopped: true as const };
    });
  }

  async turn(userId: string, sessionId: string, turnId: string) {
    const [turn] = await this.db.query<Turn>(`SELECT ${turnColumns} FROM assistant_turns t
      JOIN assistant_sessions s ON s.id = t.session_id WHERE t.id = $1 AND t.session_id = $2 AND s.user_id = $3`, [turnId, sessionId, userId]);
    if (!turn) throw notFound();
    return turn;
  }

  async history(userId: string, sessionId: string) {
    await this.requireSession(userId, sessionId);
    return this.db.query<Turn>(`SELECT ${turnColumns} FROM assistant_turns t JOIN assistant_sessions s ON s.id = t.session_id
      WHERE t.session_id = $1 ORDER BY t.generation DESC LIMIT 20`, [sessionId]);
  }

  async guard(sql: Sql, turn: Turn, signal: AbortSignal) {
    throwIfAborted(signal);
    const session = await this.requireSession(turn.userId, turn.sessionId, sql, true);
    const [current] = await sql.query<{ status: string }>('SELECT status FROM assistant_turns WHERE id = $1', [turn.id]);
    if (session.generation !== turn.generation || current?.status !== 'running') {
      throw new AppError(409, 'TURN_SUPERSEDED', 'A newer request has taken over.');
    }
    throwIfAborted(signal);
  }

  async mutate<T>(turn: Turn, signal: AbortSignal, operation: (db: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(async (sql) => {
      await this.guard(sql, turn, signal);
      const scoped: Database = { query: sql.query, transaction: (fn) => fn(sql), close: async () => undefined };
      return operation(scoped);
    });
  }

  async emit(turn: Turn, signal: AbortSignal, type: string, payload: Record<string, unknown>) {
    await this.mutate(turn, signal, (db) => publish(db, turn.userId, type, { sessionId: turn.sessionId, turnId: turn.id, ...payload }));
  }

  async claim(owner: string): Promise<Turn | undefined> {
    return this.db.transaction(async (sql) => {
      const [candidate] = await sql.query<Turn>(`SELECT ${turnColumns} FROM assistant_turns t JOIN assistant_sessions s ON s.id = t.session_id
        WHERE t.status = 'queued' AND t.generation = s.generation ORDER BY t.created_at LIMIT 1 FOR UPDATE OF t SKIP LOCKED`);
      if (!candidate) return;
      await sql.query(`UPDATE assistant_turns SET status = 'running',lease_owner = $2,lease_expires_at = now() + interval '30 seconds'
        WHERE id = $1`, [candidate.id, owner]);
      await publish(sql, candidate.userId, 'assistant.started', { sessionId: candidate.sessionId, turnId: candidate.id });
      return { ...candidate, status: 'running' };
    });
  }

  async heartbeat(turn: Turn, owner: string) {
    const rows = await this.db.query(`UPDATE assistant_turns t SET lease_expires_at = now() + interval '30 seconds'
      FROM assistant_sessions s WHERE t.id = $1 AND t.lease_owner = $2 AND t.status = 'running'
      AND s.id = t.session_id AND s.generation = t.generation RETURNING t.id`, [turn.id, owner]);
    return rows.length > 0;
  }

  async expire() {
    await this.db.transaction(async (sql) => {
      const rows = await sql.query<{ id: string; userId: string; sessionId: string }>(`UPDATE assistant_turns t SET status = 'failed',error_code = 'RUN_INTERRUPTED',completed_at = now()
        FROM assistant_sessions s WHERE t.status = 'running' AND t.lease_expires_at < now() AND s.id = t.session_id
        RETURNING t.id,s.user_id AS "userId",t.session_id AS "sessionId"`);
      for (const turn of rows) await publish(sql, turn.userId, 'assistant.failed', { sessionId: turn.sessionId, turnId: turn.id,
        code: 'RUN_INTERRUPTED', message: 'The connection was interrupted. Your drafts are saved; please ask again.' });
    });
  }

  async setSpeechDelivery(turn: Turn, signal: AbortSignal, value: SpeechDelivery) {
    const delivery = speechDeliverySchema.parse(value);
    await this.mutate(turn, signal, async db => {
      await db.query('UPDATE assistant_turns SET speech_delivery=$2::jsonb WHERE id=$1', [turn.id, JSON.stringify(delivery)]);
    });
    turn.speechDelivery = delivery;
    return { delivery, scope: 'this turn only; no persistent preference changed' };
  }

  async finish(turn: Turn, signal: AbortSignal, text: string) {
    await this.mutate(turn, signal, async (db) => {
      await db.query("UPDATE assistant_turns SET status = 'completed',assistant_text = $2,completed_at = now(),lease_expires_at = NULL WHERE id = $1", [turn.id, text]);
      await publish(db, turn.userId, 'assistant.completed', { sessionId: turn.sessionId, turnId: turn.id, text });
    });
  }

  async fail(turn: Turn, code: string) {
    await this.db.transaction(async (sql) => {
      const session = await this.requireSession(turn.userId, turn.sessionId, sql, true);
      if (session.generation !== turn.generation) return;
      const updated = await sql.query(`UPDATE assistant_turns SET status = 'failed',error_code = $2,completed_at = now()
        WHERE id = $1 AND status = 'running' RETURNING id`, [turn.id, code]);
      if (updated.length) await publish(sql, turn.userId, 'assistant.failed', { sessionId: turn.sessionId, turnId: turn.id,
        code, message: 'I could not finish that request. Your saved drafts are still available.' });
    });
  }

  async action(turn: Turn, signal: AbortSignal, kind: string, payload: unknown): Promise<DeviceAction> {
    return this.mutate(turn, signal, async (db) => {
      const [count] = await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM device_actions WHERE turn_id=$1', [turn.id]);
      if ((count?.count ?? 0) >= 12) throw new AppError(422, 'ACTION_LIMIT', 'This turn reached its device action limit.');
      const extended = ['show_message','dismiss_message','play_audio'].includes(kind);
      const id = randomUUID();
      const [stored] = await db.query<{ sequence: string }>(`INSERT INTO device_actions(id,user_id,session_id,turn_id,generation,kind,payload,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now() + ($8::integer * interval '1 second')) RETURNING sequence`,
      [id, turn.userId, turn.sessionId, turn.id, turn.generation, kind, JSON.stringify(payload), extended ? 180 : 20]);
      await publish(db, turn.userId, 'device.action_requested', { sessionId: turn.sessionId, turnId: turn.id, actionId: id, kind, payload, sequence: String(stored!.sequence), expiresIn: extended ? 180000 : 20000, context: turn.context });
      return { id, kind, payload, state: 'pending', result: null };
    });
  }

  async actionSpeech(userId: string, sessionId: string, turnId: string, actionId: string) {
    const turn = await this.turn(userId, sessionId, turnId);
    const session = await this.requireSession(userId, sessionId);
    const [action] = await this.db.query<{ payload: { narration?: string; delivery?: unknown }; state: string; current: boolean }>(`SELECT payload,state,expires_at>now() AS current FROM device_actions
      WHERE id=$1 AND user_id=$2 AND session_id=$3 AND turn_id=$4 AND generation=$5 AND kind='show_message'`,
      [actionId,userId,sessionId,turnId,session.generation]);
    if (!action?.current || action.state !== 'pending' || !['running','completed'].includes(turn.status) || turn.generation !== session.generation || !action.payload.narration)
      throw new AppError(409, 'STALE_SPEECH', 'This narration is no longer current.');
    const claimed = await this.db.query(`UPDATE device_actions a SET narration_requested=true FROM assistant_sessions s,assistant_turns t
      WHERE a.id=$1 AND a.session_id=s.id AND a.turn_id=t.id AND s.generation=a.generation
      AND t.status IN ('running','completed') AND a.state='pending' AND a.expires_at>now() AND NOT a.narration_requested RETURNING a.id`, [actionId]);
    if (!claimed.length) throw new AppError(409, 'STALE_SPEECH', 'This narration was already requested or cancelled.');
    return { turn, text: action.payload.narration, delivery: speechDeliverySchema.safeParse(action.payload.delivery).data ?? defaultSpeechDelivery };
  }

  async acknowledgeAction(userId: string, actionId: string, success: boolean, result: unknown) {
    const feedback = deviceResultSchema.parse(result);
    return this.db.transaction(async (sql) => {
      const [lookup] = await sql.query<{ sessionId: string }>('SELECT session_id AS "sessionId" FROM device_actions WHERE id = $1 AND user_id = $2', [actionId, userId]);
      if (!lookup) throw notFound();
      const session = await this.requireSession(userId, lookup.sessionId, sql, true);
      const [action] = await sql.query<DeviceAction & { generation: number; expired: boolean }>(`SELECT id,kind,payload,state,result,generation,expires_at <= now() AS expired
        FROM device_actions WHERE id = $1 FOR UPDATE`, [actionId]);
      if (!action) throw notFound();
      if (action.state !== 'pending') return action;
      if (action.expired || session.generation !== action.generation) throw conflict('This device action has expired or was cancelled.');
      await assertContextAccess(sql, userId, feedback.context ?? null);
      if (success && action.kind === 'show_message') {
        const source = action.payload as { chatId: string; messageId: string };
        if (feedback.reference?.chatId !== source.chatId || feedback.reference.messageId !== source.messageId || feedback.context?.route !== `/chat/${source.chatId}`)
          throw conflict('Confirm the exact visible source and its opened chat.');
      }
      if (success && action.kind === 'dismiss_message' && feedback.context?.reference) throw conflict('The reference is still visible.');
      if (success && ['set_voice_mode', 'set_microphone_muted'].includes(action.kind)) {
        const requested = action.payload as { enabled?: boolean; muted?: boolean };
        if (!feedback.voice || (action.kind === 'set_voice_mode' ? feedback.voice.enabled !== requested.enabled : feedback.voice.microphoneMuted !== requested.muted)) {
          throw conflict('Report the actual applied voice state before confirming success.');
        }
        if (feedback.context?.voice && JSON.stringify(feedback.context.voice) !== JSON.stringify(feedback.voice)) throw conflict('Voice feedback must match the device context.');
      }
      if (typeof result === 'object' && result !== null && 'mediaId' in result) {
        if (action.kind !== 'record_voice') throw conflict('This device action does not accept a recording.');
        const [media] = await sql.query('SELECT id FROM media WHERE id = $1 AND owner_id = $2', [result.mediaId, userId]);
        if (!media) throw notFound();
      }
      const state = success ? 'completed' : 'failed';
      await sql.query('UPDATE device_actions SET state = $2,result = $3::jsonb WHERE id = $1', [actionId, state, JSON.stringify(result)]);
      await publish(sql, userId, 'device.action_completed', { sessionId: session.id, actionId, state, result });
      return { ...action, state, result };
    });
  }
}
