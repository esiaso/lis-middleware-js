import type { ResultValue } from '@lis/contracts';
import { uuidv7, type JsonInput } from '@lis/db';
import { addInstrumentVersion, newResult, type VersionKind } from '@lis/domain';
import { loadResult, saveResult } from './results.js';
import type { Tx } from './tx.js';

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
    ? await tx.specimen.findFirst({ where: { barcode: nm.sampleId, barcodeActive: true }, include: { tests: { include: { result: true } } } })
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

    const payload = nm.payload as unknown as { observations?: { resultStatus?: string; dilution?: string }[] };
    const meta = payload.observations?.[o.seq - 1];
    const kind: VersionKind = meta?.dilution ? 'dilution' : meta?.resultStatus === 'rerun' ? 'repeat' : 'initial';
    const version = {
      kind,
      value: o.value as unknown as ResultValue,
      abnormalFlags: o.abnormalFlags,
      observationId: o.id,
      createdBy: `system:${nm.instrumentId}`,
      ...(o.units ? { units: o.units } : {}),
    };
    if (!test.result) {
      const resultId = uuidv7();
      const agg = newResult(resultId, version);
      await tx.result.create({ data: { id: resultId, orderedTestId: test.id, status: agg.status, selectedVersionNo: 1, instrumentId: nm.instrumentId } });
      await tx.resultVersion.create({
        data: { id: uuidv7(), resultId, versionNo: 1, kind: version.kind, value: version.value as unknown as JsonInput, units: version.units ?? null, abnormalFlags: version.abnormalFlags, observationId: o.id, createdBy: version.createdBy },
      });
      test.result = { id: resultId } as unknown as typeof test.result;
    } else {
      const before = await loadResult(tx, test.result.id);
      await saveResult(tx, before, addInstrumentVersion(before.aggregate, { ...version, kind: kind === 'initial' ? 'repeat' : kind }), version.createdBy);
    }
    summary.matched++;
  }
  return summary;
}
