import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, type Db } from '@lis/db';
import { verifyAuditChain } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { setUserRoles } from '../src/auth.js';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TEMP = 'temporary password 1';
const MINE = 'my very own password';

describe.skipIf(!url)('user management over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  const as = async (username: string, password = PW) => {
    const b = new Browser(base);
    expect((await b.signIn(username, password)).status).toBe(303);
    return b;
  };
  const idOf = async (username: string) => (await db.appUser.findUniqueOrThrow({ where: { username } })).id;

  beforeAll(async () => {
    db = createDb(url as string);
    app = await createApp(db, { secureCookies: false, logger: pino({ level: 'silent' }) });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE user_session, app_user, audit_event CASCADE');
    await createUser(db, { username: 'admin', displayName: 'Admin One', password: PW, roles: ['admin'] }, 'test');
    await createUser(db, { username: 'admin2', displayName: 'Admin Two', password: PW, roles: ['admin'] }, 'test');
    await createUser(db, { username: 'tech', displayName: 'Tech', password: PW, roles: ['technologist'] }, 'test');
  });

  it('is for administrators only', async () => {
    const tech = await as('tech');
    expect((await tech.get('/users')).status).toBe(403);
    expect((await tech.get('/')).html).not.toContain('href="/users"');
    const admin = await as('admin');
    const list = await admin.get('/users');
    expect(list.status).toBe(200);
    expect(list.html).toContain('admin2');
    expect((await admin.get('/')).html).toContain('href="/users"');
  });

  it('creates an account with a temporary password that must be changed before anything else', async () => {
    const admin = await as('admin');
    const csrf = await admin.csrf('/users/new');
    const form = { _csrf: csrf, username: 'Nurse.A', displayName: 'Nurse A', password: TEMP, roles: ['operator', 'technologist'], adminPassword: PW };

    const bad = await admin.post('/users', { ...form, username: '-x', displayName: '', password: 'short', roles: ['wizard'] });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('Username: 2 to 40 characters');
    expect(bad.html).toContain('Display name is required.');
    expect(bad.html).toContain('Temporary password');
    expect(bad.html).toContain('Unknown roles: wizard.');
    expect((await admin.post('/users', { ...form, username: 'tech' })).html).toContain('Username tech is already taken.');
    expect((await admin.post('/users', { ...form, adminPassword: 'wrong password here' })).status).toBe(403);
    expect(await db.appUser.count()).toBe(3);

    const ok = await admin.post('/users', form);
    expect(ok.status).toBe(303);
    const id = await idOf('nurse.a');
    expect(ok.location).toBe(`/users/${id}?notice=user-created`);
    const u = await db.appUser.findUniqueOrThrow({ where: { id } });
    expect(u).toMatchObject({ displayName: 'Nurse A', mustChangePassword: true, active: true });
    expect([...u.roles].sort()).toEqual(['operator', 'technologist']);
    expect((await admin.get(`/users/${id}`)).html).toContain('temporary password, must be changed');

    // Signed in with the temporary password, every page leads to the change form.
    const nurse = await as('nurse.a', TEMP);
    const home = await nurse.get('/');
    expect(home.status).toBe(303);
    expect(home.location).toBe('/account/password?notice=change-password');
    const form2 = await nurse.get('/account/password');
    expect(form2.status).toBe(200);
    const ncsrf = await nurse.csrf('/account/password');

    const mismatch = await nurse.post('/account/password', { _csrf: ncsrf, currentPassword: TEMP, newPassword: MINE, confirmPassword: 'something else entirely' });
    expect(mismatch.status).toBe(422);
    expect(mismatch.html).toContain('The two new passwords are not the same.');
    expect((await nurse.post('/account/password', { _csrf: ncsrf, currentPassword: 'not it at all', newPassword: MINE, confirmPassword: MINE })).html).toContain('Your current password is not right.');
    expect((await nurse.post('/account/password', { _csrf: ncsrf, currentPassword: TEMP, newPassword: TEMP, confirmPassword: TEMP })).html).toContain('Choose a password different');

    const other = await as('nurse.a', TEMP); // a second session, which the change ends
    const done = await nurse.post('/account/password', { _csrf: ncsrf, currentPassword: TEMP, newPassword: MINE, confirmPassword: MINE });
    expect(done.location).toBe('/?notice=password-changed');
    expect((await nurse.get('/')).status).toBe(200);
    expect((await other.get('/')).location).toMatch(/^\/login/);
    expect((await db.appUser.findUniqueOrThrow({ where: { id } })).mustChangePassword).toBe(false);
    expect((await new Browser(base).signIn('nurse.a', TEMP)).location).not.toBe('/');
    await as('nurse.a', MINE);
  });

  it('changes roles of others only, disables and enables, resets passwords and unlocks', async () => {
    const admin = await as('admin');
    const tech = await as('tech');
    const techId = await idOf('tech');
    const adminId = await idOf('admin');
    const csrf = await admin.csrf(`/users/${techId}`);

    // Own account: no forms, and the services refuse it.
    expect((await admin.get(`/users/${adminId}`)).html).toContain('This is your own account.');
    const self = await admin.post(`/users/${adminId}/roles`, { _csrf: csrf, roles: ['admin', 'approver'], adminPassword: PW });
    expect(self.status).toBe(422);
    expect(self.html).toContain('You cannot change your own account here.');

    expect((await admin.post(`/users/${techId}/roles`, { _csrf: csrf, roles: ['approver'], adminPassword: 'wrong password here' })).status).toBe(403);
    expect((await admin.post(`/users/${techId}/roles`, { _csrf: csrf, adminPassword: PW })).html).toContain('Choose at least one role.');
    expect((await admin.post(`/users/${techId}/roles`, { _csrf: csrf, roles: ['technologist', 'approver'], adminPassword: PW })).location).toBe(`/users/${techId}?notice=roles-saved`);
    expect((await db.appUser.findUniqueOrThrow({ where: { id: techId } })).roles).toEqual(['technologist', 'approver']);
    // The new role applies to the open session straight away.
    expect((await tech.get('/results')).status).toBe(200);

    // Disable: a reason is needed, sessions end, sign-in fails; enable brings it back.
    expect((await admin.post(`/users/${techId}/active`, { _csrf: csrf, active: 'no', reason: 'x', adminPassword: PW })).html).toContain('reason of at least 5');
    expect((await admin.post(`/users/${techId}/active`, { _csrf: csrf, active: 'no', reason: 'left the lab', adminPassword: PW })).location).toBe(`/users/${techId}?notice=user-disabled`);
    expect((await tech.get('/')).location).toMatch(/^\/login/);
    expect((await new Browser(base).signIn('tech')).location).not.toBe('/');
    expect((await admin.post(`/users/${techId}/active`, { _csrf: csrf, active: 'yes', reason: 'came back', adminPassword: PW })).location).toBe(`/users/${techId}?notice=user-enabled`);
    const back = await as('tech');

    // Reset: sessions end and the temporary password must be replaced.
    expect((await admin.post(`/users/${techId}/password`, { _csrf: csrf, password: 'short', adminPassword: PW })).status).toBe(422);
    expect((await admin.post(`/users/${techId}/password`, { _csrf: csrf, password: TEMP, adminPassword: PW })).location).toBe(`/users/${techId}?notice=password-reset`);
    expect((await back.get('/')).location).toMatch(/^\/login/);
    const reset = await as('tech', TEMP);
    expect((await reset.get('/results')).location).toBe('/account/password?notice=change-password');

    // Unlock after repeated failures.
    for (let i = 0; i < 5; i++) await new Browser(base).signIn('admin2', 'not the password');
    const admin2Id = await idOf('admin2');
    expect((await db.appUser.findUniqueOrThrow({ where: { id: admin2Id } })).lockedUntil).not.toBeNull();
    expect((await admin.get(`/users/${admin2Id}`)).html).toContain('Unlock now');
    expect((await admin.post(`/users/${admin2Id}/unlock`, { _csrf: csrf, adminPassword: PW })).location).toBe(`/users/${admin2Id}?notice=user-unlocked`);
    await as('admin2');

    const history = await admin.get(`/users/${techId}`);
    for (const a of ['user.roles', 'user.disable', 'user.enable', 'user.password-reset']) expect(history.html).toContain(a);
    expect(history.html).not.toContain(TEMP);
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });

  it('keeps at least one active administrator', async () => {
    await db.appUser.update({ where: { username: 'admin2' }, data: { active: false } });
    const adminId = await idOf('admin');
    // Only reachable when the acting account is not itself an active admin, so call the service directly.
    const actor = { id: await idOf('tech'), username: 'tech', displayName: 'Tech', roles: ['admin' as const], mustChangePassword: false, csrfToken: '', sso: false, external: false, stepUpAt: null };
    await expect(setUserRoles(db, actor, adminId, ['technologist'])).rejects.toThrow(/last active administrator/i);
  });
});
