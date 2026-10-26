import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { Database } from './db/database.js';
import { AppError, conflict, isDatabaseError } from './errors.js';

const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 65536, r: 8, p: 1, maxmem: 80 * 1024 * 1024 }, (error, key) => {
    if (error) reject(error); else resolve(key);
  });
});
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export type User = { id: string; email: string; username: string; displayName: string };
type Credentials = { email: string; username: string; displayName: string; password: string };
const columns = 'id, email, username, display_name AS "displayName"';
const unauthorized = () => new AppError(401, 'UNAUTHORIZED', 'Authentication is required.');

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt);
  return `${salt}:${hash.toString('hex')}`;
}

async function matches(password: string, stored: string): Promise<boolean> {
  const [salt, value] = stored.split(':');
  if (!salt || !value) return false;
  const expected = Buffer.from(value, 'hex');
  const actual = await derive(password, salt);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class AuthService {
  private readonly dummyHash = hashPassword(randomBytes(32).toString('hex'));
  constructor(private readonly db: Database) {}

  async register(input: Credentials) {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.db.transaction(async (sql) => {
        const [user] = await sql.query<User>(
          `INSERT INTO users(id, email, username, display_name, password_hash)
           VALUES ($1,$2,$3,$4,$5) RETURNING ${columns}`,
          [randomUUID(), input.email.toLowerCase(), input.username.toLowerCase(), input.displayName, passwordHash]);
        if (!user) throw new Error('User creation failed');
        return this.createSession(user, sql);
      });
    } catch (error) {
      if (isDatabaseError(error, '23505')) throw conflict('The email or username is already registered.');
      throw error;
    }
  }

  async login(email: string, password: string) {
    const [record] = await this.db.query<User & { passwordHash: string }>(
      `SELECT ${columns}, password_hash AS "passwordHash" FROM users WHERE email = $1`, [email.toLowerCase()]);
    const valid = await matches(password, record?.passwordHash ?? await this.dummyHash);
    if (!record || !valid) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    const { passwordHash: _, ...user } = record;
    return this.createSession(user, this.db);
  }

  async authenticate(header?: string): Promise<User> {
    const token = header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw unauthorized();
    const [user] = await this.db.query<User>(
      `SELECT u.id, u.email, u.username, u.display_name AS "displayName"
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`, [this.tokenHash(token)]);
    if (!user) throw unauthorized();
    return user;
  }

  async logout(header?: string): Promise<void> {
    const token = header?.slice(7);
    if (token) await this.db.query('DELETE FROM auth_sessions WHERE token_hash = $1', [this.tokenHash(token)]);
  }

  private tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }

  private async createSession(user: User, sql: Pick<Database, 'query'>) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    await sql.query('INSERT INTO auth_sessions(token_hash, user_id, expires_at) VALUES ($1,$2,$3)',
      [this.tokenHash(token), user.id, expiresAt]);
    return { user, token, expiresAt };
  }
}
