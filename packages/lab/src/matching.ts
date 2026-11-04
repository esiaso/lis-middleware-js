import type { ResultValue } from '@lis/contracts';
import { uuidv7, type JsonInput } from '@lis/db';
import { addInstrumentVersion, newResult, type VersionKind } from '@lis/domain';
import { criticalFor } from './critical.js';
import { loadResult, saveResult } from './results.js';
import type { Tx } from './tx.js';

type NormalizedRow = { instrumentId: string; payload: unknown };
type ObservationRow = { id: string; seq: number; value: unknown; units: string | null; abnormalFlags: string[] };

/**
 * Turn one observation into a result version on an ordered test: a new result,
 * or a further version of the existing one (06 §5). Used by matching and by a
 * confirmed link of an unmatched result. Returns the result id.
 */
export async function attachObservation(tx: Tx, nm: NormalizedRow, o: ObservationRow, test: { id: string }): Promise<string> {
  const payload = nm.payload as { observations?: { resultStatus?: string; dilution?: string }[] } | null;
  const meta = payload?.observations?.[o.seq - 1];
  const kind: VersionKind = meta?.dilution ? 'dilution' : meta?.resultStatus === 'rerun' ? 'repeat' : 'initial';
  const version = {
    kind,
    value: o.value as unknown as ResultValue,
    abnormalFlags: o.abnormalFlags,
    observationId: o.id,
    createdBy: `system:${nm.instrumentId}`,
    ...(o.units ? { units: o.units } : {}),
  };
  const existing = await tx.result.findUnique({ where: { orderedTestId: test.id } });
  if (!existing) {
    const resultId = uuidv7();
    const agg = newResult(resultId, version);
    await tx.result.create({ data: { id: resultId, orderedTestId: test.id, status: agg.status, selectedVersionNo: 1, instrumentId: nm.instrumentId } });
    const crit = await criticalFor(tx, resultId, version.value, version.units);
    await tx.resultVersion.create({
      data: {
        id: uuidv7(), resultId, versionNo: 1, kind: version.kind, value: version.value as unknown as JsonInput, units: version.units ?? null, abnormalFlags: version.abnormalFlags, observationId: o.id, createdBy: version.createdBy,
        criticalFlag: crit?.flag ?? null, criticalLimitId: crit?.limitId ?? null, criticalDetail: crit?.detail ?? null,
      },
    });
    return resultId;
  }
  const before = await loadResult(tx, existing.id);
  await saveResult(tx, before, addInstrumentVersion(before.aggregate, { ...version, kind: kind === 'initial' ? 'repeat' : kind }), version.createdBy);
  return existing.id;
}

export type UnmatchedReason = 'UNKNOWN_BARCODE' | 'UNMAPPED_TEST' | 'NOT_ORDERED' | 'CANCELLED_TEST' | 'REJECTED_SPECIMEN';

export interface MatchSummary {
  matched: number;
  unmatched: Partial<Record<UnmatchedReason, number>>;
  qc: number;
}

/**
 * Match one normalised message's observations to specimens and ordered
 * tests (06 §5), inside the intake transaction. Every observation ends up
 * as a result version, as QC, or on the unmatched list with a reason.
 * Patient identity is never inferred from instrument demographics.
 */
export async function matchNormalizedMessage(tx: Tx, normalizedMessageId: string): Promise<MatchSummary> {
  const nm = await tx.normalizedMessage.findUniqueOrThrow({ where: { id: normalizedMessageId }, include: { observations: { orderBy: { seq: 'asc' } } } });
  const summary: MatchSummary = { matched: 0, unmatched: {}, qc: 0 };
  const quarantine = async (observationId: string, reason: UnmatchedReason) => {
    summary.unmatched[reason] = (summary.unmatched[reason] ?? 0) + 1;
    await tx.unmatchedResult.create({ data: { id: uuidv7(), observationId, reason, sampleId: nm.sampleId, instrumentId: nm.instrumentId } });
  };

  // Rule 6: QC never reaches patient tables.
  if (nm.sampleClass === 'qc') {
    summary.qc = nm.observations.length;
    return summary;
  }
  const specimen = nm.sampleId && !nm.sampleIdReadError
    ? await tx.specimen.findFirst({ where: { barcode: nm.sampleId, barcodeActive: true }, include: { tests: true } })
    : null;

  for (const o of nm.observations) {
    if (o.mapping === 'NOT_REPORTABLE' || o.mapping === 'QC') continue;
    if (!specimen) {
      await quarantine(o.id, 'UNKNOWN_BARCODE');
      continue;
    }
    if (o.mapping === 'UNMAPPED' || !o.localTestCode) {
      await quarantine(o.id, 'UNMAPPED_TEST');
      continue;
    }
    if (specimen.status === 'rejected') {
      await quarantine(o.id, 'REJECTED_SPECIMEN');
      continue;
    }
    const test = specimen.tests.find((t) => t.localTestCode === o.localTestCode);
    if (!test) {
      await quarantine(o.id, 'NOT_ORDERED');
      continue;
    }
    if (test.status === 'cancelled') {
      await quarantine(o.id, 'CANCELLED_TEST');
      continue;
    }

    await attachObservation(tx, nm, o, test);
    summary.matched++;
  }
  return summary;
}
