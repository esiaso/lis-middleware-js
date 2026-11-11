import { createHash } from 'node:crypto';
import type { Db } from '@lis/db';
import { appendAudit } from './audit.js';
import { InvalidInput } from './instruments.js';

/**
 * The letterhead on printed lab reports (A-42): the lab's name, address and
 * contact details, accreditation wording, a footer note and a logo. One row,
 * changed by an admin and audited; until it is saved, reports fall back to
 * the LIMS_REPORT_HEADER setting. The logo is kept in the database so it is
 * backed up with everything else and needs no file store or internet access.
 */

export const LOGO_MAX_BYTES = 256 * 1024;
const ID = 'lab';

export interface ReportHeaderInput {
  labName: string;
  subtitle: string;
  address: string;
  phone: string;
  email: string;
  accreditation: string;
  reportTitle: string;
  footerNote: string;
}

export interface ReportHeader {
  labName: string;
  subtitle: string;
  /** One entry per line of the address. */
  addressLines: string[];
  phone: string;
  email: string;
  accreditation: string;
  reportTitle: string;
  footerNote: string;
  /** Short hash of the logo, for a cache-safe image link; null without a logo. */
  logoVersion: string | null;
  updatedBy: string;
  updatedAt: Date;
}

const LIMITS: [keyof ReportHeaderInput, string, number][] = [
  ['labName', 'Lab name', 120],
  ['subtitle', 'Second line', 120],
  ['address', 'Address', 300],
  ['phone', 'Phone', 60],
  ['email', 'Email', 120],
  ['accreditation', 'Accreditation', 200],
  ['reportTitle', 'Report title', 60],
  ['footerNote', 'Footer note', 500],
];

/** Trim and check the letterhead form; returns the issues, or the clean values. */
export function parseReportHeader(form: Partial<Record<keyof ReportHeaderInput, string>>): { ok: true; value: ReportHeaderInput } | { ok: false; issues: string[] } {
  const v = Object.fromEntries(LIMITS.map(([k]) => [k, (form[k] ?? '').replace(/\r\n?/g, '\n').trim()])) as unknown as ReportHeaderInput;
  v.address = v.address.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  const issues: string[] = [];
  if (!v.labName) issues.push('Give the lab name as it should print at the top of every report.');
  if (!v.reportTitle) issues.push('Give the report title, such as "Laboratory report".');
  for (const [k, label, max] of LIMITS) if (v[k].length > max) issues.push(`${label} is at most ${max} characters.`);
  if (v.address.split('\n').length > 4) issues.push('Keep the address to 4 lines.');
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) issues.push('The email address does not look right.');
  for (const [k, label] of LIMITS) if (k !== 'address' && k !== 'footerNote' && /\n/.test(v[k])) issues.push(`${label} is one line.`);
  return issues.length ? { ok: false, issues } : { ok: true, value: v };
}

/** The saved letterhead, or null when none has been saved yet. */
export async function reportHeader(db: Db): Promise<ReportHeader | null> {
  const s = await db.reportSettings.findUnique({ where: { id: ID }, omit: { logo: true } });
  if (!s) return null;
  return {
    labName: s.labName,
    subtitle: s.subtitle ?? '',
    addressLines: (s.address ?? '').split('\n').filter(Boolean),
    phone: s.phone ?? '',
    email: s.email ?? '',
    accreditation: s.accreditation ?? '',
    reportTitle: s.reportTitle,
    footerNote: s.footerNote ?? '',
    logoVersion: s.logoSha256 ? s.logoSha256.slice(0, 12) : null,
    updatedBy: s.updatedBy,
    updatedAt: s.updatedAt,
  };
}

/** The logo's bytes and type, or null. */
export async function reportLogo(db: Db): Promise<{ bytes: Buffer; type: string } | null> {
  const s = await db.reportSettings.findUnique({ where: { id: ID }, select: { logo: true, logoType: true } });
  return s?.logo && s.logoType ? { bytes: Buffer.from(s.logo), type: s.logoType } : null;
}

const textColumns = (v: ReportHeaderInput) => ({
  labName: v.labName,
  subtitle: v.subtitle || null,
  address: v.address || null,
  phone: v.phone || null,
  email: v.email || null,
  accreditation: v.accreditation || null,
  reportTitle: v.reportTitle,
  footerNote: v.footerNote || null,
});

/** Save the letterhead text; the logo is left as it is. */
export async function saveReportHeader(db: Db, actor: string, form: Partial<Record<keyof ReportHeaderInput, string>>): Promise<void> {
  const parsed = parseReportHeader(form);
  if (!parsed.ok) throw new InvalidInput(parsed.issues);
  const data = textColumns(parsed.value);
  await db.$transaction(async (tx) => {
    const before = await tx.reportSettings.findUnique({ where: { id: ID }, omit: { logo: true } });
    await tx.reportSettings.upsert({ where: { id: ID }, create: { id: ID, ...data, updatedBy: actor }, update: { ...data, updatedBy: actor, updatedAt: new Date() } });
    await appendAudit(tx, {
      actor,
      action: 'report-header.update',
      entityType: 'report_settings',
      entityId: ID,
      before: before ? textColumns(nullsToEmpty(before)) : null,
      after: data,
    });
  });
}

function nullsToEmpty(s: { labName: string; subtitle: string | null; address: string | null; phone: string | null; email: string | null; accreditation: string | null; reportTitle: string; footerNote: string | null }): ReportHeaderInput {
  return { labName: s.labName, subtitle: s.subtitle ?? '', address: s.address ?? '', phone: s.phone ?? '', email: s.email ?? '', accreditation: s.accreditation ?? '', reportTitle: s.reportTitle, footerNote: s.footerNote ?? '' };
}

/** The image type from its first bytes: only PNG and JPEG are taken (no SVG, which can carry script). */
export function logoType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

/** Replace the logo. The letterhead text must be saved first. */
export async function setReportLogo(db: Db, actor: string, bytes: Uint8Array): Promise<void> {
  if (bytes.length === 0) throw new InvalidInput(['Choose a logo file to upload.']);
  if (bytes.length > LOGO_MAX_BYTES) throw new InvalidInput([`The logo is ${Math.ceil(bytes.length / 1024)} KB; it can be at most ${LOGO_MAX_BYTES / 1024} KB. Save it smaller and try again.`]);
  const type = logoType(bytes);
  if (!type) throw new InvalidInput(['The logo must be a PNG or JPEG image.']);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await db.$transaction(async (tx) => {
    const before = await tx.reportSettings.findUnique({ where: { id: ID }, select: { logoSha256: true } });
    if (!before) throw new InvalidInput(['Save the lab name and details first, then add the logo.']);
    await tx.reportSettings.update({ where: { id: ID }, data: { logo: Buffer.from(bytes), logoType: type, logoSha256: sha256, updatedBy: actor, updatedAt: new Date() } });
    await appendAudit(tx, { actor, action: 'report-header.logo', entityType: 'report_settings', entityId: ID, before: { logoSha256: before.logoSha256 }, after: { logoSha256: sha256, logoType: type, bytes: bytes.length } });
  });
}

/** Take the logo off the reports. */
export async function removeReportLogo(db: Db, actor: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const before = await tx.reportSettings.findUnique({ where: { id: ID }, select: { logoSha256: true } });
    if (!before?.logoSha256) return;
    await tx.reportSettings.update({ where: { id: ID }, data: { logo: null, logoType: null, logoSha256: null, updatedBy: actor, updatedAt: new Date() } });
    await appendAudit(tx, { actor, action: 'report-header.logo-removed', entityType: 'report_settings', entityId: ID, before: { logoSha256: before.logoSha256 }, after: { logoSha256: null } });
  });
}
