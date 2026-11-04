import type { SessionPolicy } from './auth.js';
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
}
