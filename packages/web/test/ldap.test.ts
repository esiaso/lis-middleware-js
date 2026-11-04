import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, type Db } from '@lis/db';
import { verifyAuditChain } from '@lis/lab';
import { createApp, createUser, escapeFilterValue, LdapDirectory, ldapSettingsFromEnv, parseRoleMap, userFilterFor, type LdapSettings } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';
import { startStubDirectory, type StubDirectory, type StubEntry } from './ldap-stub.js';

// Every name, group and password below is made up for the test.
const GROUPS = { lab: 'cn=LIMS Lab,ou=groups,dc=example,dc=test', approvers: 'cn=LIMS Approvers,ou=groups,dc=example,dc=test', other: 'cn=Canteen,ou=groups,dc=example,dc=test' };
const DIR_PW = 'directory-password-1';
const person = (uid: string, name: string, groups: string[], uuid: string): StubEntry => ({
  dn: `uid=${uid},ou=people,dc=example,dc=test`,
  password: DIR_PW,
  attrs: { objectClass: ['person'], uid: [uid], displayName: [name], entryUUID: [uuid], memberOf: groups },
});

describe('directory sign-in settings', () => {
  const env = {
    LIMS_LDAP_URL: 'ldaps://dc1.example.test:636',
    LIMS_LDAP_BIND_DN: 'cn=lims,ou=services,dc=example,dc=test',
    LIMS_LDAP_BIND_PASSWORD: 'service-secret',
    LIMS_LDAP_BASE_DN: 'ou=people,dc=example,dc=test',
    LIMS_LDAP_USER_FILTER: '(&(objectClass=person)(uid={username}))',
    LIMS_LDAP_ID_ATTRIBUTE: 'entryUUID',
    LIMS_LDAP_ROLE_MAP: `${GROUPS.lab}=technologist,operator; CN=LIMS Approvers, OU=Groups,DC=example,DC=test=approver`,
  };

  it('reads the settings and matches groups ignoring case and spaces after commas', () => {
    expect(ldapSettingsFromEnv({})).toBeUndefined();
    const s = ldapSettingsFromEnv(env)!;
    expect([s.url.href, s.groupAttribute, s.displayNameAttribute, s.label, s.timeoutMs]).toEqual(['ldaps://dc1.example.test:636', 'memberOf', 'displayName', 'hospital account', 5000]);
    expect([...s.roleMap]).toEqual([
      ['cn=lims lab,ou=groups,dc=example,dc=test', ['technologist', 'operator']],
      ['cn=lims approvers,ou=groups,dc=example,dc=test', ['approver']],
    ]);
  });

  it('refuses plain LDAP, a filter without {username}, a missing password and a bad CA file', () => {
    expect(() => ldapSettingsFromEnv({ ...env, LIMS_LDAP_URL: 'ldap://dc1.example.test' })).toThrow(/ldaps/);
    expect(() => ldapSettingsFromEnv({ ...env, LIMS_LDAP_URL: 'ldaps://dc1.example.test/dc=example' })).toThrow(/server only/);
    expect(() => ldapSettingsFromEnv({ ...env, LIMS_LDAP_USER_FILTER: '(uid=jdoe)' })).toThrow(/\{username\}/);
    expect(() => ldapSettingsFromEnv({ ...env, LIMS_LDAP_BIND_PASSWORD: '' })).toThrow(/lims secrets set ldap_bind_password/);
    expect(() => ldapSettingsFromEnv({ ...env, LIMS_LDAP_ID_ATTRIBUTE: '' })).toThrow(/LIMS_LDAP_ID_ATTRIBUTE is required/);
    expect(() => ldapSettingsFromEnv({ ...env, LIMS_LDAP_ROLE_MAP: `${GROUPS.lab}=wizard` })).toThrow(/LIMS_LDAP_ROLE_MAP: .*not wizard/);
    const dir = mkdtempSync(join(tmpdir(), 'lims-ldap-'));
    writeFileSync(join(dir, 'ca.pem'), 'not a certificate');
    expect(() => ldapSettingsFromEnv({ ...env, LIMS_LDAP_CA_FILE: join(dir, 'ca.pem') })).toThrow(/not a PEM/);
    expect(() => new LdapDirectory({ ...ldapSettingsFromEnv(env)!, url: new URL('ldap://dc1.example.test') })).toThrow(/ldaps/);
  });

  it('escapes the typed name inside the filter (RFC 4515)', () => {
    expect(escapeFilterValue('a*b(c)\\d\0')).toBe('a\\2ab\\28c\\29\\5cd\\00');
    expect(userFilterFor('(&(uid={username})(mail={username}))', 'x*')).toBe('(&(uid=x\\2a)(mail=x\\2a))');
  });
});

describe('directory sign-in against a stand-in directory', () => {
  let stub: StubDirectory;
  let settings: LdapSettings;
  const directory = () => new LdapDirectory(settings);

  beforeAll(async () => {
    stub = await startStubDirectory([
      person('jdoe', 'Jane Doe', [GROUPS.lab, GROUPS.other], 'uuid-jdoe'),
      person('twin', 'Twin One', [GROUPS.lab], 'uuid-twin-1'),
      person('twin', 'Twin Two', [GROUPS.lab], 'uuid-twin-2'),
      person('noid', 'No Id', [GROUPS.lab], ''),
    ]);
    stub.entries[3]!.attrs['entryUUID'] = [];
    settings = {
      url: new URL(stub.url), bindDn: stub.service.dn, bindPassword: stub.service.password, baseDn: 'ou=people,dc=example,dc=test',
      userFilter: '(&(objectClass=person)(uid={username}))', idAttribute: 'entryUUID', displayNameAttribute: 'displayName', groupAttribute: 'memberOf',
      roleMap: new Map([[GROUPS.lab.toLowerCase(), ['technologist' as const]]]), label: 'hospital account', timeoutMs: 2000, allowPlain: true,
    };
  });
  afterAll(() => stub?.close());

  it('finds one entry with the service account, then binds as it with the typed password', async () => {
    stub.binds.length = 0;
    const r = await directory().authenticate('JDoe', DIR_PW);
    expect(r).toEqual({ ok: true, person: { id: Buffer.from('uuid-jdoe').toString('hex'), dn: 'uid=jdoe,ou=people,dc=example,dc=test', username: 'jdoe', displayName: 'Jane Doe', groups: [GROUPS.lab, GROUPS.other], roles: ['technologist'] } });
    expect(stub.binds).toEqual([stub.service.dn, 'uid=jdoe,ou=people,dc=example,dc=test']);
    expect(stub.filters.at(-1)).toEqual({ and: [{ eq: ['objectClass', 'person'] }, { eq: ['uid', 'JDoe'] }] });
  });

  it('refuses a wrong or empty password, an unknown or ambiguous name, and an entry without an id', async () => {
    expect(await directory().authenticate('jdoe', 'wrong')).toEqual({ ok: false, reason: 'invalid' });
    stub.binds.length = 0;
    // The stand-in, like many directories, treats a name with no password as an anonymous success.
    expect(await directory().authenticate('jdoe', '')).toEqual({ ok: false, reason: 'invalid' });
    expect(await directory().authenticate('jdoe)(uid=*', DIR_PW)).toEqual({ ok: false, reason: 'invalid' });
    expect(stub.binds).toEqual([]);
    expect(await directory().authenticate('nobody', DIR_PW)).toEqual({ ok: false, reason: 'invalid' });
    expect(await directory().authenticate('twin', DIR_PW)).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(await directory().authenticate('noid', DIR_PW)).toMatchObject({ ok: false, reason: 'no-id' });
  });

  it('says the directory is unavailable when the service account is refused or nothing answers', async () => {
    expect(await new LdapDirectory({ ...settings, bindPassword: 'wrong' }).authenticate('jdoe', DIR_PW)).toMatchObject({ ok: false, reason: 'unavailable' });
    stub.down = true;
    try {
      expect(await directory().authenticate('jdoe', DIR_PW)).toMatchObject({ ok: false, reason: 'unavailable' });
    } finally {
      stub.down = false;
    }
  });
});

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('directory sign-in over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let stub: StubDirectory;

  beforeAll(async () => {
    stub = await startStubDirectory([
      person('jdoe', 'Jane Doe', [GROUPS.lab], 'uuid-jdoe'),
      person('drlab', 'Dr Lab', [GROUPS.approvers], 'uuid-drlab'),
      person('cook', 'Cook', [GROUPS.other], 'uuid-cook'),
      person('admin', 'Directory Admin Namesake', [GROUPS.lab], 'uuid-admin'),
    ]);
    db = createDb(url as string);
    const directory = new LdapDirectory({
      url: new URL(stub.url), bindDn: stub.service.dn, bindPassword: stub.service.password, baseDn: 'dc=example,dc=test',
      userFilter: '(&(objectClass=person)(uid={username}))', idAttribute: 'entryUUID', displayNameAttribute: 'displayName', groupAttribute: 'memberOf',
      roleMap: new Map([...parseRoleMap(`${GROUPS.lab}=technologist;${GROUPS.approvers}=approver`)].map(([k, v]) => [k.toLowerCase(), v])), label: 'hospital account', timeoutMs: 2000, allowPlain: true,
    });
    app = await createApp(db, { secureCookies: false, logger: pino({ level: 'silent' }), directory });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    await stub?.close();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE user_session, app_user, audit_event, standard_comment CASCADE');
    await createUser(db, { username: 'admin', displayName: 'Local Admin', password: PW, roles: ['admin'] }, 'test');
    stub.entries[0]!.attrs['memberOf'] = [GROUPS.lab];
  });

  it('signs a directory person in with the ordinary form and keeps roles in step with their groups', async () => {
    expect((await new Browser(base).get('/login')).html).toContain('Sign in with your hospital account username and password. Local accounts also sign in here.');
    const b = new Browser(base);
    expect((await b.signIn('jdoe', 'wrong')).status).toBe(401);
    expect((await b.signIn('JDoe', DIR_PW)).status).toBe(303);
    let u = await db.appUser.findUniqueOrThrow({ where: { username: 'jdoe' } });
    expect([u.authSource, u.roles, u.displayName, u.oidcIssuer, u.oidcSubject]).toEqual(['ldap', ['technologist'], 'Jane Doe', `ldap:${new URL(stub.url).host}`, Buffer.from('uuid-jdoe').toString('hex')]);
    const home = await b.get('/');
    expect(home.html).not.toContain('href="/account/password"');
    expect((await b.get('/account/password')).status).toBe(404);

    // Added to the approvers group: the next sign-in brings the role.
    stub.entries[0]!.attrs['memberOf'] = [GROUPS.lab, GROUPS.approvers];
    const again = new Browser(base);
    expect((await again.signIn('jdoe', DIR_PW)).status).toBe(303);
    u = await db.appUser.findUniqueOrThrow({ where: { username: 'jdoe' } });
    expect(u.roles).toEqual(['approver', 'technologist']);
    // An approval-type action is confirmed with the directory password.
    const csrf = await again.csrf('/standard-comments');
    expect((await again.post('/standard-comments', { _csrf: csrf, code: 'HAEM', text: 'Sample haemolysed.', localTestCode: '', password: 'wrong' })).status).toBe(403);
    expect((await again.post('/standard-comments', { _csrf: csrf, code: 'HAEM', text: 'Sample haemolysed.', localTestCode: '', password: DIR_PW })).status).toBe(303);

    // The admin sees it as a directory account whose roles cannot be set here.
    const admin = new Browser(base);
    expect((await admin.signIn('admin')).status).toBe(303);
    expect((await admin.get(`/users/${u.id}`)).html).toContain('roles follow directory groups');

    const actions = (await db.auditEvent.findMany({ orderBy: { seq: 'asc' } })).map((e) => [e.actor, e.action]);
    expect(actions).toContainEqual(['ldap:jdoe', 'auth.failed']);
    expect(actions).toContainEqual(['system:ldap', 'user.create']);
    expect(actions).toContainEqual(['system:ldap', 'user.roles']);
    expect(actions.filter(([, a]) => a === 'auth.login').length).toBe(3);
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });

  it('refuses people with no mapped group, keeps local accounts local, and says when the directory is down', async () => {
    const cook = await new Browser(base).signIn('cook', DIR_PW);
    expect(cook.status).toBe(403);
    expect(cook.html).toContain('not in any directory group');
    // A local account of the same name always signs in locally, never through the directory.
    expect((await new Browser(base).signIn('admin', DIR_PW)).status).toBe(401);
    expect((await new Browser(base).signIn('admin')).status).toBe(303);

    stub.down = true;
    try {
      const down = await new Browser(base).signIn('jdoe', DIR_PW);
      expect(down.status).toBe(503);
      expect(down.html).toContain('directory cannot be reached');
      expect((await new Browser(base).signIn('admin')).status).toBe(303); // break-glass still works
    } finally {
      stub.down = false;
    }
    expect(await db.auditEvent.count({ where: { action: 'auth.ldap-unavailable' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: 'auth.ldap-refused', reason: 'no-role' } })).toBe(1);
  });
});
