import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { uuidv7, type Db } from '@lis/db';
import { appendAudit } from '@lis/lab';

/**
 * Local accounts (10 §3 fallback). Passwords are hashed with scrypt from
 * Node's standard library, so the offline install needs no native module.
 * ASSUMPTION A-WEB-1: scrypt replaces the argon2id named in 10 §3 for that
 * reason; both are memory-hard. Hospital SSO (OIDC/LDAPS) is not built yet.
 */

export const ROLES = ['admin', 'technologist', 'approver', 'operator', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  roles: Role[];
  csrfToken: string;
}

export interface SessionPolicy {
  /** Idle timeout (10 §4: 15 min, configurable). */
  idleMs: number;
  /** Absolute limit (10 §4: 12 h). */
  absoluteMs: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = { idleMs: 15 * 60_000, absoluteMs: 12 * 3600_000 };

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

const scryptOpts = (n: number, r: number, p: number): ScryptOptions => ({ N: n, r, p, maxmem: 128 * n * r * 2 });

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, scryptOpts(N, R, P));
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, scryptOpts(Number(n), Number(r), Number(p)));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Verified against when the username does not exist, so timing does not reveal which usernames are real. */
let dummyHash: Promise<string> | undefined;

export function validatePassword(password: string): string | undefined {
  if (password.length < 12) return 'password must be at least 12 characters';
  if (password.length > 256) return 'password is too long';
  return undefined;
}

export async function createUser(db: Db, u: { username: string; displayName: string; password: string; roles: Role[] }, actor: string): Promise<string> {
  const problem = validatePassword(u.password);
  if (problem) throw new Error(problem);
  const bad = u.roles.filter((r) => !ROLES.includes(r));
  if (bad.length) throw new Error(`unknown roles: ${bad.join(', ')}`);
  if (u.username === actor) throw new Error('an account cannot be created or given roles by itself');
  const id = uuidv7();
  const passwordHash = await hashPassword(u.password);
  await db.$transaction(async (tx) => {
    await tx.appUser.create({ data: { id, username: u.username, displayName: u.displayName, passwordHash, roles: u.roles } });
    await appendAudit(tx, { actor, action: 'user.create', entityType: 'app_user', entityId: id, after: { username: u.username, roles: u.roles } });
  });
  return id;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type LoginResult = { ok: true; token: string; user: SessionUser } | { ok: false; reason: 'invalid' | 'locked' };

export async function login(db: Db, username: string, password: string, policy = DEFAULT_SESSION_POLICY, now = new Date()): Promise<LoginResult> {
  const user = await db.appUser.findUnique({ where: { username } });
  if (!user || !user.active) {
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    await verifyPassword(password, await dummyHash);
    return { ok: false, reason: 'invalid' };
  }
  if (user.lockedUntil && user.lockedUntil > now) return { ok: false, reason: 'locked' };
  if (!(await verifyPassword(password, user.passwordHash))) {
    const failures = user.failedLogins + 1;
    const locked = failures >= MAX_FAILURES;
    await db.$transaction(async (tx) => {
      await tx.appUser.update({ where: { id: user.id }, data: { failedLogins: locked ? 0 : failures, lockedUntil: locked ? new Date(now.getTime() + LOCK_MS) : user.lockedUntil } });
      await appendAudit(tx, { actor: username, action: locked ? 'auth.locked' : 'auth.failed', entityType: 'app_user', entityId: user.id });
    });
    return { ok: false, reason: locked ? 'locked' : 'invalid' };
  }
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  await db.$transaction(async (tx) => {
    await tx.appUser.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
    await tx.userSession.create({ data: { tokenHash: sha256(token), userId: user.id, csrfToken, createdAt: now, expiresAt: new Date(now.getTime() + policy.idleMs) } });
    await appendAudit(tx, { actor: username, action: 'auth.login', entityType: 'app_user', entityId: user.id });
  });
  return { ok: true, token, user: { id: user.id, username: user.username, displayName: user.displayName, roles: user.roles as Role[], csrfToken } };
}

/** Re-check a signed-in person's password before approve or release (10 §3 step-up). */
export async function confirmPassword(db: Db, userId: string, password: string): Promise<boolean> {
  const user = await db.appUser.findUnique({ where: { id: userId } });
  return !!user && user.active && (await verifyPassword(password, user.passwordHash));
}

/** Resolve a session cookie. Slides the idle expiry forward, never past the absolute limit. */
export async function sessionUser(db: Db, token: string | undefined, policy = DEFAULT_SESSION_POLICY, now = new Date()): Promise<SessionUser | undefined> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return undefined;
  const s = await db.userSession.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!s || !s.user.active) return undefined;
  const hardStop = s.createdAt.getTime() + policy.absoluteMs;
  if (s.expiresAt <= now || hardStop <= now.getTime()) {
    await db.userSession.deleteMany({ where: { tokenHash: s.tokenHash } });
    return undefined;
  }
  const next = Math.min(now.getTime() + policy.idleMs, hardStop);
  // Write at most once a minute to keep page loads cheap.
  if (next - s.expiresAt.getTime() > 60_000) await db.userSession.update({ where: { tokenHash: s.tokenHash }, data: { expiresAt: new Date(next) } });
  return { id: s.user.id, username: s.user.username, displayName: s.user.displayName, roles: s.user.roles as Role[], csrfToken: s.csrfToken };
}

export async function logout(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  const s = await db.userSession.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!s) return;
  await db.$transaction(async (tx) => {
    await tx.userSession.delete({ where: { tokenHash: s.tokenHash } });
    await appendAudit(tx, { actor: s.user.username, action: 'auth.logout', entityType: 'app_user', entityId: s.userId });
  });
}
