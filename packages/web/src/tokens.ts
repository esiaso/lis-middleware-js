import type { SessionPolicy } from './auth.js';

export const DB = Symbol('lims.db');
export const WEB_OPTIONS = Symbol('lims.web-options');
export const LOGGER = Symbol('lims.logger');

export interface WebOptions {
  /** Reviewer and approver must be different people (10 §2). */
  twoPersonRule: boolean;
  /** Mark cookies Secure and send HSTS. Off only for tests and loopback-only setups. */
  secureCookies: boolean;
  session: SessionPolicy;
}
