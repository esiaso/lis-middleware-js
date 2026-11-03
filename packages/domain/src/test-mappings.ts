import type { Observation, TestMapping, TestMappingSet } from '@lis/contracts';

/**
 * Versioned test mappings. A set is edited only as a draft, approved by a
 * different person (four-eyes), then activated. Results record the version
 * they were mapped with, so a later change never alters stored results.
 */

export type MappingError =
  | { code: 'NOT_DRAFT' | 'NOT_APPROVED' | 'SAME_PERSON' | 'EMPTY' | 'WRONG_INSTRUMENT'; detail: string };

export type MappingResult<T> = { ok: true; value: T } | { ok: false; error: MappingError };

export function newDraft(from: TestMappingSet | undefined, instrumentId: TestMappingSet['instrumentId'], author: string, latestVersionNo: number): TestMappingSet {
  return {
    instrumentId,
    versionNo: latestVersionNo + 1,
    status: 'draft',
    createdBy: author,
    mappings: from ? from.mappings.map((m) => ({ ...m })) : [],
  };
}

export function approve(set: TestMappingSet, approver: string, at: string): MappingResult<TestMappingSet> {
  if (set.status !== 'draft') return { ok: false, error: { code: 'NOT_DRAFT', detail: `set v${set.versionNo} is ${set.status}` } };
  if (approver === set.createdBy) {
    return { ok: false, error: { code: 'SAME_PERSON', detail: 'the author cannot approve their own mapping set' } };
  }
  if (set.mappings.length === 0) return { ok: false, error: { code: 'EMPTY', detail: 'a mapping set needs at least one mapping' } };
  return { ok: true, value: { ...set, status: 'approved', approvedBy: approver, approvedAt: at } };
}

/** Activate an approved set; the previously active one (if any) is retired. */
export function activate(
  set: TestMappingSet,
  currentActive: TestMappingSet | undefined,
): MappingResult<{ active: TestMappingSet; retired?: TestMappingSet }> {
  if (set.status !== 'approved') return { ok: false, error: { code: 'NOT_APPROVED', detail: `set v${set.versionNo} is ${set.status}` } };
  if (currentActive && currentActive.instrumentId !== set.instrumentId) {
    return { ok: false, error: { code: 'WRONG_INSTRUMENT', detail: 'active set belongs to another instrument' } };
  }
  const active: TestMappingSet = { ...set, status: 'active' };
  return currentActive ? { ok: true, value: { active, retired: { ...currentActive, status: 'retired' } } } : { ok: true, value: { active } };
}

export type MappedObservation =
  | { status: 'mapped'; mapping: TestMapping; mappingVersionNo: number }
  | { status: 'not-reportable'; mapping: TestMapping; mappingVersionNo: number }
  | { status: 'unmapped'; mappingVersionNo: number | null };

/**
 * Find the result mapping for an observation. Only an ACTIVE set is used;
 * no active set means every observation is unmapped (and is quarantined).
 */
export function mapObservation(active: TestMappingSet | undefined, obs: Pick<Observation, 'instrumentTestCode' | 'instrumentCodeSystem'>): MappedObservation {
  if (!active || active.status !== 'active') return { status: 'unmapped', mappingVersionNo: null };
  const m = active.mappings.find(
    (x) =>
      (x.direction === 'result' || x.direction === 'both') &&
      x.instrumentTestCode === obs.instrumentTestCode &&
      (x.instrumentCodeSystem ?? '') === (obs.instrumentCodeSystem ?? ''),
  );
  if (!m) return { status: 'unmapped', mappingVersionNo: active.versionNo };
  if (!m.reportable || m.ruo) return { status: 'not-reportable', mapping: m, mappingVersionNo: active.versionNo };
  return { status: 'mapped', mapping: m, mappingVersionNo: active.versionNo };
}
