import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { uuidv7, type Db } from '@lis/db';
import { appendAudit, InvalidInput } from '@lis/lab';

/**
 * Local accounts (10 §3 fallback). Passwords are hashed with scrypt from
 * Node's standard library, so the offline install needs no native module.
 * ASSUMPTION A-WEB-1: scrypt replaces the argon2id named in 10 §3 for that
 * reason; both are memory-hard. Hospital sign-in through OIDC is in oidc.ts;
 * those accounts have no password here.
 */

export const ROLES = ['admin', 'technologist', 'approver', 'operator', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  roles: Role[];
  csrfToken: string;
  /** An administrator set a temporary password: only the change-password page is open until it is changed. */
  mustChangePassword: boolean;
  /** Signs in through the hospital IdP: no password here, roles come from directory groups. */
  sso: boolean;
  /** When this session last re-confirmed at the IdP for one approval-type action (unused yet). */
  stepUpAt: Date | null;
}

/** A hospital sign-in re-confirmation counts for one action within this time. */
export const STEP_UP_MS = 5 * 60_000;
/** Stored for accounts that have no local password; never matches a scrypt hash. */
const NO_PASSWORD = '!oidc';

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

export async function createUser(db: Db, u: { username: string; displayName: string; password: string; roles: Role[]; mustChangePassword?: boolean }, actor: string): Promise<string> {
  const problem = validatePassword(u.password);
  if (problem) throw new Error(problem);
  const bad = u.roles.filter((r) => !ROLES.includes(r));
  if (bad.length) throw new Error(`unknown roles: ${bad.join(', ')}`);
  if (u.username === actor) throw new Error('an account cannot be created or given roles by itself');
  const id = uuidv7();
  const passwordHash = await hashPassword(u.password);
  await db.$transaction(async (tx) => {
    await tx.appUser.create({ data: { id, username: u.username, displayName: u.displayName, passwordHash, roles: u.roles, mustChangePassword: u.mustChangePassword ?? false } });
    await appendAudit(tx, { actor, action: 'user.create', entityType: 'app_user', entityId: id, after: { username: u.username, roles: u.roles } });
  });
  return id;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];
type UserRow = NonNullable<Awaited<ReturnType<Db['appUser']['findUnique']>>>;

function toSessionUser(u: UserRow, csrfToken: string, stepUpAt: Date | null): SessionUser {
  return { id: u.id, username: u.username, displayName: u.displayName, roles: u.roles as Role[], csrfToken, mustChangePassword: u.mustChangePassword, sso: u.authSource === 'oidc', stepUpAt };
}

async function openSession(tx: Tx, u: UserRow, policy: SessionPolicy, now: Date): Promise<{ token: string; user: SessionUser }> {
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  await tx.userSession.create({ data: { tokenHash: sha256(token), userId: u.id, csrfToken, createdAt: now, expiresAt: new Date(now.getTime() + policy.idleMs) } });
  return { token, user: toSessionUser(u, csrfToken, null) };
}

export type LoginResult = { ok: true; token: string; user: SessionUser } | { ok: false; reason: 'invalid' | 'locked' };

export async function login(db: Db, username: string, password: string, policy = DEFAULT_SESSION_POLICY, now = new Date()): Promise<LoginResult> {
  const user = await db.appUser.findUnique({ where: { username } });
  // Hospital sign-in accounts have no password here; answer exactly as for an unknown name.
  if (!user || !user.active || user.authSource !== 'local') {
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
  const opened = await db.$transaction(async (tx) => {
    await tx.appUser.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
    await appendAudit(tx, { actor: username, action: 'auth.login', entityType: 'app_user', entityId: user.id });
    return openSession(tx, user, policy, now);
  });
  return { ok: true, ...opened };
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  username: string;
  displayName: string;
  roles: Role[];
  groups: string[];
}

export type OidcSignInResult = { ok: true; token: string; user: SessionUser } | { ok: false; reason: 'no-role' | 'disabled' | 'name-taken' | 'bad-name' };

/** Usernames from the IdP may be e-mail style (Entra ID sends user@hospital.org). */
const SSO_USERNAME = /^[a-z0-9][a-z0-9._@-]{1,99}$/;

/**
 * A person the IdP vouched for. The account is found by issuer and subject,
 * never by username, so a local account is never taken over by a directory
 * entry with the same name. Roles follow the directory groups at every
 * sign-in; an administrator can still disable the account here.
 */
export async function oidcSignIn(db: Db, id: OidcIdentity, policy = DEFAULT_SESSION_POLICY, now = new Date()): Promise<OidcSignInResult> {
  const actor = `oidc:${id.username}`;
  const refuse = async (reason: Exclude<OidcSignInResult, { ok: true }>['reason'], entityId: string) => {
    await db.$transaction((tx) => appendAudit(tx, { actor, action: 'auth.oidc-refused', entityType: 'app_user', entityId, reason, after: { username: id.username, groups: id.groups } }));
    return { ok: false as const, reason };
  };
  const existing = await db.appUser.findUnique({ where: { oidcIssuer_oidcSubject: { oidcIssuer: id.issuer, oidcSubject: id.subject } } });
  if (existing && !existing.active) return refuse('disabled', existing.id);
  if (!id.roles.length) return refuse('no-role', existing?.id ?? id.subject);
  if (!existing) {
    if (!SSO_USERNAME.test(id.username)) return refuse('bad-name', id.subject);
    if (await db.appUser.findUnique({ where: { username: id.username } })) return refuse('name-taken', id.subject);
  }
  const roles = [...id.roles].sort();
  return db.$transaction(async (tx) => {
    let u: UserRow;
    if (existing) {
      u = existing;
      const before = [...(existing.roles as string[])].sort();
      if (before.join() !== roles.join() || existing.displayName !== id.displayName) {
        u = await tx.appUser.update({ where: { id: existing.id }, data: { roles, displayName: id.displayName } });
        if (before.join() !== roles.join()) await appendAudit(tx, { actor: 'system:oidc', action: 'user.roles', entityType: 'app_user', entityId: u.id, reason: 'directory groups changed', before: { roles: before }, after: { roles, groups: id.groups } });
      }
    } else {
      u = await tx.appUser.create({ data: { id: uuidv7(), username: id.username, displayName: id.displayName, passwordHash: NO_PASSWORD, roles, authSource: 'oidc', oidcIssuer: id.issuer, oidcSubject: id.subject } });
      await appendAudit(tx, { actor: 'system:oidc', action: 'user.create', entityType: 'app_user', entityId: u.id, after: { username: u.username, roles, source: 'oidc', groups: id.groups } });
    }
    await appendAudit(tx, { actor: u.username, action: 'auth.login', entityType: 'app_user', entityId: u.id, reason: 'oidc' });
    return { ok: true as const, ...(await openSession(tx, u, policy, now)) };
  });
}

/** The person re-typed their password at the IdP: one approval-type action may follow (10 §3 step-up). */
export async function recordStepUp(db: Db, token: string, user: SessionUser, id: Pick<OidcIdentity, 'issuer' | 'subject'>, now = new Date()): Promise<boolean> {
  const u = await db.appUser.findUnique({ where: { id: user.id } });
  if (!u || !u.active || u.authSource !== 'oidc' || u.oidcIssuer !== id.issuer || u.oidcSubject !== id.subject) return false;
  await db.$transaction(async (tx) => {
    await tx.userSession.update({ where: { tokenHash: sha256(token) }, data: { stepUpAt: now } });
    await appendAudit(tx, { actor: u.username, action: 'auth.step-up', entityType: 'app_user', entityId: u.id });
  });
  return true;
}

/**
 * Confirm it is still this person before approve, release, correct and the
 * like (10 §3). Local accounts re-enter their password. Hospital sign-in
 * accounts must have re-typed it at the IdP within STEP_UP_MS, and that
 * confirmation is used up here, so each action needs its own.
 */
export async function confirmIdentity(db: Db, user: SessionUser, token: string | undefined, password: string, now = new Date()): Promise<boolean> {
  if (!user.sso) return confirmPassword(db, user.id, password);
  if (!token || !user.stepUpAt || now.getTime() - user.stepUpAt.getTime() > STEP_UP_MS) return false;
  const used = await db.userSession.updateMany({ where: { tokenHash: sha256(token), stepUpAt: user.stepUpAt }, data: { stepUpAt: null } });
  return used.count === 1;
}

/** Re-check a signed-in person's password before approve or release (10 §3 step-up). */
export async function confirmPassword(db: Db, userId: string, password: string): Promise<boolean> {
  const user = await db.appUser.findUnique({ where: { id: userId } });
  return !!user && user.active && user.authSource === 'local' && (await verifyPassword(password, user.passwordHash));
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
  return toSessionUser(s.user, s.csrfToken, s.stepUpAt);
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

// ---------- Account administration (10 §2: admins manage users and roles) ----------

export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,39}$/;
const SSO_MANAGED = 'This account signs in through the hospital directory. Its roles follow directory groups and its password is changed there.';

async function loadOther(tx: Tx, actor: SessionUser, userId: string) {
  const u = await tx.appUser.findUnique({ where: { id: userId } });
  if (!u) throw new InvalidInput(['No such account.']);
  // Granting oneself a role, or locking oneself out, is blocked (10 §2).
  if (u.id === actor.id) throw new InvalidInput(['You cannot change your own account here. Ask another administrator.']);
  return u;
}

/** The last active administrator cannot lose the role or be disabled, or nobody could manage accounts. */
async function keepAnAdmin(tx: Tx, userId: string): Promise<void> {
  const others = await tx.appUser.count({ where: { active: true, roles: { has: 'admin' }, id: { not: userId } } });
  if (others === 0) throw new InvalidInput(['This is the last active administrator. Give another account the admin role first.']);
}

export function checkRoles(roles: string[]): Role[] {
  const bad = roles.filter((r) => !ROLES.includes(r as Role));
  if (bad.length) throw new InvalidInput([`Unknown roles: ${bad.join(', ')}.`]);
  if (roles.length === 0) throw new InvalidInput(['Choose at least one role. To stop someone signing in, disable the account.']);
  return [...new Set(roles)] as Role[];
}

export async function setUserRoles(db: Db, actor: SessionUser, userId: string, roles: string[]): Promise<void> {
  const next = checkRoles(roles);
  await db.$transaction(async (tx) => {
    const u = await loadOther(tx, actor, userId);
    if (u.authSource === 'oidc') throw new InvalidInput([SSO_MANAGED]);
    if (u.roles.includes('admin') && !next.includes('admin') && u.active) await keepAnAdmin(tx, u.id);
    await tx.appUser.update({ where: { id: u.id }, data: { roles: next } });
    await appendAudit(tx, { actor: actor.username, action: 'user.roles', entityType: 'app_user', entityId: u.id, before: { roles: u.roles }, after: { roles: next } });
  });
}

/** Disabling ends every session of that account at once. */
export async function setUserActive(db: Db, actor: SessionUser, userId: string, active: boolean, reason: string): Promise<void> {
  const why = reason.trim();
  if (why.length < 5) throw new InvalidInput(['Give a reason of at least 5 characters.']);
  await db.$transaction(async (tx) => {
    const u = await loadOther(tx, actor, userId);
    if (!active && u.roles.includes('admin')) await keepAnAdmin(tx, u.id);
    await tx.appUser.update({ where: { id: u.id }, data: { active, ...(active ? { failedLogins: 0, lockedUntil: null } : {}) } });
    if (!active) await tx.userSession.deleteMany({ where: { userId: u.id } });
    await appendAudit(tx, { actor: actor.username, action: active ? 'user.enable' : 'user.disable', entityType: 'app_user', entityId: u.id, reason: why });
  });
}

export async function unlockUser(db: Db, actor: SessionUser, userId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const u = await loadOther(tx, actor, userId);
    await tx.appUser.update({ where: { id: u.id }, data: { failedLogins: 0, lockedUntil: null } });
    await appendAudit(tx, { actor: actor.username, action: 'user.unlock', entityType: 'app_user', entityId: u.id });
  });
}

/** A temporary password the person must replace at next sign-in. Their sessions end now. */
export async function resetUserPassword(db: Db, actor: SessionUser, userId: string, temporary: string): Promise<void> {
  const problem = validatePassword(temporary);
  if (problem) throw new InvalidInput([`Temporary ${problem}.`]);
  const passwordHash = await hashPassword(temporary);
  await db.$transaction(async (tx) => {
    const u = await loadOther(tx, actor, userId);
    if (u.authSource === 'oidc') throw new InvalidInput([SSO_MANAGED]);
    await tx.appUser.update({ where: { id: u.id }, data: { passwordHash, mustChangePassword: true, failedLogins: 0, lockedUntil: null } });
    await tx.userSession.deleteMany({ where: { userId: u.id } });
    // The password itself is never recorded.
    await appendAudit(tx, { actor: actor.username, action: 'user.password-reset', entityType: 'app_user', entityId: u.id });
  });
}

/** The signed-in person chooses a new password. Their other sessions end; this one stays. */
export async function changeOwnPassword(db: Db, user: SessionUser, current: string, next: string, keepToken: string | undefined): Promise<void> {
  const u = await db.appUser.findUnique({ where: { id: user.id } });
  if (u?.authSource === 'oidc') throw new InvalidInput(['Your password is managed by the hospital sign-in. Change it there.']);
  if (!u || !(await verifyPassword(current, u.passwordHash))) throw new InvalidInput(['Your current password is not right.']);
  const problem = validatePassword(next);
  if (problem) throw new InvalidInput([`New ${problem}.`]);
  if (await verifyPassword(next, u.passwordHash)) throw new InvalidInput(['Choose a password different from the current one.']);
  const passwordHash = await hashPassword(next);
  await db.$transaction(async (tx) => {
    await tx.appUser.update({ where: { id: u.id }, data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() } });
    await tx.userSession.deleteMany({ where: { userId: u.id, ...(keepToken ? { tokenHash: { not: sha256(keepToken) } } : {}) } });
    await appendAudit(tx, { actor: u.username, action: 'user.password-change', entityType: 'app_user', entityId: u.id });
  });
}
