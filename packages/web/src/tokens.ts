import type { SessionPolicy } from './auth.js';
import type { Directory } from './ldap.js';
import type { OidcSettings } from './oidc.js';

export const DB = Symbol('lims.db');
export const WEB_OPTIONS = Symbol('lims.web-options');
export const LOGGER = Symbol('lims.logger');
/** The hospital sign-in client, or null when only local accounts are set up. */
export const OIDC = Symbol('lims.oidc');

export interface WebOptions {
  /** Reviewer and approver must be different people (10 §2). */
  twoPersonRule: boolean;
  /** Mark cookies Secure and send HSTS. Off only for tests and loopback-only setups. */
  secureCookies: boolean;
  session: SessionPolicy;
  /** Hospital sign-in (10 §3); absent means local accounts only. */
  oidc?: OidcSettings;
  /** Directory sign-in over LDAPS (A-29); absent means none. */
  directory?: Directory;
  /** First line of a printed result report, such as the lab's name and address (LIMS_REPORT_HEADER). */
  reportHeader?: string;
  /** IANA time zone for showing and entering times (LIMS_TIME_ZONE, A-24). Default UTC. */
  timeZone?: string;
  /** The audit export signing key (A-16), read at each use; absent means exports are unsigned. */
  auditSigningKey?: () => string | undefined;
}
