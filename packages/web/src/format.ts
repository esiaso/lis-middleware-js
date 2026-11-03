import type { ResultValue } from '@lis/contracts';

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
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
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
  signedout: 'You have signed out.',
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
