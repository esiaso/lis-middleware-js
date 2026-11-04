import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, type Db } from '@lis/db';
import { verifyAuditChain } from '@lis/lab';
import { createApp, createUser, oidcSettingsFromEnv, parseRoleMap, type OidcSettings } from '@lis/web';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

describe('hospital sign-in settings', () => {
  it('reads the role map and refuses a half-done or unsafe setup', () => {
    expect([...parseRoleMap('LIMS Admins=admin; Lab/Approvers=approver,technologist;LIMS Admins=auditor')]).toEqual([
      ['LIMS Admins', ['admin', 'auditor']],
      ['Lab/Approvers', ['approver', 'technologist']],
    ]);
    expect(() => parseRoleMap('Group=wizard')).toThrow(/not wizard/);
    expect(() => parseRoleMap('just-a-group')).toThrow(/group=role/);
    expect(oidcSettingsFromEnv({})).toBeUndefined();
    const env = { LIMS_OIDC_ISSUER: 'https://idp.hospital.example/realms/lab', LIMS_OIDC_CLIENT_ID: 'lims', LIMS_OIDC_REDIRECT_URI: 'https://lims.hospital.example/login/oidc/callback', LIMS_OIDC_ROLE_MAP: 'LIMS-Admins=admin' };
    expect(oidcSettingsFromEnv(env)).toMatchObject({ clientId: 'lims', scopes: 'openid profile', usernameClaim: 'preferred_username', groupsClaim: 'groups', promptLogin: true });
    expect(oidcSettingsFromEnv(env)?.clientSecret).toBeUndefined();
    expect(oidcSettingsFromEnv({ ...env, LIMS_OIDC_CLIENT_SECRET: 's3cret' })?.clientSecret).toBe('s3cret');
    expect(() => oidcSettingsFromEnv({ ...env, LIMS_OIDC_ISSUER: 'http://idp.hospital.example' })).toThrow(/https/);
    expect(() => oidcSettingsFromEnv({ ...env, LIMS_OIDC_REDIRECT_URI: 'https://lims.hospital.example/elsewhere' })).toThrow(/must end in/);
    expect(() => oidcSettingsFromEnv({ ...env, LIMS_OIDC_ROLE_MAP: '' })).toThrow(/LIMS_OIDC_ROLE_MAP is required/);
  });
});

/** A stand-in OpenID provider: discovery, keys and a token endpoint that checks PKCE. */
class StandInIdp {
  server!: Server;
  issuer = '';
  #key!: CryptoKey;
  #jwk!: Record<string, unknown>;
  #codes = new Map<string, { challenge: string; claims: Record<string, unknown> }>();

  async start(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    this.#key = privateKey;
    this.#jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    this.server = createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/.well-known/openid-configuration') {
        return send(200, {
          issuer: this.issuer, authorization_endpoint: `${this.issuer}/authorize`, token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
        });
      }
      if (req.url === '/jwks') return send(200, { keys: [this.#jwk] });
      if (req.url === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          const p = new URLSearchParams(body);
          const grant = this.#codes.get(p.get('code') ?? '');
          this.#codes.delete(p.get('code') ?? '');
          const verifier = p.get('code_verifier') ?? '';
          if (!grant || createHash('sha256').update(verifier).digest('base64url') !== grant.challenge || p.get('client_id') !== 'lims') return send(400, { error: 'invalid_grant' });
          void new SignJWT(grant.claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(this.issuer).setAudience('lims').setIssuedAt().setExpirationTime('5m').sign(this.#key)
            .then((idToken) => send(200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken }));
        });
        return;
      }
      send(404, {});
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** What the IdP does after the person types their password: returns the callback path the browser follows. */
  authorize(authUrl: string, person: { sub: string; preferred_username: string; name?: string; groups?: string[]; auth_time?: number }, override: Record<string, string> = {}): string {
    const u = new URL(authUrl);
    const code = randomBytes(16).toString('hex');
    this.#codes.set(code, { challenge: u.searchParams.get('code_challenge')!, claims: { nonce: u.searchParams.get('nonce'), auth_time: Math.floor(Date.now() / 1000), ...person } });
    const back = new URL(u.searchParams.get('redirect_uri')!);
    back.search = new URLSearchParams({ code, state: u.searchParams.get('state')!, iss: this.issuer, ...override }).toString();
    return back.pathname + back.search;
  }
}

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('hospital sign-in over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  const idp = new StandInIdp();
  const nurse = { sub: 'sub-nurse', preferred_username: 'Nurse.B@hospital.example', name: 'Nurse B', groups: ['LIMS-Lab', 'Unrelated'] };
  const boss = { sub: 'sub-boss', preferred_username: 'boss', name: 'Lab Boss', groups: ['LIMS-Admins'] };

  /** Full round trip: our redirect, the IdP, our callback. */
  const ssoSignIn = async (person: Parameters<StandInIdp['authorize']>[1], b = new Browser(base)) => {
    const start = await b.get('/login/oidc?next=%2Forders');
    expect(start.status).toBe(303);
    const back = await b.get(idp.authorize(start.location!, person));
    return { b, back };
  };

  beforeAll(async () => {
    await idp.start();
    db = createDb(url as string);
    const oidc: OidcSettings = {
      issuer: new URL(idp.issuer), clientId: 'lims', redirectUri: new URL('http://127.0.0.1/login/oidc/callback'), scopes: 'openid profile',
      usernameClaim: 'preferred_username', displayNameClaim: 'name', groupsClaim: 'groups', label: 'hospital account', promptLogin: true, allowHttp: true,
      roleMap: parseRoleMap('LIMS-Lab=operator,technologist;LIMS-Admins=admin;LIMS-Approvers=approver'),
    };
    app = await createApp(db, { secureCookies: false, logger: pino({ level: 'silent' }), oidc });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    oidc.redirectUri = new URL(`${base}/login/oidc/callback`);
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    idp.server?.close();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE user_session, app_user, audit_event CASCADE');
    await createUser(db, { username: 'admin', displayName: 'Local Admin', password: PW, roles: ['admin'] }, 'test');
  });

  it('signs in through the IdP, creates the account from directory groups, and keeps local passwords out of it', async () => {
    const page = await new Browser(base).get('/login');
    expect(page.html).toContain('Sign in with your hospital account');
    expect(page.html).toContain('href="/login/oidc?next&#x3D;%2F"');

    const b = new Browser(base);
    const start = await b.get('/login/oidc?next=%2Forders');
    const auth = new URL(start.location!);
    expect(auth.origin + auth.pathname).toBe(`${idp.issuer}/authorize`);
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({ client_id: 'lims', response_type: 'code', scope: 'openid profile', code_challenge_method: 'S256', prompt: 'login', redirect_uri: `${base}/login/oidc/callback` });
    const back = await b.get(idp.authorize(start.location!, nurse));
    expect(back.status).toBe(303);
    expect(back.location).toBe('/orders');

    const u = await db.appUser.findUniqueOrThrow({ where: { username: 'nurse.b@hospital.example' } });
    expect(u).toMatchObject({ displayName: 'Nurse B', authSource: 'oidc', oidcIssuer: idp.issuer, oidcSubject: 'sub-nurse', mustChangePassword: false });
    expect(u.roles).toEqual(['operator', 'technologist']);
    const home = await b.get('/');
    expect(home.status).toBe(200);
    expect(home.html).toContain('Nurse B');
    expect(home.html).not.toContain('href="/account/password"');
    expect((await b.get('/account/password')).status).toBe(404);
    // No local password exists for this account.
    expect((await new Browser(base).signIn('nurse.b@hospital.example', '!oidc')).status).toBe(401);

    // Groups change in the directory: roles follow at the next sign-in, and the change is audited.
    await ssoSignIn({ ...nurse, groups: ['LIMS-Approvers'] });
    expect((await db.appUser.findUniqueOrThrow({ where: { id: u.id } })).roles).toEqual(['approver']);
    expect(await db.auditEvent.count({ where: { action: 'user.roles', actor: 'system:oidc', entityId: u.id } })).toBe(1);

    // An admin sees where roles come from and cannot set them or a password here.
    const admin = new Browser(base);
    await admin.signIn('admin');
    const detail = await admin.get(`/users/${u.id}`);
    expect(detail.html).toContain('roles follow directory groups');
    expect(detail.html).not.toContain(`action="/users/${u.id}/roles"`);
    const csrf = await admin.csrf(`/users/${u.id}`);
    expect((await admin.post(`/users/${u.id}/password`, { _csrf: csrf, password: 'a new temporary one', adminPassword: PW })).html).toContain('signs in through the hospital directory');
    // Disabling here still stops the IdP sign-in.
    expect((await admin.post(`/users/${u.id}/active`, { _csrf: csrf, active: 'no', reason: 'left the lab', adminPassword: PW })).status).toBe(303);
    const refused = await ssoSignIn(nurse);
    expect(refused.back.status).toBe(403);
    expect(refused.back.html).toContain('This account is disabled');
  });

  it('refuses people without a mapped group, name clashes with local accounts, and forged round trips', async () => {
    const none = await ssoSignIn({ ...nurse, groups: ['Unrelated'] });
    expect(none.back.status).toBe(403);
    expect(none.back.html).toContain('not in any directory group');
    // A directory entry named like a local account never takes it over.
    const clash = await ssoSignIn({ sub: 'sub-other', preferred_username: 'admin', groups: ['LIMS-Admins'] });
    expect(clash.back.status).toBe(403);
    expect(clash.back.html).toContain('A local account already has your username');
    expect(await db.appUser.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { action: 'auth.oidc-refused' } })).toBe(2);

    const b = new Browser(base);
    const start = await b.get('/login/oidc');
    const wrongState = await b.get(idp.authorize(start.location!, nurse, { state: 'forged' }));
    expect(wrongState.status).toBe(401);
    expect(wrongState.html).toContain('could not be checked');
    // Without the round-trip cookie (another browser) nothing is accepted.
    const s2 = await b.get('/login/oidc');
    const path = idp.authorize(s2.location!, nurse);
    const stranger = new Browser(base);
    expect((await stranger.get(path)).html).toContain('started in another browser');
    // The IdP said no.
    const s3 = await b.get('/login/oidc');
    const denied = new URL(s3.location!);
    expect((await b.get(`/login/oidc/callback?error=access_denied&state=${denied.searchParams.get('state')}&iss=${encodeURIComponent(idp.issuer)}`)).html).toContain('did not complete (access_denied)');
    expect(await db.userSession.count()).toBe(0);
  });

  it('confirms approval-type actions with a fresh IdP sign-in, once per action', async () => {
    const { b } = await ssoSignIn(boss);
    const form = await b.get('/users/new');
    expect(form.html).toContain('Confirm with the hospital sign-in</a> first.');
    expect(form.html).not.toContain('name="adminPassword"');
    const csrf = await b.csrf('/users/new');
    const create = (username: string) => b.post('/users', { _csrf: csrf, username, displayName: username, password: 'temporary password 1', roles: 'operator' });

    const before = await create('first');
    expect(before.status).toBe(403);
    expect(before.html).toContain('Confirm with the hospital sign-in first');

    const step = await b.get('/login/oidc/step-up?next=%2Fusers%2Fnew');
    const auth = new URL(step.location!);
    expect(auth.searchParams.get('prompt')).toBe('login');
    expect(auth.searchParams.get('max_age')).toBe('0');
    const back = await b.get(idp.authorize(step.location!, boss));
    expect(back.location).toBe('/users/new');
    expect((await b.get('/users/new')).html).toMatch(/Confirmed at the hospital sign-in for one action, until/);
    expect((await create('first')).status).toBe(303);
    // Used up: the next action needs its own confirmation.
    expect((await create('second')).status).toBe(403);

    // An IdP that silently re-uses an old sign-in does not count.
    const stale = await b.get('/login/oidc/step-up?next=%2Fusers%2Fnew');
    expect((await b.get(idp.authorize(stale.location!, { ...boss, auth_time: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(403);
    // Nor does someone else's sign-in at the same browser.
    const other = await b.get('/login/oidc/step-up?next=%2Fusers%2Fnew');
    const swapped = await b.get(idp.authorize(other.location!, { ...nurse, groups: ['LIMS-Admins'] }));
    expect(swapped.status).toBe(403);
    expect(swapped.html).toContain('not the person signed in here');
    expect((await create('second')).status).toBe(403);
    expect(await db.auditEvent.count({ where: { action: 'auth.step-up' } })).toBe(1);
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });
});
