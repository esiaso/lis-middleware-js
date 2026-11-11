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
 * Instrument downtime (A-41): when an analyser's link to the middleware is
 * down but the analyser itself still measures, its results are typed in from
 * the printout or screen. Each one records the instrument, the run or
 * printout reference, why the link was not used, who ran the sample and who
 * typed it. The result keeps the instrument, so release still follows that
 * instrument's clinical clearance, and it is approved by someone other than
 * the person who typed it, checking against the printout.
 */

export interface TranscribeRow {
  orderedTestId: string;
  test: CatalogueEntry;
  panel: { code: string; name: string } | null;
}

export interface TranscribeCard {
  specimenId: string;
  accessionNo: string;
  hmisOrderId: string;
  priority: string;
  receivedAt: Date | null;
  downtimeOrder: boolean;
  patient: { mrn: string; name: string };
  tests: TranscribeRow[];
}

const PRIORITY_RANK: Record<string, number> = { stat: 0, urgent: 1, routine: 2 };

/**
 * Received specimens with instrument tests that have no result yet, one card
 * per specimen, STAT first then oldest first. An accession narrows it to that
 * specimen (scanned at the bench).
 */
export async function transcribeWorksheet(db: Db | Tx, opts: { accessionNo?: string } = {}): Promise<TranscribeCard[]> {
  const all = await activeCatalogue(db);
  const names = new Map(all.map((e) => [e.localCode, e.name]));
  const byCode = new Map(all.filter((e) => e.performedBy === 'INSTRUMENT' && e.resultType !== 'PANEL').map((e) => [e.localCode, e]));
  if (byCode.size === 0) return [];
  const panelOrder = new Map(all.filter((e) => e.resultType === 'PANEL').map((e) => [e.localCode, e.components ?? []]));
  const accession = (opts.accessionNo ?? '').trim().toUpperCase();
  const tests = await db.orderedTest.findMany({
    where: {
      localTestCode: { in: [...byCode.keys()] },
      status: 'active',
      result: null,
      specimen: { status: 'received', ...(accession ? { accessionNo: accession } : {}) },
      order: { status: { not: 'cancelled' } },
    },
    include: { specimen: true, order: { include: { patient: true } } },
    take: 500,
  });
  const cards = new Map<string, TranscribeCard>();
  for (const t of tests) {
    const s = t.specimen!;
    let card = cards.get(s.id);
    if (!card) {
      card = {
        specimenId: s.id,
        accessionNo: s.accessionNo,
        hmisOrderId: t.order.hmisOrderId,
        priority: t.order.priority,
        receivedAt: s.receivedAt,
        downtimeOrder: t.order.source === 'MANUAL_DOWNTIME',
        patient: { mrn: t.order.patient.mrn, name: [t.order.patient.familyName?.toUpperCase(), t.order.patient.givenName].filter(Boolean).join(', ') },
        tests: [],
      };
      cards.set(s.id, card);
    }
    card.tests.push({
      orderedTestId: t.id,
      test: byCode.get(t.localTestCode as string)!,
      panel: t.panelCode ? { code: t.panelCode, name: names.get(t.panelCode) ?? t.panelCode } : null,
    });
  }
  const pos = (r: TranscribeRow) => (r.panel ? (panelOrder.get(r.panel.code) ?? []).indexOf(r.test.localCode) : -1);
  for (const c of cards.values()) c.tests.sort((a, b) => (a.panel?.code ?? '').localeCompare(b.panel?.code ?? '') || pos(a) - pos(b) || a.test.localCode.localeCompare(b.test.localCode));
  return [...cards.values()].sort(
    (a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) || (a.receivedAt?.getTime() ?? 0) - (b.receivedAt?.getTime() ?? 0) || a.accessionNo.localeCompare(b.accessionNo),
  );
}

export interface TranscribeInput {
  instrumentId: string;
  /** The run, sample or printout reference on the instrument, so the value can be found again. */
  runRef: string;
  /** Why the link was not used, such as "link down since 08:10". */
  reason: string;
  /** Who ran the sample on the instrument; the person typing when left empty. */
  performedBy?: string;
  values: { orderedTestId: string; value: string }[];
}

export interface TranscribedDetail {
  performedBy: string;
  transcribed: { instrumentId: string; runRef: string; reason: string };
  catalogueVersion: number;
}

/**
 * Type in the results of one specimen from an instrument's printout. Fields
 * left empty stay for later; a value that fails its check saves nothing, so
 * a specimen's results are never half-saved by mistake. Returns the new
 * results' ids.
 */
export async function transcribeResults(db: Db, actor: string, input: TranscribeInput): Promise<string[]> {
  const instrumentId = input.instrumentId.trim();
  const runRef = input.runRef.trim();
  const reason = input.reason.trim();
  const performedBy = (input.performedBy ?? '').trim() || actor;
  const issues: string[] = [];
  if (!instrumentId) issues.push('Pick the instrument the sample was run on.');
  if (runRef.length < 1 || runRef.length > 60) issues.push('Give the run, sample or printout reference from the instrument (up to 60 characters).');
  if (reason.length < 5 || reason.length > 300) issues.push('Say why the results are typed in, such as "e411 link down since 08:10" (5 to 300 characters).');
  if (performedBy.length > 100) issues.push('The name of who ran the sample is at most 100 characters.');
  const filled = input.values.filter((v) => v.value.trim());
  if (filled.length === 0) issues.push('Enter at least one result. Empty fields are never taken as normal; they stay on this page.');
  if (issues.length) throw new InvalidInput(issues);

  return db.$transaction(async (tx) => {
    const inst = await tx.instrument.findUnique({ where: { id: instrumentId } });
    if (!inst) throw new InvalidInput([`${instrumentId} is not a registered instrument.`]);
    const tests = await tx.orderedTest.findMany({ where: { id: { in: filled.map((v) => v.orderedTestId) } } });
    if (tests.length !== filled.length || new Set(tests.map((t) => t.specimenId)).size !== 1) {
      throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'these tests are not all on one specimen' });
    }
    const ids: string[] = [];
    const problems: string[] = [];
    for (const v of filled) {
      try {
        ids.push(await transcribeOne(tx, actor, v, { performedBy, instrumentId, runRef, reason }));
      } catch (e) {
        if (!(e instanceof InvalidInput)) throw e;
        const t = tests.find((x) => x.id === v.orderedTestId);
        problems.push(...e.issues.map((i) => `${t?.localTestCode ?? ''}: ${i}`));
      }
    }
    if (problems.length) throw new InvalidInput(problems); // rolls back the ones that passed
    return ids;
  });
}

async function transcribeOne(
  tx: Tx,
  actor: string,
  input: { orderedTestId: string; value: string },
  who: { performedBy: string; instrumentId: string; runRef: string; reason: string },
): Promise<string> {
  const t = await tx.orderedTest.findUnique({ where: { id: input.orderedTestId }, include: { specimen: true, order: true, result: true } });
  if (!t) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'no such ordered test' });
  if (t.result) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'this test already has a result; change it from the result page' });
  if (t.status !== 'active' || t.order.status === 'cancelled') throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'this test is not active (cancelled or moved)' });
  if (!t.specimen || t.specimen.status !== 'received') throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'the specimen has not been received in the lab (or was rejected)' });
  const def = t.localTestCode ? await activeEntry(tx, t.localTestCode) : null;
  if (!def || def.performedBy !== 'INSTRUMENT') {
    throw new WorkflowRejected({ code: 'INVALID_STATE', detail: `${t.localTestCode ?? 'this test'} is not an instrument test in the catalogue; tests read by a person go on the worksheet` });
  }
  const v = readManualValue(def, input.value);
  if (!v.ok) throw new InvalidInput([v.issue]);

  const resultId = uuidv7();
  const agg = newResult(resultId, { kind: 'manual', value: v.value, abnormalFlags: v.abnormalFlags, createdBy: actor, ...(v.units ? { units: v.units } : {}) });
  // The instrument stays on the result, so release still needs that instrument cleared for clinical use.
  await tx.result.create({ data: { id: resultId, orderedTestId: t.id, status: agg.status, selectedVersionNo: 1, instrumentId: who.instrumentId } });
  const crit = await criticalFor(tx, resultId, v.value, v.units);
  const delta = await deltaFor(tx, resultId, v.value, v.units);
  await tx.resultVersion.create({
    data: {
      id: uuidv7(), resultId, versionNo: 1, kind: 'manual', value: v.value as unknown as JsonInput, units: v.units ?? null, abnormalFlags: v.abnormalFlags, createdBy: actor,
      criticalFlag: crit?.flag ?? null, criticalLimitId: crit?.limitId ?? null, criticalDetail: crit?.detail ?? null,
      ...deltaColumns(delta),
    },
  });
  const detail: TranscribedDetail = { performedBy: who.performedBy, transcribed: { instrumentId: who.instrumentId, runRef: who.runRef, reason: who.reason }, catalogueVersion: def.versionNo };
  await tx.resultEvent.create({ data: { id: uuidv7(), resultId, kind: 'enter', versionNo: 1, actor, detail: detail as unknown as JsonInput } });
  await appendAudit(tx, {
    actor,
    action: 'result.transcribe',
    entityType: 'result',
    entityId: resultId,
    reason: who.reason,
    after: { orderedTestId: t.id, localTestCode: def.localCode, value: v.value, ...detail },
  });
  return resultId;
}

/** How a result was typed in from an instrument, from its entry event; null when it was not. */
export async function transcription(db: Db | Tx, resultId: string): Promise<{ enteredBy: string; performedBy: string; instrumentId: string; runRef: string; reason: string } | null> {
  const e = await db.resultEvent.findFirst({ where: { resultId, kind: 'enter' }, orderBy: { at: 'asc' } });
  const d = (e?.detail ?? null) as Partial<TranscribedDetail> | null;
  if (!e || !d?.transcribed) return null;
  return { enteredBy: e.actor, performedBy: d.performedBy ?? e.actor, ...d.transcribed };
}
