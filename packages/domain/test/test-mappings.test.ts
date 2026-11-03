import { describe, expect, it } from 'vitest';
import { InstrumentId, TestMappingSet } from '@lis/contracts';
import { activate, approve, mapObservation, newDraft } from '@lis/domain';

const id = InstrumentId.parse('chem-02');

describe('test mapping sets', () => {
  const draft = { ...newDraft(undefined, id, 'tech.a', 0), mappings: [
    { localTestCode: 'GLU', instrumentTestCode: 'GLU', direction: 'result' as const, reportable: true, ruo: false },
    { localTestCode: 'X-RUO', instrumentTestCode: 'XR', direction: 'result' as const, reportable: true, ruo: true },
  ] };

  it('requires a different person to approve, then activates and retires the old set', () => {
    expect(draft.versionNo).toBe(1);
    expect(approve(draft, 'tech.a', '2026-11-03T10:00:00Z')).toMatchObject({ ok: false, error: { code: 'SAME_PERSON' } });
    const ok = approve(draft, 'dr.lab', '2026-11-03T10:00:00Z');
    if (!ok.ok) throw new Error();
    expect(TestMappingSet.safeParse(ok.value).success).toBe(true);
    const a1 = activate(ok.value, undefined);
    if (!a1.ok) throw new Error();

    const v2 = newDraft(a1.value.active, id, 'tech.b', 1);
    expect(v2).toMatchObject({ versionNo: 2, status: 'draft' });
    const v2ok = approve(v2, 'dr.lab', '2026-11-04T10:00:00Z');
    if (!v2ok.ok) throw new Error();
    const a2 = activate(v2ok.value, a1.value.active);
    expect(a2).toMatchObject({ ok: true, value: { active: { versionNo: 2, status: 'active' }, retired: { versionNo: 1, status: 'retired' } } });
  });

  it('does not activate a draft', () => {
    expect(activate(draft, undefined)).toMatchObject({ ok: false, error: { code: 'NOT_APPROVED' } });
  });

  it('maps only through the active set and never reports RUO parameters', () => {
    const ok = approve(draft, 'dr.lab', '2026-11-03T10:00:00Z');
    if (!ok.ok) throw new Error();
    const act = activate(ok.value, undefined);
    if (!act.ok) throw new Error();
    expect(mapObservation(act.value.active, { instrumentTestCode: 'GLU' })).toMatchObject({ status: 'mapped', mappingVersionNo: 1 });
    expect(mapObservation(act.value.active, { instrumentTestCode: 'XR' })).toMatchObject({ status: 'not-reportable' });
    expect(mapObservation(act.value.active, { instrumentTestCode: 'NA' })).toEqual({ status: 'unmapped', mappingVersionNo: 1 });
    expect(mapObservation(ok.value, { instrumentTestCode: 'GLU' })).toEqual({ status: 'unmapped', mappingVersionNo: null });
  });

  it('rejects duplicate result mappings for the same instrument code', () => {
    const bad = { ...draft, mappings: [
      { localTestCode: 'GLU', instrumentTestCode: 'GLU', direction: 'both' as const, reportable: true, ruo: false },
      { localTestCode: 'GLU2', instrumentTestCode: 'GLU', direction: 'result' as const, reportable: true, ruo: false },
    ] };
    expect(TestMappingSet.safeParse(bad).success).toBe(false);
  });
});
