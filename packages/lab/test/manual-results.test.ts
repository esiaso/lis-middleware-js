import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, uuidv7, type Db } from '@lis/db';
import { FhirR4Hmis } from '@lis/hmis';
import {
  accessionSpecimen, activeCatalogue, approve, approveCatalogueEntry, deliverOutbox, discardCatalogueDraft, downtimeTestCatalogue, enterManualPanel, enterManualResult, InvalidInput,
  manualPerformer, manualWorksheet, proposeCatalogueEntry, pullOrders, receiveSpecimen, release, retireCatalogueEntry, review, verifyAuditChain, WorkflowRejected,
} from '@lis/lab';
import type { CatalogueForm } from '@lis/domain';
import { feedLine, startStubFhir, SYSTEMS, type StubFhir } from '../../hmis/test/fhir-stub.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES =
  'audit_event, delivery_attempt, outbox_message, result_event, result_comment, result_version, result, unmatched_result, specimen, ordered_test, lab_order, patient, hmis_code_map, hmis_cursor, test_catalogue';

// The codes and answers below are examples for the tests; the lab chooses its own.
const RDT: CatalogueForm = {
  localCode: 'MAL-RDT', name: 'Malaria rapid test', section: 'Parasitology', loincCode: '32700-7', loincDisplay: 'Example LOINC name', shaCode: '', specimenType: 'Blood',
  performedBy: 'MANUAL', resultType: 'NOMINAL', answers: 'NEG | Negative | LA6577-6\nPF | P. falciparum positive | abnormal\nINV | Invalid', unit: '', decimals: '',
};
const DENSITY: CatalogueForm = { ...RDT, localCode: 'MAL-DENS', name: 'Malaria parasite density', loincCode: '', loincDisplay: '', resultType: 'NUMERIC', answers: '', unit: '/uL', decimals: '0' };

describe.skipIf(!url)('test catalogue and manual results', () => {
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
  });

  async function activate(f: CatalogueForm) {
    const d = await proposeCatalogueEntry(db, 'lab.manager', f, 'new test for the bench');
    return approveCatalogueEntry(db, 'dr.lab', d.id);
  }

  /** An HMIS order for one test, with its specimen received in the lab. */
  async function receivedOrder(localTestCode: string, hmisTestCode: string, priority = 'routine') {
    const patientId = uuidv7();
    const orderId = uuidv7();
    const specimenId = uuidv7();
    const testId = uuidv7();
    const n = Math.floor(Math.random() * 1e6);
    await db.patient.create({ data: { id: patientId, mrn: `MRN${n}`, familyName: 'Example', givenName: 'Pat', sex: 'F' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: `ORD-${n}`, patientId, priority, orderedAt: new Date(), status: 'active', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: `L${n}`, barcode: `L${n}`, status: 'received', receivedAt: new Date(), collectedAt: new Date(), createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: `LINE-${n}`, hmisTestCode, localTestCode, status: 'active', specimenId } });
    return { testId, specimenId, mrn: `MRN${n}`, line: `LINE-${n}` };
  }

  it('makes a change active only when a second person approves it, and links its LOINC code to HMIS orders', async () => {
    const d = await proposeCatalogueEntry(db, 'lab.manager', RDT, 'new test for the bench');
    expect(d).toMatchObject({ status: 'DRAFT', versionNo: 1 });
    expect(await activeCatalogue(db)).toEqual([]);
    await expect(approveCatalogueEntry(db, 'lab.manager', d.id)).rejects.toMatchObject({ error: { code: 'SAME_PERSON' } });
    await expect(proposeCatalogueEntry(db, 'other', RDT, 'second draft')).rejects.toThrow(/already has a change waiting/);

    await approveCatalogueEntry(db, 'dr.lab', d.id);
    expect((await activeCatalogue(db)).map((e) => [e.localCode, e.versionNo, e.approvedBy])).toEqual([['MAL-RDT', 1, 'dr.lab']]);
    expect(await db.hmisCodeMap.findUnique({ where: { hmisTestCode: '32700-7' } })).toMatchObject({ localTestCode: 'MAL-RDT' });
    expect(await downtimeTestCatalogue(db)).toContain('MAL-RDT');

    // A second version retires the first; the database itself refuses a self-approval.
    const v2 = await proposeCatalogueEntry(db, 'lab.manager', { ...RDT, name: 'Malaria RDT' }, 'shorter name');
    await approveCatalogueEntry(db, 'dr.lab', v2.id);
    expect((await db.testCatalogueEntry.findMany({ orderBy: { versionNo: 'asc' } })).map((r) => [r.versionNo, r.status])).toEqual([[1, 'RETIRED'], [2, 'ACTIVE']]);
    await expect(db.testCatalogueEntry.update({ where: { id: v2.id }, data: { approvedBy: 'lab.manager' } })).rejects.toThrow(/two_person/);
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });

  it('refuses a LOINC code already linked to another test, and can discard or retire', async () => {
    await activate(RDT);
    const clash = await proposeCatalogueEntry(db, 'lab.manager', { ...DENSITY, loincCode: '32700-7' }, 'mistake');
    await expect(approveCatalogueEntry(db, 'dr.lab', clash.id)).rejects.toThrow(InvalidInput);
    expect(await db.testCatalogueEntry.findUniqueOrThrow({ where: { id: clash.id } })).toMatchObject({ status: 'DRAFT' });
    await discardCatalogueDraft(db, 'dr.lab', clash.id, 'wrong code');
    await retireCatalogueEntry(db, 'dr.lab', 'MAL-RDT', 'kit no longer used');
    expect(await activeCatalogue(db)).toEqual([]);
    await expect(proposeCatalogueEntry(db, 'lab.manager', { ...RDT, loincCode: '32700-1' }, 'typo')).rejects.toThrow(/check digit/);
  });

  it('lists received specimens waiting for a manual test, STAT first', async () => {
    await activate(RDT);
    const routine = await receivedOrder('MAL-RDT', '32700-7');
    const stat = await receivedOrder('MAL-RDT', '32700-7', 'stat');
    const notReceived = await receivedOrder('MAL-RDT', '32700-7');
    await db.specimen.update({ where: { id: notReceived.specimenId }, data: { status: 'collected' } });
    await receivedOrder('TSH', 'HMIS-TSH'); // not a manual test
    expect((await manualWorksheet(db)).map((r) => r.orderedTestId)).toEqual([stat.testId, routine.testId]);
    expect(await manualWorksheet(db, { section: 'Urinalysis' })).toEqual([]);
  });

  it('enters a checked value, keeps who performed it, and leaves the worksheet', async () => {
    await activate(RDT);
    const o = await receivedOrder('MAL-RDT', '32700-7');
    await expect(enterManualResult(db, 'tech.a', { orderedTestId: o.testId, value: '' })).rejects.toThrow(/never taken as normal/);
    await expect(enterManualResult(db, 'tech.a', { orderedTestId: o.testId, value: 'positive' })).rejects.toThrow(/Pick one of the answers/);
    const id = await enterManualResult(db, 'tech.a', { orderedTestId: o.testId, value: 'PF', performedBy: 'tech.b', lot: 'RDT-2611' });
    const r = await db.result.findUniqueOrThrow({ where: { id }, include: { versions: true } });
    expect(r).toMatchObject({ status: 'received', instrumentId: null, selectedVersionNo: 1 });
    expect(r.versions[0]).toMatchObject({ kind: 'manual', value: { kind: 'qualitative', code: 'PF' }, abnormalFlags: ['A'], createdBy: 'tech.a' });
    expect(await manualPerformer(db, id)).toEqual({ performedBy: 'tech.b', enteredBy: 'tech.a', lot: 'RDT-2611' });
    expect(await manualWorksheet(db)).toEqual([]);
    await expect(enterManualResult(db, 'tech.a', { orderedTestId: o.testId, value: 'NEG' })).rejects.toThrow(WorkflowRejected);
  });

  it('a number keeps the catalogue unit and decimals', async () => {
    await activate(DENSITY);
    const o = await receivedOrder('MAL-DENS', 'HMIS-DENS');
    await expect(enterManualResult(db, 'tech.a', { orderedTestId: o.testId, value: '1200.5' })).rejects.toThrow(/no decimals/);
    const id = await enterManualResult(db, 'tech.a', { orderedTestId: o.testId, value: '1200' });
    expect(await db.resultVersion.findFirstOrThrow({ where: { resultId: id } })).toMatchObject({ value: { kind: 'numeric', value: '1200', scale: 0 }, units: '/uL' });
  });

  it('the person who read the test does not approve it', async () => {
    await activate(RDT);
    const o = await receivedOrder('MAL-RDT', '32700-7');
    const id = await enterManualResult(db, 'tech.a', { orderedTestId: o.testId, value: 'NEG', performedBy: 'dr.lab' });
    await review(db, id, 'tech.a', 1);
    await expect(approve(db, id, 'dr.lab', { twoPersonRule: true })).rejects.toMatchObject({ error: { code: 'SAME_PERSON' } });
    await approve(db, id, 'dr.other', { twoPersonRule: true });
  });

  describe('delivery over FHIR (stand-in HMIS)', () => {
    let stub: StubFhir;
    beforeEach(async () => {
      stub = await startStubFhir();
    });
    afterEach(async () => {
      await stub.close();
    });

    it('sends a coded answer with its LOINC answer code and words', async () => {
      await activate(RDT);
      const o = await receivedOrder('MAL-RDT', '32700-7');
      const id = await enterManualResult(db, 'tech.a', { orderedTestId: o.testId, value: 'NEG', lot: 'RDT-2611' });
      await review(db, id, 'tech.a', 1);
      await approve(db, id, 'dr.lab', { twoPersonRule: true });
      await release(db, id, { username: 'dr.lab', displayName: 'Dr Lab' });
      expect((await db.outboxMessage.findFirstOrThrow()).payload).toMatchObject({ testCode: '32700-7', value: { type: 'coded', code: 'LA6577-6', system: 'http://loinc.org', display: 'Negative' } });
      const hmis = new FhirR4Hmis({
        baseUrl: new URL(stub.base), tokenUrl: new URL(stub.tokenUrl), clientId: stub.clientId, clientSecret: () => stub.clientSecret, scopes: 'system/*.*', pageSize: 10,
        systems: { ...SYSTEMS, test: 'http://loinc.org' }, limsSystemPrefix: 'urn:lims-middleware:', timeoutMs: 2000, allowHttp: true,
      });
      expect((await deliverOutbox(db, hmis, 'jobs:1'))[0]).toMatchObject({ outcome: 'accepted', resultStatus: 'hmis_confirmed' });
      const obs = [...stub.store.entries()].find(([k]) => k.startsWith('Observation/'))![1];
      expect(obs).toMatchObject({
        code: { coding: [{ system: 'http://loinc.org', code: '32700-7' }] },
        valueCodeableConcept: { coding: [{ system: 'http://loinc.org', code: 'LA6577-6', display: 'Negative' }], text: 'Negative' },
      });
    });

    it('an answer without a LOINC code goes as its words, with no system made up', async () => {
      await activate(RDT);
      const o = await receivedOrder('MAL-RDT', '32700-7');
      const id = await enterManualResult(db, 'tech.a', { orderedTestId: o.testId, value: 'PF' });
      await review(db, id, 'tech.b', 1);
      await approve(db, id, 'dr.lab', { twoPersonRule: true });
      await release(db, id, { username: 'dr.lab', displayName: 'Dr Lab' });
      expect((await db.outboxMessage.findFirstOrThrow()).payload).toMatchObject({ value: { type: 'coded', code: 'PF', display: 'P. falciparum positive' } });
      expect(((await db.outboxMessage.findFirstOrThrow()).payload as { value: { system?: string } }).value.system).toBeUndefined();
    });
  });
});

// Panels (A-32). Codes are examples for the tests; the lab chooses its own.
describe.skipIf(!url)('panels', () => {
  let db: Db;
  let stub: StubFhir;
  let hmis: FhirR4Hmis;
  const base = { loincDisplay: '', shaCode: '', specimenType: 'Urine', performedBy: 'MANUAL', answers: '', unit: '', decimals: '', section: 'Urinalysis' };
  const PROT: CatalogueForm = { ...base, localCode: 'U-PROT', name: 'Urine protein (dipstick)', loincCode: '20454-5', resultType: 'ORDINAL', answers: 'NEG | Negative\nTR | Trace\n1P | 1+ | abnormal' };
  const RBC: CatalogueForm = { ...base, localCode: 'U-RBC', name: 'Urine RBC per HPF', loincCode: '13945-1', resultType: 'NUMERIC', unit: '/[HPF]', decimals: '0' };
  const PH: CatalogueForm = { ...base, localCode: 'U-PH', name: 'Urine pH (dipstick)', loincCode: '', resultType: 'NUMERIC', decimals: '1' };
  const UA: CatalogueForm = { ...base, localCode: 'UA', name: 'Urinalysis', loincCode: '24356-8', resultType: 'PANEL', components: 'U-PROT\nU-RBC\nU-PH' };

  beforeAll(() => {
    db = createDb(url as string);
  });
  afterAll(async () => {
    await db?.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    stub = await startStubFhir();
    hmis = new FhirR4Hmis({
      baseUrl: new URL(stub.base), tokenUrl: new URL(stub.tokenUrl), clientId: stub.clientId, clientSecret: () => stub.clientSecret, scopes: 'system/*.*', pageSize: 10,
      systems: SYSTEMS, limsSystemPrefix: 'urn:lims-middleware:', timeoutMs: 2000, allowHttp: true,
    });
    for (const f of [PROT, RBC, PH, UA]) await approveCatalogueEntry(db, 'dr.lab', (await proposeCatalogueEntry(db, 'lab.manager', f, 'urinalysis bench')).id);
  });
  afterEach(async () => {
    await stub.close();
  });

  /** A urinalysis ordered in the HMIS, pulled, and its specimen received. */
  async function orderedPanel() {
    stub.feed.push(feedLine({ srId: 'sr1', order: 'ORD-UA', line: 'L-UA', test: '24356-8', mrn: 'MRN-UA' }));
    await pullOrders(db, hmis);
    const tests = await db.orderedTest.findMany({ orderBy: { componentCode: 'asc' } });
    const { specimenId } = await accessionSpecimen(db, { orderId: tests[0]!.orderId, orderedTestIds: tests.map((t) => t.id), user: 'phleb' });
    await receiveSpecimen(db, specimenId, 'tech.a');
    const by = (c: string) => tests.find((t) => t.componentCode === c)!.id;
    return { prot: by('U-PROT'), rbc: by('U-RBC'), ph: by('U-PH') };
  }

  it('a panel needs its components in the catalogue first, and its components cannot be retired or nested', async () => {
    await expect(proposeCatalogueEntry(db, 'lab.manager', { ...UA, localCode: 'UA2', loincCode: '', components: 'U-PROT\nU-GLU' }, 'x2345')).rejects.toThrow(/before the panel: U-GLU/);
    await expect(proposeCatalogueEntry(db, 'lab.manager', { ...UA, localCode: 'UA3', loincCode: '', components: 'UA\nU-PROT' }, 'x2345')).rejects.toThrow(/cannot contain another panel: UA/);
    await expect(proposeCatalogueEntry(db, 'lab.manager', { ...PROT, resultType: 'PANEL', answers: '', components: 'U-RBC\nU-PH' }, 'x2345')).rejects.toThrow(/component of UA/);
    await expect(retireCatalogueEntry(db, 'dr.lab', 'U-RBC', 'not done any more')).rejects.toThrow(/component of UA/);
  });

  it('an HMIS order line for a panel becomes one ordered test per component', async () => {
    await orderedPanel();
    const tests = await db.orderedTest.findMany({ orderBy: { componentCode: 'asc' } });
    expect(tests.map((t) => [t.hmisLineId, t.hmisTestCode, t.panelCode, t.componentCode, t.localTestCode])).toEqual([
      ['L-UA', '24356-8', 'UA', 'U-PH', 'U-PH'],
      ['L-UA', '24356-8', 'UA', 'U-PROT', 'U-PROT'],
      ['L-UA', '24356-8', 'UA', 'U-RBC', 'U-RBC'],
    ]);
    // Polled again (a cancellation), the line keeps its components and they all follow the status.
    stub.feed.push(feedLine({ srId: 'sr1', order: 'ORD-UA', line: 'L-UA', test: '24356-8', mrn: 'MRN-UA', status: 'revoked' }));
    await pullOrders(db, hmis);
    expect((await db.orderedTest.findMany()).map((t) => t.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });

  it('enters the panel together: empty components wait, and one bad value saves nothing', async () => {
    const t = await orderedPanel();
    expect((await manualWorksheet(db)).map((r) => [r.panel?.code, r.test.localCode])).toEqual([['UA', 'U-PROT'], ['UA', 'U-RBC'], ['UA', 'U-PH']]);
    await expect(enterManualPanel(db, 'tech.a', { values: [{ orderedTestId: t.prot, value: '' }, { orderedTestId: t.rbc, value: '' }] })).rejects.toThrow(/at least one/);
    await expect(enterManualPanel(db, 'tech.a', { values: [{ orderedTestId: t.prot, value: '1P' }, { orderedTestId: t.rbc, value: '2.5' }] })).rejects.toThrow('U-RBC: Urine RBC per HPF is reported with no decimals.');
    expect(await db.result.count()).toBe(0);
    const ids = await enterManualPanel(db, 'tech.a', { values: [{ orderedTestId: t.prot, value: '1P' }, { orderedTestId: t.rbc, value: '3' }, { orderedTestId: t.ph, value: '' }], lot: 'STRIP-9' });
    expect(ids).toHaveLength(2);
    expect((await manualWorksheet(db)).map((r) => r.test.localCode)).toEqual(['U-PH']);
    const other = await receivedOrder('U-PROT', 'X');
    await expect(enterManualPanel(db, 'tech.a', { values: [{ orderedTestId: t.ph, value: '6.0' }, { orderedTestId: other.testId, value: 'NEG' }] })).rejects.toMatchObject({ error: { code: 'INVALID_STATE' } });
  });

  /** Same helper as the outer suite, for a single test outside the panel. */
  async function receivedOrder(localTestCode: string, hmisTestCode: string) {
    const patientId = uuidv7();
    const orderId = uuidv7();
    const specimenId = uuidv7();
    const testId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN-OTHER', familyName: 'Example' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-OTHER', patientId, priority: 'routine', orderedAt: new Date(), status: 'active', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: 'L-OTHER', barcode: 'L-OTHER', status: 'received', createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: '1', hmisTestCode, localTestCode, status: 'active', specimenId } });
    return { testId };
  }

  it('each component goes to the HMIS under its own LOINC code, keyed apart from the others', async () => {
    const t = await orderedPanel();
    const [prot, rbc, ph] = await enterManualPanel(db, 'tech.a', { values: [{ orderedTestId: t.prot, value: 'NEG' }, { orderedTestId: t.rbc, value: '3' }, { orderedTestId: t.ph, value: '6.0' }] });
    for (const id of [prot!, rbc!, ph!]) {
      await review(db, id, 'tech.b', 1);
      await approve(db, id, 'dr.lab', { twoPersonRule: true });
    }
    await release(db, prot!, { username: 'dr.lab', displayName: 'Dr Lab' });
    await release(db, rbc!, { username: 'dr.lab', displayName: 'Dr Lab' });
    // U-PH has no LOINC code in the catalogue, so it cannot be sent as a component.
    await expect(release(db, ph!, { username: 'dr.lab', displayName: 'Dr Lab' })).rejects.toThrow(/no LOINC code in the catalogue/);
    expect((await db.outboxMessage.findMany({ orderBy: { createdAt: 'asc' } })).map((o) => o.payload)).toMatchObject([
      { hmisLineId: 'L-UA', testCode: '20454-5', component: { key: 'U-PROT', orderedCode: '24356-8' } },
      { hmisLineId: 'L-UA', testCode: '13945-1', component: { key: 'U-RBC', orderedCode: '24356-8' } },
    ]);
    const d = await deliverOutbox(db, hmis, 'jobs:1');
    expect(d.map((x) => x.resultStatus)).toEqual(['hmis_confirmed', 'hmis_confirmed']);
    const stored = [...stub.store.entries()];
    expect(stored.filter(([k]) => k.startsWith('DiagnosticReport/'))).toEqual([]);
    const obs = stored.filter(([k]) => k.startsWith('Observation/')).map(([, r]) => r);
    expect(obs).toHaveLength(2);
    expect(obs).toMatchObject([
      { code: { coding: [{ code: '20454-5' }] }, basedOn: [{ identifier: { value: 'L-UA' } }], identifier: [{ value: 'L-UA/U-PROT' }, {}] },
      { code: { coding: [{ code: '13945-1' }] }, basedOn: [{ identifier: { value: 'L-UA' } }], identifier: [{ value: 'L-UA/U-RBC' }, {}], valueQuantity: { value: 3 } },
    ]);
  });
});
