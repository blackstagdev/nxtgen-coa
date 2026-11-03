import { hash, verify } from '@node-rs/argon2';
import type { Queryable } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/security.js';

export type Role = 'admin' | 'reviewer' | 'staff';
export const ROLES: Role[] = ['admin', 'reviewer', 'staff'];
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  reviewer: 'Reviewer (can publish)',
  staff: 'Staff (drafts only)',
};

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
}

export const can = {
  publish: (u: Pick<User, 'role'>) => u.role === 'admin' || u.role === 'reviewer',
  manageUsers: (u: Pick<User, 'role'>) => u.role === 'admin',
  archive: (u: Pick<User, 'role'>) => u.role === 'admin' || u.role === 'reviewer',
  viewAudit: (_u: Pick<User, 'role'>) => true,
};

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const MIN_PASSWORD = 12;

export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 256) return 'Password is too long.';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9\W_]/.test(pw)) return 'Use a mix of letters and numbers or symbols.';
  return null;
}

export async function hashPassword(pw: string) {
  return hash(pw, ARGON);
}

const USER_COLS = 'id, email, name, role, is_active, last_login_at, created_at';

export async function createUser(
  db: Queryable,
  input: { email: string; name: string; role: Role; password: string },
): Promise<User> {
  const problem = passwordProblem(input.password);
  if (problem) throw new Error(problem);
  const r = await db.query(
    `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLS}`,
    [input.email.trim().toLowerCase(), input.name.trim(), input.role, await hashPassword(input.password)],
  );
  return r.rows[0];
}

export async function listUsers(db: Queryable): Promise<User[]> {
  return (await db.query(`SELECT ${USER_COLS} FROM users ORDER BY is_active DESC, name`)).rows;
}

export async function getUser(db: Queryable, id: string): Promise<User | null> {
  return (await db.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id])).rows[0] ?? null;
}

export async function countUsers(db: Queryable): Promise<number> {
  return Number((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n);
}

export async function countActiveAdmins(db: Queryable): Promise<number> {
  return Number((await db.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active`)).rows[0].n);
}

const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
// A fixed hash so unknown emails cost the same as known ones.
let dummyHash: string | null = null;

export type LoginResult = { ok: true; user: User } | { ok: false; reason: 'invalid' | 'locked' | 'inactive' };

export async function authenticate(db: Queryable, email: string, password: string): Promise<LoginResult> {
  const r = await db.query(
    `SELECT ${USER_COLS}, password_hash, failed_logins, locked_until FROM users WHERE lower(email) = lower($1)`,
    [email.trim()],
  );
  const row = r.rows[0];
  if (!row) {
    dummyHash ??= await hashPassword(randomToken());
    await verify(dummyHash, password).catch(() => false);
    return { ok: false, reason: 'invalid' };
  }
  if (row.locked_until && new Date(row.locked_until) > new Date()) return { ok: false, reason: 'locked' };
  const good = await verify(row.password_hash, password).catch(() => false);
  if (!good) {
    const failed = row.failed_logins + 1;
    if (failed >= LOCK_AFTER) {
      await db.query(
        'UPDATE users SET failed_logins = 0, locked_until = now() + make_interval(mins => $2) WHERE id = $1',
        [row.id, LOCK_MINUTES],
      );
      return { ok: false, reason: 'locked' };
    }
    await db.query('UPDATE users SET failed_logins = $2 WHERE id = $1', [row.id, failed]);
    return { ok: false, reason: 'invalid' };
  }
  if (!row.is_active) return { ok: false, reason: 'inactive' };
  await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [row.id]);
  const { password_hash: _ph, failed_logins: _f, locked_until: _l, ...user } = row;
  return { ok: true, user };
}

export async function setPassword(db: Queryable, userId: string, pw: string) {
  const problem = passwordProblem(pw);
  if (problem) throw new Error(problem);
  await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, await hashPassword(pw)]);
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export async function verifyPassword(db: Queryable, userId: string, pw: string): Promise<boolean> {
  const r = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!r.rows[0]) return false;
  return verify(r.rows[0].password_hash, pw).catch(() => false);
}

// ---- Sessions ------------------------------------------------------------------

export interface Session {
  user: User;
  csrf: string;
  idHash: string;
}

export async function createSession(
  db: Queryable,
  userId: string,
  ttlHours: number,
  meta: { ip?: string; ua?: string },
): Promise<{ token: string; csrf: string }> {
  const token = randomToken(32);
  const csrf = randomToken(24);
  await db.query(
    `INSERT INTO sessions (id_hash, user_id, csrf_token, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6)`,
    [sha256(token), userId, csrf, ttlHours, meta.ip ?? null, (meta.ua ?? '').slice(0, 300)],
  );
  return { token, csrf };
}

export async function loadSession(db: Queryable, token: string): Promise<Session | null> {
  if (!token || token.length > 100) return null;
  const idHash = sha256(token);
  const r = await db.query(
    `SELECT s.csrf_token, u.id, u.email, u.name, u.role, u.is_active, u.last_login_at, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = $1 AND s.expires_at > now() AND u.is_active`,
    [idHash],
  );
  const row = r.rows[0];
  if (!row) return null;
  const { csrf_token, ...user } = row;
  return { user, csrf: csrf_token, idHash };
}

export async function destroySession(db: Queryable, idHash: string) {
  await db.query('DELETE FROM sessions WHERE id_hash = $1', [idHash]);
}

export async function pruneSessions(db: Queryable) {
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
}
