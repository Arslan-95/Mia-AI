import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import type { Database, Sql } from './db/database.js';
import { AppError, isDatabaseError, notFound } from './errors.js';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const OTP_DURATION_MS = 5 * 60 * 1000;
export type User = { id: string; phoneNumber: string; username: string; displayName: string; profileComplete: boolean };
type AuthSession = { user: User; token: string; expiresAt: Date };
type Challenge = { id: string; phoneNumber: string; codeHash: string; attempts: number; expired: boolean; consumed: boolean };
const columns = 'id,phone_number AS "phoneNumber",username,display_name AS "displayName",profile_complete AS "profileComplete"';
const unauthorized = () => new AppError(401, 'UNAUTHORIZED', 'Authentication is required.');
const invalidCode = () => new AppError(401, 'INVALID_OTP', 'The code is incorrect, expired, or already used. Request a new code if needed.');

export class AuthService {
  private readonly revocations = new Map<string, Set<() => void>>();
  constructor(private readonly db: Database, private readonly config: Pick<Config, 'environment' | 'developmentOtpCode'>) {}

  private requireDevelopmentProvider() {
    if (this.config.environment === 'production' || !this.config.developmentOtpCode) {
      throw new AppError(503, 'PHONE_AUTH_UNAVAILABLE', 'Phone verification is not configured for this environment.');
    }
    return this.config.developmentOtpCode;
  }

  async requestCode(phoneNumber: string) {
    const configuredCode = this.requireDevelopmentProvider();
    return this.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,317))', [phoneNumber]);
      const [recent] = await sql.query<{ count: number }>(`SELECT count(*)::integer AS count FROM otp_challenges
        WHERE phone_number = $1 AND created_at > now() - interval '15 minutes'`, [phoneNumber]);
      if (recent!.count >= 5) throw new AppError(429, 'OTP_RATE_LIMIT', 'Too many code requests for this number. Please try again later.');
      await sql.query('UPDATE otp_challenges SET consumed_at = now() WHERE phone_number = $1 AND consumed_at IS NULL', [phoneNumber]);
      const challengeId = randomUUID();
      const expiresAt = new Date(Date.now() + OTP_DURATION_MS);
      await sql.query('INSERT INTO otp_challenges(id,phone_number,code_hash,expires_at) VALUES ($1,$2,$3,$4)',
        [challengeId, phoneNumber, this.codeHash(challengeId, phoneNumber, configuredCode), expiresAt]);
      return { challengeId, expiresAt, delivery: 'development' as const };
    });
  }

  async verifyCode(challengeId: string, code: string): Promise<AuthSession> {
    this.requireDevelopmentProvider();
    const result = await this.db.transaction<{ session: AuthSession } | { error: AppError }>(async (sql) => {
      const [challenge] = await sql.query<Challenge>(`SELECT id,phone_number AS "phoneNumber",code_hash AS "codeHash",attempts,
        expires_at <= now() AS expired,consumed_at IS NOT NULL AS consumed FROM otp_challenges WHERE id = $1 FOR UPDATE`, [challengeId]);
      if (!challenge || challenge.expired || challenge.consumed) return { error: invalidCode() };
      if (challenge.attempts >= 5) return { error: new AppError(429, 'OTP_LOCKED', 'Too many incorrect attempts. Request a new code.') };
      const expected = Buffer.from(challenge.codeHash, 'hex');
      const actual = Buffer.from(this.codeHash(challengeId, challenge.phoneNumber, code), 'hex');
      if (!timingSafeEqual(expected, actual)) {
        await sql.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1', [challengeId]);
        return { error: challenge.attempts + 1 >= 5
          ? new AppError(429, 'OTP_LOCKED', 'Too many incorrect attempts. Request a new code.') : invalidCode() };
      }
      const [user] = await sql.query<User>(`INSERT INTO users(id,phone_number,username,display_name)
        VALUES ($1,$2,$3,'New friend') ON CONFLICT(phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
        RETURNING ${columns}`, [randomUUID(), challenge.phoneNumber, `mia_${randomBytes(8).toString('hex')}`]);
      if (!user) throw new Error('Account creation failed');
      await sql.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1', [challengeId]);
      return { session: await this.createSession(user, sql) };
    });
    if ('error' in result) throw result.error;
    return result.session;
  }

  async updateProfile(userId: string, username: string, displayName: string): Promise<User> {
    try {
      const [user] = await this.db.query<User>(`UPDATE users SET username = $2,display_name = $3,profile_complete = true
        WHERE id = $1 AND phone_number IS NOT NULL RETURNING ${columns}`, [userId, username.toLowerCase(), displayName]);
      if (!user) throw notFound();
      return user;
    } catch (error) {
      if (isDatabaseError(error, '23505')) throw new AppError(409, 'USERNAME_TAKEN', 'That username is already taken. Choose another one.');
      throw error;
    }
  }

  async authenticate(header?: string): Promise<User> {
    const token = header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw unauthorized();
    const [user] = await this.db.query<User>(`SELECT u.id,u.phone_number AS "phoneNumber",u.username,
      u.display_name AS "displayName",u.profile_complete AS "profileComplete"
      FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.phone_number IS NOT NULL`, [this.tokenHash(token)]);
    if (!user) throw unauthorized();
    return user;
  }

  async logout(header?: string): Promise<void> {
    const token = header?.slice(7);
    if (!token) return;
    const hash = this.tokenHash(token);
    await this.db.query('DELETE FROM auth_sessions WHERE token_hash = $1', [hash]);
    for (const revoke of [...this.revocations.get(hash) ?? []]) revoke();
  }

  watchSession(token: string, revoke: () => void): () => void {
    const hash = this.tokenHash(token);
    const listeners = this.revocations.get(hash) ?? new Set<() => void>();
    listeners.add(revoke);
    this.revocations.set(hash, listeners);
    return () => {
      listeners.delete(revoke);
      if (!listeners.size) this.revocations.delete(hash);
    };
  }

  private codeHash(challengeId: string, phoneNumber: string, code: string) {
    return createHash('sha256').update(`${challengeId}:${phoneNumber}:${code}`).digest('hex');
  }
  private tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
  private async createSession(user: User, sql: Sql): Promise<AuthSession> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    await sql.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES ($1,$2,$3)',
      [this.tokenHash(token), user.id, expiresAt]);
    return { user, token, expiresAt };
  }
}
