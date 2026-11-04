import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as client from 'openid-client';
import { readSecretFile } from '@lis/db';
import { ROLES, type Role } from './auth.js';

/**
 * Hospital sign-in through OpenID Connect (10 §3): authorization code flow
 * with PKCE against whatever IdP the hospital runs (D-19 is still open, so
 * nothing here assumes a product). Everything about the IdP comes from its
 * own discovery document; the settings below say only which client this is
 * and how directory groups become roles.
 */
export interface OidcSettings {
  issuer: URL;
  clientId: string;
  /** Absent for a public client (PKCE only). */
  clientSecret?: string;
  /** Must be the address the browser uses, as registered at the IdP. */
  redirectUri: URL;
  scopes: string;
  usernameClaim: string;
  displayNameClaim: string;
  groupsClaim: string;
  /** Directory group → roles. A person with no mapped group cannot sign in. */
  roleMap: Map<string, Role[]>;
  /** Text on the sign-in button. */
  label: string;
  /** Ask the IdP for the password at every sign-in (shared lab workstations). */
  promptLogin: boolean;
  /** Tests only: an http:// stand-in IdP. Never set from the environment. */
  allowHttp?: boolean;
}

/** "Group A=admin;Group B=approver,technologist". Group names may hold spaces; the last "=" splits. */
export function parseRoleMap(text: string): Map<string, Role[]> {
  const map = new Map<string, Role[]>();
  for (const entry of text.split(';').map((x) => x.trim()).filter(Boolean)) {
    const at = entry.lastIndexOf('=');
    if (at <= 0) throw new Error(`LIMS_OIDC_ROLE_MAP: "${entry}" is not group=role[,role]`);
    const group = entry.slice(0, at).trim();
    const roles = entry.slice(at + 1).split(',').map((r) => r.trim()).filter(Boolean);
    const bad = roles.filter((r) => !ROLES.includes(r as Role));
    if (!roles.length || bad.length) throw new Error(`LIMS_OIDC_ROLE_MAP: group "${group}" needs roles among ${ROLES.join(', ')}${bad.length ? ` (not ${bad.join(', ')})` : ''}`);
    map.set(group, [...new Set([...(map.get(group) ?? []), ...(roles as Role[])])]);
  }
  return map;
}

/** Same order as the database URL: systemd credential, then a file, then the variable (development). */
function clientSecretFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env['CREDENTIALS_DIRECTORY'];
  if (dir) {
    try {
      return readFileSync(join(dir, 'oidc_client_secret'), 'utf8').trim();
    } catch {
      // not provided as a credential; fall through
    }
  }
  const file = env['LIMS_OIDC_CLIENT_SECRET_FILE'];
  if (file) return readSecretFile('oidc_client_secret', file);
  return env['LIMS_OIDC_CLIENT_SECRET'] || undefined;
}

/** Undefined when hospital sign-in is not configured (local accounts only). Throws on a half-done setup. */
export function oidcSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): OidcSettings | undefined {
  const issuer = env['LIMS_OIDC_ISSUER'];
  if (!issuer) return undefined;
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required when LIMS_OIDC_ISSUER is set`);
    return v;
  };
  const issuerUrl = new URL(issuer);
  const redirectUri = new URL(need('LIMS_OIDC_REDIRECT_URI'));
  if (issuerUrl.protocol !== 'https:') throw new Error('LIMS_OIDC_ISSUER must be an https:// address');
  if (redirectUri.protocol !== 'https:') throw new Error('LIMS_OIDC_REDIRECT_URI must be an https:// address');
  if (redirectUri.pathname !== CALLBACK_PATH) throw new Error(`LIMS_OIDC_REDIRECT_URI must end in ${CALLBACK_PATH}`);
  const roleMap = parseRoleMap(need('LIMS_OIDC_ROLE_MAP'));
  const secret = clientSecretFromEnv(env);
  return {
    issuer: issuerUrl,
    clientId: need('LIMS_OIDC_CLIENT_ID'),
    ...(secret ? { clientSecret: secret } : {}),
    redirectUri,
    scopes: env['LIMS_OIDC_SCOPES'] || 'openid profile',
    usernameClaim: env['LIMS_OIDC_USERNAME_CLAIM'] || 'preferred_username',
    displayNameClaim: env['LIMS_OIDC_DISPLAY_NAME_CLAIM'] || 'name',
    groupsClaim: env['LIMS_OIDC_GROUPS_CLAIM'] || 'groups',
    roleMap,
    label: env['LIMS_OIDC_LABEL'] || 'hospital account',
    promptLogin: env['LIMS_OIDC_PROMPT_LOGIN'] !== 'false',
  };
}

export const START_PATH = '/login/oidc';
export const STEP_UP_PATH = '/login/oidc/step-up';
export const CALLBACK_PATH = '/login/oidc/callback';
export const OIDC_COOKIE = 'lims_oidc';
/** How long a sign-in at the IdP may take before the round trip is refused. */
export const FLIGHT_MS = 10 * 60_000;
/** A step-up must have been typed at the IdP this recently (seconds). */
export const STEP_UP_MAX_AGE_S = 300;

export type Purpose = 'login' | 'step-up';
interface Flight {
  purpose: Purpose;
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  /** ms since epoch when the browser was sent to the IdP. */
  at: number;
}

export interface OidcProfile {
  issuer: string;
  subject: string;
  username: string;
  displayName: string;
  roles: Role[];
  groups: string[];
  /** Seconds since epoch, when the IdP says the person last typed their credentials. */
  authTime?: number;
}

export class OidcRefused extends Error {}

export class Oidc {
  #config: Promise<client.Configuration> | undefined;
  /** Signs the round-trip cookie; a restart only fails sign-ins that are in flight. */
  readonly #key = randomBytes(32);

  constructor(readonly settings: OidcSettings) {}

  /** Discovery runs on first use and again after a failure, so the web screens start even while the IdP is down. */
  config(): Promise<client.Configuration> {
    const s = this.settings;
    this.#config ??= client
      .discovery(s.issuer, s.clientId, s.clientSecret, s.clientSecret ? client.ClientSecretPost(s.clientSecret) : client.None(), {
        timeout: 10,
        ...(s.allowHttp ? { execute: [client.allowInsecureRequests] } : {}),
      })
      .catch((e: unknown) => {
        this.#config = undefined;
        throw e;
      });
    return this.#config;
  }

  #seal(f: Flight): string {
    const body = Buffer.from(JSON.stringify(f)).toString('base64url');
    return `${body}.${createHmac('sha256', this.#key).update(body).digest('base64url')}`;
  }

  #open(cookie: string | undefined, now: number): Flight {
    const [body, mac] = (cookie ?? '').split('.');
    const expected = body ? createHmac('sha256', this.#key).update(body).digest() : undefined;
    const given = mac ? Buffer.from(mac, 'base64url') : undefined;
    if (!body || !expected || !given || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new OidcRefused('The sign-in took too long or was started in another browser. Try again.');
    const f = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Flight;
    if (now - f.at > FLIGHT_MS) throw new OidcRefused('The sign-in took too long. Try again.');
    return f;
  }

  /** Where to send the browser, and the cookie that must come back with it. */
  async start(purpose: Purpose, next: string, now = Date.now()): Promise<{ url: string; cookie: string }> {
    const config = await this.config();
    const f: Flight = { purpose, state: client.randomState(), nonce: client.randomNonce(), verifier: client.randomPKCECodeVerifier(), next, at: now };
    const params: Record<string, string> = {
      redirect_uri: this.settings.redirectUri.href,
      scope: this.settings.scopes,
      state: f.state,
      nonce: f.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(f.verifier),
      code_challenge_method: 'S256',
    };
    // A step-up must be a fresh typing of the password, not a silent SSO hop.
    if (purpose === 'step-up') Object.assign(params, { prompt: 'login', max_age: '0' });
    else if (this.settings.promptLogin) params['prompt'] = 'login';
    return { url: client.buildAuthorizationUrl(config, params).href, cookie: this.#seal(f) };
  }

  /** Check the IdP's answer and read who signed in. `query` is the callback's query string. */
  async finish(query: string, cookie: string | undefined, now = Date.now()): Promise<{ purpose: Purpose; next: string; profile: OidcProfile }> {
    const f = this.#open(cookie, now);
    const config = await this.config();
    // Built from the configured address, never from the Host header.
    const current = new URL(this.settings.redirectUri.href);
    current.search = query;
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: f.verifier,
        expectedState: f.state,
        expectedNonce: f.nonce,
        idTokenExpected: true,
        ...(f.purpose === 'step-up' ? { maxAge: STEP_UP_MAX_AGE_S } : {}),
      });
    } catch (e) {
      const code = e instanceof client.AuthorizationResponseError ? e.error : undefined;
      throw new OidcRefused(code ? `The hospital sign-in did not complete (${code}).` : `The hospital sign-in could not be checked: ${(e as Error).message}`);
    }
    const claims = tokens.claims();
    if (!claims) throw new OidcRefused('The hospital sign-in returned no identity.');
    const authTime = typeof claims.auth_time === 'number' ? claims.auth_time : undefined;
    if (f.purpose === 'step-up' && (authTime === undefined || authTime * 1000 < f.at - 5_000)) {
      throw new OidcRefused('The hospital sign-in did not ask for your password again, so it cannot confirm this action. Ask IT to allow prompt=login and max_age for this client.');
    }
    const s = this.settings;
    const raw = claims[s.groupsClaim];
    const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string') : typeof raw === 'string' ? [raw] : [];
    const roles = [...new Set(groups.flatMap((g) => s.roleMap.get(g) ?? []))];
    const username = claims[s.usernameClaim];
    const displayName = claims[s.displayNameClaim];
    if (typeof username !== 'string' || !username.trim()) throw new OidcRefused(`The hospital sign-in did not send a ${s.usernameClaim} claim.`);
    return {
      purpose: f.purpose,
      next: f.next,
      profile: {
        issuer: claims.iss,
        subject: claims.sub,
        username: username.trim().toLowerCase(),
        displayName: typeof displayName === 'string' && displayName.trim() ? displayName.trim() : username.trim(),
        roles,
        groups,
        ...(authTime !== undefined ? { authTime } : {}),
      },
    };
  }
}
