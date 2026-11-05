import { uuidv7, type Db, type JsonInput } from '@lis/db';
import { newResult, readManualValue } from '@lis/domain';
import { appendAudit } from './audit.js';
import { activeCatalogue, activeEntry, type CatalogueEntry } from './catalogue.js';
import { criticalFor } from './critical.js';
import { deltaColumns, deltaFor } from './delta.js';
import { InvalidInput } from './instruments.js';
import { WorkflowRejected } from './results.js';
import type { Tx } from './tx.js';

/**
 * Results read by a person: malaria smears and rapid tests, urinalysis,
 * microscopy (design: "Manual tests"). They start on the bench worksheet
 * instead of an instrument message, then follow the same review, approval and
 * release. Nothing is pre-filled, so an untouched field never passes as normal.
 */

export interface WorksheetRow {
  orderedTestId: string;
  test: CatalogueEntry;
  accessionNo: string;
  hmisOrderId: string;
  priority: string;
  receivedAt: Date | null;
  patient: { mrn: string; name: string; sex: string | null; birthDate: Date | null };
  location: string | null;
}

const PRIORITY_RANK: Record<string, number> = { stat: 0, urgent: 1, routine: 2 };

/** Received specimens waiting for a manual test, STAT first, then oldest first. */
export async function manualWorksheet(db: Db | Tx, opts: { section?: string } = {}): Promise<WorksheetRow[]> {
  const manual = (await activeCatalogue(db)).filter((e) => e.performedBy === 'MANUAL' && (!opts.section || e.section === opts.section));
  if (manual.length === 0) return [];
  const byCode = new Map(manual.map((e) => [e.localCode, e]));
  const tests = await db.orderedTest.findMany({
    where: { localTestCode: { in: [...byCode.keys()] }, status: 'active', result: null, specimen: { status: 'received' }, order: { status: { not: 'cancelled' } } },
    include: { specimen: true, order: { include: { patient: true } } },
    take: 500,
  });
  return tests
    .map((t) => ({
      orderedTestId: t.id,
      test: byCode.get(t.localTestCode as string) as CatalogueEntry,
      accessionNo: t.specimen?.accessionNo ?? '',
      hmisOrderId: t.order.hmisOrderId,
      priority: t.order.priority,
      receivedAt: t.specimen?.receivedAt ?? null,
      patient: {
        mrn: t.order.patient.mrn,
        name: [t.order.patient.familyName, t.order.patient.givenName].filter(Boolean).join(', '),
        sex: t.order.patient.sex,
        birthDate: t.order.patient.birthDate,
      },
      location: t.order.location,
    }))
    .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) || (a.receivedAt?.getTime() ?? 0) - (b.receivedAt?.getTime() ?? 0));
}

export interface ManualEntry {
  orderedTestId: string;
  /** As typed or picked: a number, an answer code, or text. */
  value: string;
  /** Who read the slide or strip; the person entering when left empty. */
  performedBy?: string;
  /** Kit, strip or stain lot used. */
  lot?: string;
}

/** Enter the first result for a manual test. Returns the new result's id. */
export async function enterManualResult(db: Db, actor: string, input: ManualEntry): Promise<string> {
  const performedBy = (input.performedBy ?? '').trim() || actor;
  const lot = (input.lot ?? '').trim();
  const issues: string[] = [];
  if (performedBy.length > 100) issues.push('The name of who performed the test is at most 100 characters.');
  if (lot.length > 40) issues.push('The lot number is at most 40 characters.');
  if (issues.length) throw new InvalidInput(issues);
  return db.$transaction(async (tx) => {
    const t = await tx.orderedTest.findUnique({ where: { id: input.orderedTestId }, include: { specimen: true, order: true, result: true } });
    if (!t) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'no such ordered test' });
    if (t.result) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'this test already has a result; change it from the result page' });
    if (t.status !== 'active' || t.order.status === 'cancelled') throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'this test is not active (cancelled or moved)' });
    if (!t.specimen || t.specimen.status !== 'received') throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'the specimen has not been received in the lab (or was rejected)' });
    const def = t.localTestCode ? await activeEntry(tx, t.localTestCode) : null;
    if (!def || def.performedBy !== 'MANUAL') throw new WorkflowRejected({ code: 'INVALID_STATE', detail: `${t.localTestCode ?? 'this test'} is not a manual test in the catalogue` });
    const v = readManualValue(def, input.value);
    if (!v.ok) throw new InvalidInput([v.issue]);

    const resultId = uuidv7();
    const version = { kind: 'manual' as const, value: v.value, abnormalFlags: v.abnormalFlags, createdBy: actor, ...(v.units ? { units: v.units } : {}) };
    const agg = newResult(resultId, version);
    await tx.result.create({ data: { id: resultId, orderedTestId: t.id, status: agg.status, selectedVersionNo: 1, instrumentId: null } });
    const crit = await criticalFor(tx, resultId, v.value, v.units);
    const delta = await deltaFor(tx, resultId, v.value, v.units);
    await tx.resultVersion.create({
      data: {
        id: uuidv7(), resultId, versionNo: 1, kind: 'manual', value: v.value as unknown as JsonInput, units: v.units ?? null, abnormalFlags: v.abnormalFlags, createdBy: actor,
        criticalFlag: crit?.flag ?? null, criticalLimitId: crit?.limitId ?? null, criticalDetail: crit?.detail ?? null,
        ...deltaColumns(delta),
      },
    });
    const detail = { performedBy, ...(lot ? { lot } : {}), catalogueVersion: def.versionNo };
    await tx.resultEvent.create({ data: { id: uuidv7(), resultId, kind: 'enter', versionNo: 1, actor, detail } });
    await appendAudit(tx, { actor, action: 'result.enter', entityType: 'result', entityId: resultId, after: { orderedTestId: t.id, localTestCode: def.localCode, value: v.value, ...detail } });
    return resultId;
  });
}

/** Who performed a manual result, from its entry event; null for an instrument result. */
export async function manualPerformer(db: Db | Tx, resultId: string): Promise<{ performedBy: string; enteredBy: string; lot?: string } | null> {
  const e = await db.resultEvent.findFirst({ where: { resultId, kind: 'enter' }, orderBy: { at: 'asc' } });
  if (!e) return null;
  const d = (e.detail ?? {}) as { performedBy?: string; lot?: string };
  return { performedBy: d.performedBy ?? e.actor, enteredBy: e.actor, ...(d.lot ? { lot: d.lot } : {}) };
}
