import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, InvalidCredentialsError, SizeLimitExceededError, type Entry } from 'ldapts';
import { readSecretFile } from '@lis/db';
import type { Role } from './auth.js';
import { parseRoleMap } from './oidc.js';

/**
 * Hospital sign-in through the directory over LDAPS (10 §3, A-29): the
 * person types their directory username and password on the ordinary
 * sign-in form. The middleware binds with a service account, finds exactly
 * one entry with the lab's search filter, then binds as that entry with the
 * typed password. Roles come from the entry's groups through the role map.
 *
 * D-19 is still open, so nothing here assumes Active Directory or any other
 * product: the search filter and the attribute that identifies a person are
 * required settings. Only ldaps:// is accepted; the certificate is always
 * checked (against LIMS_LDAP_CA_FILE when the directory uses the hospital's
 * own CA).
 */
export interface LdapSettings {
  url: URL;
  /** PEM certificates the directory's certificate must chain to; absent uses Node's bundled CAs. */
  ca?: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  /** Must contain {username}, which is replaced by the typed name, escaped (RFC 4515). */
  userFilter: string;
  /** A value that never changes for a person, such as objectGUID or entryUUID. Accounts here are keyed on it. */
  idAttribute: string;
  displayNameAttribute: string;
  groupAttribute: string;
  /** Group (as the directory writes it, compared ignoring case) → roles. A person with no mapped group cannot sign in. */
  roleMap: Map<string, Role[]>;
  /** Text on the sign-in page. */
  label: string;
  timeoutMs: number;
  /** Tests only: a plain ldap:// stand-in directory. Never set from the environment. */
  allowPlain?: boolean;
}

/** The typed username: letters, digits and . _ @ - only, so it can never change the shape of the filter. */
export const DIRECTORY_USERNAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/;

/** RFC 4515 escaping of a value inside a filter. The username pattern already excludes these; this is the second guard. */
export function escapeFilterValue(s: string): string {
  return s.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export function userFilterFor(template: string, username: string): string {
  return template.split('{username}').join(escapeFilterValue(username));
}

function bindPasswordFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env['CREDENTIALS_DIRECTORY'];
  if (dir) {
    try {
      return readFileSync(join(dir, 'ldap_bind_password'), 'utf8').trim();
    } catch {
      // not provided as a credential; fall through
    }
  }
  const file = env['LIMS_LDAP_BIND_PASSWORD_FILE'];
  if (file) return readSecretFile('ldap_bind_password', file);
  return env['LIMS_LDAP_BIND_PASSWORD'] || undefined;
}

/** Undefined when directory sign-in is not configured. Throws on a half-done setup. */
export function ldapSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): LdapSettings | undefined {
  const raw = env['LIMS_LDAP_URL'];
  if (!raw) return undefined;
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is required when LIMS_LDAP_URL is set`);
    return v;
  };
  const url = new URL(raw);
  if (url.protocol !== 'ldaps:') throw new Error('LIMS_LDAP_URL must be an ldaps:// address; plain LDAP would send passwords unprotected');
  if (url.pathname.replace(/^\/$/, '') || url.search) throw new Error('LIMS_LDAP_URL is the server only, such as ldaps://dc1.hospital.local:636; put the search base in LIMS_LDAP_BASE_DN');
  const userFilter = need('LIMS_LDAP_USER_FILTER');
  if (!userFilter.includes('{username}')) throw new Error('LIMS_LDAP_USER_FILTER must contain {username}, such as (&(objectClass=person)(uid={username}))');
  if (!/^\(.*\)$/.test(userFilter)) throw new Error('LIMS_LDAP_USER_FILTER must be an LDAP filter in parentheses');
  const caFile = env['LIMS_LDAP_CA_FILE'];
  let ca: string | undefined;
  if (caFile) {
    ca = readFileSync(caFile, 'utf8');
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error(`LIMS_LDAP_CA_FILE: ${caFile} is not a PEM certificate file`);
  }
  const bindPassword = bindPasswordFromEnv(env);
  if (!bindPassword) throw new Error('the directory service account password is missing: store it with lims secrets set ldap_bind_password');
  const timeout = env['LIMS_LDAP_TIMEOUT_MS'] ? Number(env['LIMS_LDAP_TIMEOUT_MS']) : 5000;
  if (!Number.isInteger(timeout) || timeout < 500 || timeout > 60_000) throw new Error('LIMS_LDAP_TIMEOUT_MS must be a whole number of milliseconds from 500 to 60000');
  const map = parseRoleMap(need('LIMS_LDAP_ROLE_MAP'), 'LIMS_LDAP_ROLE_MAP');
  return {
    url,
    ...(ca ? { ca } : {}),
    bindDn: need('LIMS_LDAP_BIND_DN'),
    bindPassword,
    baseDn: need('LIMS_LDAP_BASE_DN'),
    userFilter,
    idAttribute: need('LIMS_LDAP_ID_ATTRIBUTE'),
    displayNameAttribute: env['LIMS_LDAP_DISPLAY_NAME_ATTRIBUTE']?.trim() || 'displayName',
    groupAttribute: env['LIMS_LDAP_GROUP_ATTRIBUTE']?.trim() || 'memberOf',
    roleMap: lowerKeys(map),
    label: env['LIMS_LDAP_LABEL']?.trim() || 'hospital account',
    timeoutMs: timeout,
  };
}

/** Group names are compared ignoring case and spaces after commas, as directories treat DNs. */
export const groupKey = (g: string) => g.trim().replace(/,\s+/g, ',').toLowerCase();
function lowerKeys(map: Map<string, Role[]>): Map<string, Role[]> {
  const out = new Map<string, Role[]>();
  for (const [k, v] of map) out.set(groupKey(k), [...new Set([...(out.get(groupKey(k)) ?? []), ...v])]);
  return out;
}

export interface DirectoryPerson {
  /** Hex of the identifying attribute's bytes. */
  id: string;
  dn: string;
  username: string;
  displayName: string;
  groups: string[];
  roles: Role[];
}

export type DirectoryResult =
  | { ok: true; person: DirectoryPerson }
  /** Wrong name or password, or no such person: the page says only "wrong username or password". */
  | { ok: false; reason: 'invalid' | 'ambiguous' | 'no-id'; detail?: string }
  | { ok: false; reason: 'unavailable'; detail: string };

/** What the web service needs from a directory; tests may give a stand-in. */
export interface Directory {
  readonly label: string;
  /** For the account key: accounts from another directory are never matched. */
  readonly source: string;
  authenticate(username: string, password: string): Promise<DirectoryResult>;
}

const values = (v: Entry[string] | undefined): (string | Buffer)[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: string | Buffer) => (typeof v === 'string' ? v : v.toString('utf8'));

export class LdapDirectory implements Directory {
  constructor(readonly settings: LdapSettings) {
    if (settings.url.protocol !== 'ldaps:' && !(settings.allowPlain && settings.url.protocol === 'ldap:')) throw new Error('directory sign-in needs an ldaps:// address');
  }

  get label(): string {
    return this.settings.label;
  }

  get source(): string {
    return `ldap:${this.settings.url.host}`;
  }

  private client(): Client {
    const s = this.settings;
    return new Client({
      url: s.url.href.replace(/\/$/, ''),
      timeout: s.timeoutMs,
      connectTimeout: s.timeoutMs,
      // Certificate and host name are always checked; never rejectUnauthorized: false.
      // (Any TLS option turns TLS on, so the plain test stand-in gets none.)
      ...(s.url.protocol === 'ldaps:' ? { tlsOptions: { minVersion: 'TLSv1.2' as const, ...(s.ca ? { ca: s.ca } : {}) } } : {}),
    });
  }

  async authenticate(username: string, password: string): Promise<DirectoryResult> {
    // An empty password is an "unauthenticated bind", which many directories accept as success.
    if (!password || !DIRECTORY_USERNAME.test(username)) return { ok: false, reason: 'invalid' };
    const s = this.settings;
    let entry: Entry;
    const service = this.client();
    try {
      try {
        await service.bind(s.bindDn, s.bindPassword);
      } catch (e) {
        return { ok: false, reason: 'unavailable', detail: `service account bind failed: ${(e as Error).message}` };
      }
      let found: Entry[];
      try {
        const r = await service.search(s.baseDn, {
          scope: 'sub',
          filter: userFilterFor(s.userFilter, username),
          attributes: [s.idAttribute, s.displayNameAttribute, s.groupAttribute],
          explicitBufferAttributes: [s.idAttribute],
          sizeLimit: 2,
        });
        found = r.searchEntries;
      } catch (e) {
        if (e instanceof SizeLimitExceededError) return { ok: false, reason: 'ambiguous', detail: 'more than one directory entry matches' };
        return { ok: false, reason: 'unavailable', detail: `search failed: ${(e as Error).message}` };
      }
      if (found.length === 0) return { ok: false, reason: 'invalid' };
      if (found.length > 1) return { ok: false, reason: 'ambiguous', detail: 'more than one directory entry matches' };
      entry = found[0]!;
    } finally {
      await service.unbind().catch(() => undefined);
    }

    const user = this.client();
    try {
      await user.bind(entry.dn, password);
    } catch (e) {
      if (e instanceof InvalidCredentialsError) return { ok: false, reason: 'invalid' };
      return { ok: false, reason: 'unavailable', detail: `bind as the person failed: ${(e as Error).message}` };
    } finally {
      await user.unbind().catch(() => undefined);
    }

    const idValue = values(entry[s.idAttribute])[0];
    if (idValue === undefined || idValue.length === 0) return { ok: false, reason: 'no-id', detail: `the entry has no ${s.idAttribute}` };
    const id = (typeof idValue === 'string' ? Buffer.from(idValue, 'utf8') : idValue).toString('hex');
    const groups = values(entry[s.groupAttribute]).map(text);
    const roles = [...new Set(groups.flatMap((g) => s.roleMap.get(groupKey(g)) ?? []))];
    const displayName = values(entry[s.displayNameAttribute]).map(text)[0]?.trim() || username;
    return { ok: true, person: { id, dn: entry.dn, username: username.toLowerCase(), displayName: displayName.slice(0, 200), groups, roles } };
  }
}

/** The directory the running web service uses, set by createApp; null when directory sign-in is off. */
let current: Directory | null = null;
export function setDirectory(d: Directory | null): void {
  current = d;
}
export function directory(): Directory | null {
  return current;
}
