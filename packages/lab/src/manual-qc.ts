import { uuidv7, type Db } from '@lis/db';
import { judgeManualQc, manualQcStatus, type ManualQcForm, type ManualQcStatus } from '@lis/domain';
import { appendAudit } from './audit.js';
import { activeCatalogue, activeEntry, type CatalogueEntry } from './catalogue.js';
import { InvalidInput } from './instruments.js';
import type { Tx } from './tx.js';

/**
 * Quality control for tests read by a person (design: "Manual tests", A-33):
 * a positive and negative control on each new RDT kit lot, a known slide for
 * a stain batch, a control strip for a dipstick lot. Each manual test or panel
 * in the catalogue says whether a result can be entered without a passing
 * control for the lot used: no check, a warning kept with the result, or a block.
 */

export interface ManualQcInput extends ManualQcForm {
  localCode: string;
  lot: string;
  /** YYYY-MM-DD, the last day the lot may be used, from the kit box. */
  lotExpiry?: string;
  performedBy?: string;
  comment?: string;
}

export interface ManualQcRecord {
  id: string;
  localCode: string;
  lot: string;
  lotExpiry: Date | null;
  control: string;
  expected: string;
  observed: string;
  outcome: 'PASS' | 'FAIL';
  comment: string | null;
  performedBy: string;
  enteredBy: string;
  at: Date;
}

/** Record one control run. A failed control is recorded too: it blocks or warns until that control passes again. */
export async function recordManualQc(db: Db, actor: string, input: ManualQcInput): Promise<ManualQcRecord> {
  const issues: string[] = [];
  const lot = input.lot.trim();
  if (lot.length < 1 || lot.length > 40) issues.push('Give the kit, strip or stain lot, up to 40 characters.');
  const performedBy = (input.performedBy ?? '').trim() || actor;
  if (performedBy.length > 100) issues.push('The name of who ran the control is at most 100 characters.');
  const comment = (input.comment ?? '').trim();
  if (comment.length > 500) issues.push('The comment is at most 500 characters.');
  let lotExpiry: Date | null = null;
  const exp = (input.lotExpiry ?? '').trim();
  if (exp) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(exp) ? new Date(`${exp}T00:00:00Z`) : null;
    if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== exp) issues.push('The lot expiry is a date, such as 2027-03-31.');
    else lotExpiry = d;
  }
  const def = await activeEntry(db, input.localCode);
  if (!def || def.performedBy !== 'MANUAL') throw new InvalidInput([...issues, `${input.localCode || 'That test'} is not a manual test in the catalogue.`]);
  const j = judgeManualQc(def, input);
  if (!j.ok) issues.push(...j.issues);
  if (issues.length || !j.ok) throw new InvalidInput(issues);

  return db.$transaction(async (tx) => {
    const row = await tx.manualQc.create({
      data: {
        id: uuidv7(), localCode: def.localCode, catalogueVersion: def.versionNo, lot, lotExpiry, control: j.control, expected: j.expected, observed: j.observed,
        outcome: j.outcome, comment: comment || null, performedBy, enteredBy: actor,
      },
    });
    await appendAudit(tx, {
      actor, action: 'manual-qc.record', entityType: 'manual_qc', entityId: row.id,
      after: { localCode: def.localCode, lot, control: j.control, expected: j.expected, observed: j.observed, outcome: j.outcome, performedBy, ...(lotExpiry ? { lotExpiry: exp } : {}) },
    });
    return toRecord(row);
  });
}

type Row = Awaited<ReturnType<Db['manualQc']['findFirstOrThrow']>>;
const toRecord = (r: Row): ManualQcRecord => ({ ...r, outcome: r.outcome as 'PASS' | 'FAIL' });

/** The latest control runs, newest first. */
export async function recentManualQc(db: Db | Tx, opts: { localCode?: string; take?: number } = {}): Promise<ManualQcRecord[]> {
  const rows = await db.manualQc.findMany({ where: opts.localCode ? { localCode: opts.localCode } : {}, orderBy: { at: 'desc' }, take: opts.take ?? 100 });
  return rows.map(toRecord);
}

/** The catalogue entry whose QC rule covers this test: its panel's when the panel sets one, otherwise its own. */
export function qcGoverning(def: CatalogueEntry, panel: CatalogueEntry | null): CatalogueEntry | null {
  if (panel?.qcRule) return panel;
  return def.qcRule ? def : null;
}

export interface LotQc {
  rule: 'WARN' | 'BLOCK';
  /** The test or panel whose controls count. */
  localCode: string;
  lot: string;
  status: ManualQcStatus;
  failed: string[];
  lastPass?: Date;
}

/** QC for one lot of a test, now. */
export async function lotQc(db: Db | Tx, governing: CatalogueEntry, lot: string, now = new Date()): Promise<LotQc> {
  const rows = lot ? await db.manualQc.findMany({ where: { localCode: governing.localCode, lot } }) : [];
  const s = manualQcStatus(rows.map((r) => ({ control: r.control, outcome: r.outcome as 'PASS' | 'FAIL', at: r.at, lotExpiry: r.lotExpiry })), now, governing.qcValidHours);
  return { rule: governing.qcRule as 'WARN' | 'BLOCK', localCode: governing.localCode, lot, ...s };
}

/** For the worksheet: the lots of each QC-ruled test or panel that may be used now. */
export async function passingLots(db: Db | Tx, now = new Date()): Promise<Map<string, string[]>> {
  const ruled = (await activeCatalogue(db)).filter((e) => e.performedBy === 'MANUAL' && e.qcRule);
  const out = new Map<string, string[]>();
  if (ruled.length === 0) return out;
  const oldest = Math.max(...ruled.map((e) => e.qcValidHours ?? Infinity));
  const rows = await db.manualQc.findMany({
    where: { localCode: { in: ruled.map((e) => e.localCode) }, ...(Number.isFinite(oldest) ? { at: { gte: new Date(now.getTime() - oldest * 3600 * 1000) } } : {}) },
    select: { localCode: true, lot: true },
    distinct: ['localCode', 'lot'],
    take: 2000,
  });
  for (const e of ruled) {
    const lots: string[] = [];
    for (const lot of [...new Set(rows.filter((r) => r.localCode === e.localCode).map((r) => r.lot))].sort()) {
      if ((await lotQc(db, e, lot, now)).status === 'pass') lots.push(lot);
    }
    out.set(e.localCode, lots);
  }
  return out;
}

/** Entry refused because the lot has no passing control (BLOCK). */
export class QcBlocked extends InvalidInput {}

const STATUS_WORDS: Record<ManualQcStatus, string> = {
  pass: 'passed',
  missing: 'has no control recorded',
  failed: 'failed',
  expired: 'is past its expiry date',
};

/** Why a lot cannot be used, in words for the worksheet. */
export function lotQcProblem(q: LotQc): string {
  if (!q.lot) return `Enter the kit, strip or stain lot used: ${q.localCode} needs a passing control for its lot.`;
  const which = q.status === 'failed' ? ` (${q.failed.join(', ')})` : '';
  return `QC for ${q.localCode} lot ${q.lot} ${STATUS_WORDS[q.status]}${which}. Run and record the control on the manual QC page first.`;
}
