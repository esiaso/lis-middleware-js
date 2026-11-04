import type { ResultValue } from '@lis/contracts';
import { formatZoned } from '@lis/domain';

/** The lab's time zone (A-24), set once when the app starts. Every page shows times on this clock. */
let zone = 'UTC';
export const setDisplayTimeZone = (tz: string): void => {
  zone = tz;
};
export const displayTimeZone = (): string => zone;

/** Shows a stored value exactly as received: numbers keep their reported digits, never re-rounded. */
export function formatValue(v: ResultValue | null | undefined): string {
  if (!v) return '';
  switch (v.kind) {
    case 'numeric':
      return v.value;
    case 'censored':
      return `${v.comparator}${v.limit}`;
    case 'qualitative':
      return v.code;
    case 'text':
      return v.text;
    case 'absent':
      return `no value (${v.reason})`;
  }
}

export function formatTime(d: Date | null | undefined): string {
  if (!d) return '';
  return formatZoned(d, zone);
}

/** How a value sits against the lab's reference range (A-25); within the range shows nothing. */
export const REFERENCE_MARK: Record<string, string> = { BELOW: 'below range', ABOVE: 'above range', UNITS_DIFFER: 'units differ from the range' };

/** A duration for reports: "under 1 min", "45 min", "2 h 05 min", "3 d 4 h". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '';
  const m = Math.floor(seconds / 60);
  if (m < 1) return 'under 1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** "0:07" or "2:15": hours and minutes since a moment. */
export function elapsed(since: Date, now = new Date()): string {
  const m = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

export const STATUS_LABELS: Record<string, string> = {
  received: 'To review',
  reviewed: 'To approve',
  approved: 'Approved, not released',
  queued: 'Waiting to send',
  sent: 'Sent, awaiting HMIS',
  hmis_confirmed: 'Confirmed by HMIS',
  failed: 'Delivery failed',
  corrected: 'Corrected',
};

/** Only these notices can appear after a redirect, so no request text is ever echoed into a page. */
export const NOTICES: Record<string, string> = {
  reviewed: 'Result reviewed.',
  approved: 'Result approved. Release it to send it to the HMIS.',
  released: 'Result released. It is queued for the HMIS.',
  replayed: 'Delivery queued again.',
  corrected: 'Correction saved and approved. Release it to send it to the HMIS.',
  dismissed: 'Unmatched result closed.',
  registered: 'Instrument registered. It is unverified and disabled until it passes verification.',
  changed: 'Registration saved.',
  reset: 'Registration saved. The change resets the instrument to unverified and turns it off.',
  retest: 'Registration saved. Re-test the link before clinical use continues.',
  evidence: 'Evidence recorded.',
  enabled: 'Instrument turned on.',
  disabled: 'Instrument turned off.',
  draft: 'Mapping draft saved. A different person must approve it.',
  activated: 'Mapping set approved and active.',
  received: 'Specimen received in the lab.',
  rejected: 'Specimen rejected. Tests without a result are back on the collection list if recollection was chosen.',
  reprinted: 'Reprint recorded.',
  'user-created': 'User created with a temporary password. They must choose their own at first sign-in.',
  'roles-saved': 'Roles saved. They apply from the person\'s next page.',
  'user-disabled': 'Account disabled and its sessions ended.',
  'user-enabled': 'Account enabled.',
  'user-unlocked': 'Account unlocked.',
  'password-reset': 'Temporary password set and sessions ended. Give it to the person in private.',
  'password-changed': 'Password changed. Your other sessions have ended.',
  'change-password': 'Choose your own password to continue.',
  'chain-ok': 'Audit chain verified: every event matches its hash and the one before it.',
  'downtime-registered': 'Downtime order registered. Collect and label as usual; results are held from the HMIS until it is reconciled.',
  reconciled: 'Downtime order reconciled. Its specimens and results are now on this HMIS order.',
  'link-proposed': 'Link proposed. A different person must check the patient and confirm it.',
  'link-withdrawn': 'Proposal withdrawn.',
  linked: 'Unmatched result linked. It now needs review and approval like any other result.',
  signedout: 'You have signed out.',
  'critical-called': 'Call recorded. The critical result can now be approved.',
  'limit-added': 'Critical limit saved. It applies to results that arrive from now on.',
  'autoverify-added': 'Autoverification turned on for that test. It applies to results that arrive from now on.',
  'autoverify-retired': 'Autoverification turned off for that test. Results already approved stay approved.',
  'delta-added': 'Delta rule saved. It applies to results that arrive from now on.',
  'delta-retired': 'Delta rule retired. Results already flagged keep their flag.',
  'comment-added': 'Comment added.',
  'comment-withdrawn': 'Comment withdrawn. It stays in the history.',
  'reference-range-added': 'Reference range saved. It applies to values stored from now on.',
  'reference-range-retired': 'Reference range retired. Values stored while it was in force still show it.',
  'standard-comment-added': 'Standard comment saved. It is offered on result pages from now on.',
  'standard-comment-retired': 'Standard comment retired. Comments already made with it are unchanged.',
  'qc-range-added': 'QC range saved. It applies to QC results that arrive from now on.',
  'qc-range-retired': 'QC range retired. Earlier checks keep their outcome.',
  'target-added': 'Turnaround target saved. It applies to the report and the overdue list straight away.',
  'target-retired': 'Turnaround target retired.',
  'limit-retired': 'Critical limit retired. Results already flagged keep their flag.',
};

/** Accept only a local path for the post-login redirect. */
export function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?![/\\])[\w\-./?=&%]*$/.test(next) ? next : '/';
}

/** Value typed by an approver for a correction: decimal, censored (<0.01), or free text. */
export function parseEnteredValue(raw: string): ResultValue | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const num = /^[+-]?\d+(\.\d+)?$/.exec(s);
  if (num) return { kind: 'numeric', value: s, scale: num[1] ? num[1].length - 1 : 0 };
  const cen = /^(<=|>=|<|>)\s*([+-]?\d+(?:\.\d+)?)$/.exec(s);
  if (cen) return { kind: 'censored', comparator: cen[1] as '<' | '<=' | '>' | '>=', limit: cen[2] as string };
  return s.length <= 4000 ? { kind: 'text', text: s } : undefined;
}
