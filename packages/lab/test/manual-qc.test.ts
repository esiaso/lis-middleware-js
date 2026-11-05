import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, uuidv7, type Db } from '@lis/db';
import { approveCatalogueEntry, enterManualPanel, enterManualResult, InvalidInput, manualPerformer, passingLots, proposeCatalogueEntry, recordManualQc, verifyAuditChain } from '@lis/lab';
import type { CatalogueForm } from '@lis/domain';

const url = process.env['TEST_DATABASE_URL'];
const TABLES =
  'audit_event, delivery_attempt, outbox_message, result_event, result_comment, result_version, result, unmatched_result, specimen, ordered_test, lab_order, patient, hmis_code_map, test_catalogue, manual_qc';

// Example codes and answers for the tests; the lab chooses its own.
const RDT: CatalogueForm = {
  localCode: 'MAL-RDT', name: 'Malaria rapid test', section: 'Parasitology', loincCode: '', loincDisplay: '', shaCode: '', specimenType: 'Blood',
  performedBy: 'MANUAL', resultType: 'NOMINAL', answers: 'NEG | Negative\nPF | P. falciparum positive | abnormal\nINV | Invalid', unit: '', decimals: '', qcRule: 'BLOCK',
};
const base = { loincCode: '', loincDisplay: '', shaCode: '', specimenType: 'Urine', performedBy: 'MANUAL', answers: '', unit: '', decimals: '', section: 'Urinalysis' };
const PROT: CatalogueForm = { ...base, localCode: 'U-PROT', name: 'Urine protein (dipstick)', resultType: 'ORDINAL', answers: 'NEG | Negative\nTR | Trace\n1P | 1+ | abnormal' };
const PH: CatalogueForm = { ...base, localCode: 'U-PH', name: 'Urine pH (dipstick)', resultType: 'NUMERIC', decimals: '1' };
const UA: CatalogueForm = { ...base, localCode: 'UA', name: 'Urinalysis', resultType: 'PANEL', components: 'U-PROT\nU-PH', qcRule: 'WARN', qcValidHours: '24' };

describe.skipIf(!url)('QC for manual tests (A-33)', () => {
  let db: Db;

  beforeAll(() => {
    db = createDb(url as string);
  });
  afterAll(async () => {
    await db?.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    for (const f of [RDT, PROT, PH, UA]) await approveCatalogueEntry(db, 'dr.lab', (await proposeCatalogueEntry(db, 'lab.manager', f, 'bench test with QC')).id);
  });

  /** A received order for the given codes; a panel's components share one line. */
  async function received(codes: string[], panelCode: string | null = null) {
    const patientId = uuidv7();
    const orderId = uuidv7();
    const specimenId = uuidv7();
    const n = Math.floor(Math.random() * 1e6);
    await db.patient.create({ data: { id: patientId, mrn: `MRN${n}`, familyName: 'Example', givenName: 'Pat', sex: 'F' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: `ORD-${n}`, patientId, priority: 'routine', orderedAt: new Date(), status: 'active', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: `L${n}`, barcode: `L${n}`, status: 'received', receivedAt: new Date(), collectedAt: new Date(), createdBy: 'test' } });
    const ids: string[] = [];
    for (const c of codes) {
      const id = uuidv7();
      await db.orderedTest.create({
        data: { id, orderId, hmisLineId: `LINE-${n}${panelCode ? '' : `-${c}`}`, hmisTestCode: panelCode ?? c, localTestCode: c, status: 'active', specimenId, ...(panelCode ? { panelCode, componentCode: c } : {}) },
      });
      ids.push(id);
    }
    return ids;
  }

  it('refuses a result on a BLOCK test until every control on that lot has passed, and a failure blocks again', async () => {
    const [t1] = await received(['MAL-RDT']);
    const [t2] = await received(['MAL-RDT']);
    await expect(enterManualResult(db, 'tech', { orderedTestId: t1!, value: 'NEG' })).rejects.toThrow(/Enter the kit, strip or stain lot used/);
    await expect(enterManualResult(db, 'tech', { orderedTestId: t1!, value: 'NEG', lot: 'K-101' })).rejects.toThrow(/QC for MAL-RDT lot K-101 has no control recorded/);

    // The outcome follows from the answers; a person cannot call a wrong reading a pass.
    const pos = await recordManualQc(db, 'tech', { localCode: 'MAL-RDT', lot: 'K-101', lotExpiry: '2099-12-31', control: 'positive control', expected: 'PF', observed: 'PF', outcome: 'FAIL' });
    expect(pos).toMatchObject({ outcome: 'PASS', performedBy: 'tech', catalogueVersion: 1 });
    const neg = await recordManualQc(db, 'tech', { localCode: 'MAL-RDT', lot: 'K-101', control: 'negative control', expected: 'NEG', observed: 'INV' });
    expect(neg.outcome).toBe('FAIL');
    await expect(enterManualResult(db, 'tech', { orderedTestId: t1!, value: 'NEG', lot: 'K-101' })).rejects.toThrow(/lot K-101 failed \(negative control\)/);
    expect(await passingLots(db)).toEqual(new Map([['MAL-RDT', []], ['UA', []]]));

    await recordManualQc(db, 'tech', { localCode: 'MAL-RDT', lot: 'K-101', control: 'negative control', expected: 'NEG', observed: 'NEG', performedBy: 'A. Reader' });
    const id = await enterManualResult(db, 'tech', { orderedTestId: t1!, value: 'NEG', lot: 'K-101' });
    expect(await manualPerformer(db, id)).toMatchObject({ lot: 'K-101', qc: { status: 'pass', localCode: 'MAL-RDT', rule: 'BLOCK' } });
    expect((await passingLots(db)).get('MAL-RDT')).toEqual(['K-101']);

    // Another lot is checked on its own.
    await expect(enterManualResult(db, 'tech', { orderedTestId: t2!, value: 'NEG', lot: 'K-102' })).rejects.toThrow(/lot K-102 has no control recorded/);

    // Records cannot be changed or removed.
    await expect(db.manualQc.update({ where: { id: neg.id }, data: { outcome: 'PASS' } })).rejects.toThrow(/append-only/i);
    expect(await db.auditEvent.count({ where: { action: 'manual-qc.record' } })).toBe(3);
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });

  it('refuses a control that is not readable, and a lot past its expiry blocks', async () => {
    const bad = recordManualQc(db, 'tech', { localCode: 'MAL-RDT', lot: '', lotExpiry: '2026-02-30', control: 'positive control', expected: 'PF', observed: '' });
    await expect(bad).rejects.toBeInstanceOf(InvalidInput);
    await expect(bad).rejects.toMatchObject({ issues: ['Give the kit, strip or stain lot, up to 40 characters.', 'The lot expiry is a date, such as 2027-03-31.', 'Say what the control read. An empty field is never taken as a pass.'] });
    await expect(recordManualQc(db, 'tech', { localCode: 'NOPE', lot: 'X', control: 'c', expected: 'a', observed: 'a' })).rejects.toMatchObject({ issues: ['NOPE is not a manual test in the catalogue.'] });

    await recordManualQc(db, 'tech', { localCode: 'MAL-RDT', lot: 'OLD-1', lotExpiry: '2020-01-31', control: 'positive control', expected: 'PF', observed: 'PF' });
    const [t] = await received(['MAL-RDT']);
    await expect(enterManualResult(db, 'tech', { orderedTestId: t!, value: 'NEG', lot: 'OLD-1' })).rejects.toThrow(/lot OLD-1 is past its expiry date/);
  });

  it("follows the panel's rule for its components: WARN saves the results and keeps the QC gap with each", async () => {
    const [prot, ph] = await received(['U-PROT', 'U-PH'], 'UA');
    const ids = await enterManualPanel(db, 'tech', { values: [{ orderedTestId: prot!, value: 'NEG' }, { orderedTestId: ph!, value: '6.0' }], lot: 'S-9' });
    for (const id of ids) expect(await manualPerformer(db, id)).toMatchObject({ lot: 'S-9', qc: { status: 'missing', localCode: 'UA', rule: 'WARN' } });

    // The panel's control counts for its components, for 24 hours.
    await recordManualQc(db, 'tech', { localCode: 'UA', lot: 'S-10', control: 'control strip level 1', expected: 'as on the insert', observed: 'all pads in range', outcome: 'PASS' });
    const [p2] = await received(['U-PROT', 'U-PH'], 'UA');
    const [id] = await enterManualPanel(db, 'tech', { values: [{ orderedTestId: p2!, value: 'TR' }], lot: 'S-10' });
    expect(await manualPerformer(db, id!)).toMatchObject({ qc: { status: 'pass', localCode: 'UA' } });
    await db.$executeRawUnsafe(`ALTER TABLE manual_qc DISABLE TRIGGER manual_qc_append_only`);
    await db.$executeRawUnsafe(`UPDATE manual_qc SET at = at - interval '25 hours'`);
    await db.$executeRawUnsafe(`ALTER TABLE manual_qc ENABLE TRIGGER manual_qc_append_only`);
    expect((await passingLots(db)).get('UA')).toEqual([]);
  });
});
