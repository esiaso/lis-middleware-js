// Demo sample data (demo/README.md): instruments, catalogue, lab settings, patients,
// orders, specimens, instrument and manual results at every step of the workflow, QC,
// critical calls, an unmatched result, a downtime order and a patient merge.
//
// Everything here is MADE UP for trying the screens. The patients do not exist, the
// limits, ranges and targets are not the lab's policy or clinical guidance, and the
// instrument "verification" records are demo placeholders: no instrument has passed
// interface testing. Instrument results are sent through the real intake code
// (stored raw message → decode → match), and every step after that goes through the
// same functions the screens use, so the audit trail is complete.
//
// Runs after seed.mjs. It adds to an existing demo and does nothing if it has run before.
import { acquireLease, createDb, PrismaRawMessageStore, releaseLease, startLinkSession } from '@lis/db';
import {
  accessionSpecimen, addAutoverifyRule, addCriticalLimit, addDeltaRule, addQcRange, addReferenceRange, addResultComment, addStandardComment, addTatTarget,
  approve, approveAndActivateMappings, approveCatalogueEntry, confirmMerge, enterManualResult, ingestOrder, proposeCatalogueEntry, proposeMerge,
  addReferralTest, createReferralLab, createSendOut, recordCriticalCall, recordInstrumentEvidence, recordLabelPrint, recordManualQc, receiveSpecimen, registerDowntimeOrder, registerInstrumentRecord,
  release, review, saveMappingDraft, setInstrumentEnabled,
} from '@lis/lab';
import { runIntakeBatch } from '@lis/result-intake';
import { HmisOrder } from '@lis/contracts';

const db = createDb(process.env.DATABASE_URL);
const MARK = 'e411-demo';
const DEMO = 'DEMO ONLY: made-up example, not a lab policy';
const policy = { twoPersonRule: true };
const people = { tech: { username: 'tech', displayName: 'Demo Technologist' }, a1: 'approver1', a2: 'approver2' };
const minutesAgo = (m) => new Date(Date.now() - m * 60_000);

// ---------------------------------------------------------------- instruments
const INSTRUMENTS = [
  {
    reg: {
      instrumentId: 'e411-demo', displayName: 'cobas e 411 (demo)', manufacturer: 'Roche', model: 'cobas e 411', serialNo: 'DEMO-E411', softwareVersion: '03-01',
      discipline: 'immunoassay', location: 'Main lab, bench 2',
      connection: { instrumentId: 'e411-demo', adapter: 'cobas-e411-astm', adapterOptions: {}, transport: { type: 'tcp-client', host: '192.0.2.11', port: 4001 } },
    },
    accept: true,
    mappings: [
      { localTestCode: 'TSH', instrumentTestCode: '10', direction: 'both', expectedUnits: 'uIU/mL', reportable: true, ruo: false },
      { localTestCode: 'FT4', instrumentTestCode: '20', direction: 'both', expectedUnits: 'pmol/L', reportable: true, ruo: false },
    ],
  },
  {
    reg: {
      instrumentId: 'bc-demo', displayName: 'Mindray haematology (demo)', manufacturer: 'Mindray', model: 'BC-series (demo)', serialNo: 'DEMO-BC', softwareVersion: '1.0',
      discipline: 'haematology', location: 'Main lab, haematology bench',
      connection: { instrumentId: 'bc-demo', adapter: 'mindray-hl7-mllp', adapterOptions: {}, transport: { type: 'tcp-client', host: '192.0.2.12', port: 5100 } },
    },
    accept: true,
    mappings: [
      { localTestCode: 'HB', instrumentTestCode: '718-7', instrumentCodeSystem: 'LN', direction: 'result', expectedUnits: 'g/L', reportable: true, ruo: false },
      { localTestCode: 'WBC', instrumentTestCode: '6690-2', instrumentCodeSystem: 'LN', direction: 'result', expectedUnits: '10*9/L', reportable: true, ruo: false },
      { localTestCode: 'PLT', instrumentTestCode: '777-3', instrumentCodeSystem: 'LN', direction: 'result', expectedUnits: '10*9/L', reportable: true, ruo: false },
    ],
  },
  {
    reg: {
      instrumentId: 'coag-demo', displayName: 'Coagulation analyser (demo)', manufacturer: 'Demo', model: 'Generic HL7 coagulation', softwareVersion: '2.1',
      discipline: 'coagulation', location: 'Main lab', interfaceManualRef: 'DEMO ONLY: no real interface manual',
      connection: { instrumentId: 'coag-demo', adapter: 'generic-hl7-mllp', adapterOptions: { profile: 'generic-hl7-mllp', sampleId: { segment: 'OBR', field: 2 } }, transport: { type: 'tcp-client', host: '192.0.2.13', port: 5200 } },
    },
    accept: false, // left unverified, to show the "not for clinical use" gate
    mappings: [{ localTestCode: 'PT', instrumentTestCode: 'PT', direction: 'result', expectedUnits: 's', reportable: true, ruo: false }],
  },
];

// ---------------------------------------------------------------- catalogue
const t = { section: 'Chemistry', loincDisplay: '', shaCode: '', specimenType: 'Serum', performedBy: 'INSTRUMENT', resultType: 'NUMERIC', answers: '' };
const CATALOGUE = [
  { ...t, localCode: 'TSH', name: 'Thyroid stimulating hormone (demo)', section: 'Immunoassay', loincCode: '3016-3', unit: 'uIU/mL', decimals: '2' },
  { ...t, localCode: 'FT4', name: 'Free thyroxine (demo)', section: 'Immunoassay', loincCode: '3024-7', unit: 'pmol/L', decimals: '1' },
  { ...t, localCode: 'HB', name: 'Haemoglobin (demo)', section: 'Haematology', specimenType: 'Whole blood', loincCode: '718-7', unit: 'g/L', decimals: '0' },
  { ...t, localCode: 'WBC', name: 'White cell count (demo)', section: 'Haematology', specimenType: 'Whole blood', loincCode: '6690-2', unit: '10*9/L', decimals: '2' },
  { ...t, localCode: 'PLT', name: 'Platelet count (demo)', section: 'Haematology', specimenType: 'Whole blood', loincCode: '777-3', unit: '10*9/L', decimals: '0' },
  { ...t, localCode: 'PT', name: 'Prothrombin time (demo)', section: 'Coagulation', specimenType: 'Citrated plasma', loincCode: '5902-2', unit: 's', decimals: '1' },
];

// ---------------------------------------------------------------- patients and orders
// [mrn, family, given, sex, birthDate, ward, priority, tests (HMIS codes)]
const ORDERS = [
  ['MRN3001', 'Wanjiru', 'Grace', 'F', '1984-03-12', 'Ward 3', 'routine', ['3016-3', '3024-7']],
  ['MRN3002', 'Otieno', 'Brian', 'M', '1976-11-02', 'OPD', 'routine', ['3016-3']],
  ['MRN3003', 'Achieng', 'Mary', 'F', '1992-07-21', 'Maternity', 'urgent', ['718-7', '6690-2', '777-3']],
  ['MRN3004', 'Kamau', 'Peter', 'M', '1958-01-30', 'Medical ward', 'stat', ['718-7', '6690-2', '777-3']],
  ['MRN3005', 'Njeri', 'Faith', 'F', '2001-09-09', 'OPD', 'routine', ['3016-3', '3024-7']],
  ['MRN3006', 'Mutua', 'James', 'M', '1969-05-17', 'Surgical ward', 'urgent', ['718-7', '6690-2', '777-3']],
  ['MRN3007', 'Chebet', 'Ann', 'F', '1988-12-01', 'Paediatrics', 'stat', ['32700-7', 'MAL-DENS']],
  ['MRN3008', 'Omondi', 'Kevin', 'M', '1995-04-04', 'OPD', 'routine', ['32700-7']],
  ['MRN3009', 'Wambui', 'Lucy', 'F', '1979-08-25', 'Medical ward', 'routine', ['5902-2']],
  ['MRN3010', 'Kiprop', 'Daniel', 'M', '1963-02-14', 'OPD', 'routine', ['U-PROT']],
  ['MRN3011', 'Kiprop', 'Daniel', 'M', '1963-02-14', 'Casualty', 'routine', ['3016-3']], // same person, second MRN: merged below
  ['MRN3012', 'Atieno', 'Rose', 'F', '1990-06-30', 'Ward 3', 'routine', ['3016-3']], // ordered, not yet collected
  ['MRN3006#2', 'Mutua', 'James', 'M', '1969-05-17', 'Surgical ward', 'stat', ['718-7']], // a repeat haemoglobin after surgery: delta check
];

const astm = (records) => Buffer.from(records.map((r) => `${r}\r`).join(''), 'latin1');
const stamp = (d = new Date()) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
const hl7 = (...segs) => Buffer.from(segs.map((s) => `${s}\r`).join(''), 'utf8');

async function intake(instrumentId, store) {
  const lease = await acquireLease(db, instrumentId, 'demo-sample');
  if (!lease) throw new Error(`could not lease ${instrumentId}`);
  const raw = new PrismaRawMessageStore(db, lease, await startLinkSession(db, lease));
  await store(raw);
  await releaseLease(db, lease);
  for (let i = 0; i < 20; i++) if ((await runIntakeBatch(db, 'demo-sample')).length === 0) break;
}

/**
 * A full blood count received in the lab while the haematology analyser's link
 * is down: no analyser message, so its results wait on the Instrument down page.
 * Runs on its own, so it is also added to a demo that already has sample data.
 */
async function instrumentDownSample() {
  if (await db.patient.findUnique({ where: { mrn: 'MRN3014' } })) return false;
  const hmisOrderId = 'DEMO-MRN3014';
  const order = { hmisOrderId, patient: { mrn: 'MRN3014', familyName: 'Ouma', givenName: 'Samuel', sex: 'M', birthDate: '1981-10-19' }, encounter: { hmisEncounterId: 'E-MRN3014', type: 'inpatient', location: 'Medical ward' }, priority: 'urgent', orderedAt: minutesAgo(45).toISOString(), orderingClinician: 'Dr Demo', lines: ['718-7', '6690-2', '777-3'].map((testCode, i) => ({ hmisLineId: `${hmisOrderId}-${i + 1}`, testCode })) };
  const { orderId } = await db.$transaction((tx) => ingestOrder(tx, HmisOrder.parse(order)));
  const tests = await db.orderedTest.findMany({ where: { orderId }, orderBy: { hmisLineId: 'asc' } });
  const { specimenId } = await accessionSpecimen(db, { orderId, orderedTestIds: tests.map((x) => x.id), user: 'tech' });
  await recordLabelPrint(db, specimenId, 'tech');
  await receiveSpecimen(db, specimenId, 'tech');
  console.log('sample: added a received blood count with no analyser result (instrument link down)');
  return true;
}

/**
 * A referral lab with the tests it does, and a specimen sent to it: its FT4
 * goes out, waiting for the referral lab's result. Runs on its own, like the
 * one above. The lab, its turnaround and the waybill are made up.
 */
async function sendOutSample() {
  if (await db.referralLab.findUnique({ where: { code: 'DEMO-REF' } })) return false;
  const labId = await createReferralLab(db, people.a1, { code: 'DEMO-REF', name: 'Demo Reference Laboratory', address: 'DEMO ONLY: not a real laboratory', phone: '', email: '', notes: 'Courier collects on weekdays (demo).' });
  await addReferralTest(db, people.a1, labId, { localTestCode: 'FT4', tatHours: '72', specimenNote: '1 mL serum, cold chain (demo)' });
  await addReferralTest(db, people.a1, labId, { localTestCode: 'PT', tatHours: '24', specimenNote: 'Citrate tube, within 4 hours (demo)' });
  const hmisOrderId = 'DEMO-MRN3016';
  const order = { hmisOrderId, patient: { mrn: 'MRN3016', familyName: 'Nyambura', givenName: 'Alice', sex: 'F', birthDate: '1972-04-08' }, encounter: { hmisEncounterId: 'E-MRN3016', type: 'outpatient', location: 'OPD' }, priority: 'routine', orderedAt: minutesAgo(240).toISOString(), orderingClinician: 'Dr Demo', lines: ['3016-3', '3024-7'].map((testCode, i) => ({ hmisLineId: `${hmisOrderId}-${i + 1}`, testCode })) };
  const { orderId } = await db.$transaction((tx) => ingestOrder(tx, HmisOrder.parse(order)));
  const tests = await db.orderedTest.findMany({ where: { orderId }, orderBy: { hmisLineId: 'asc' } });
  const { specimenId } = await accessionSpecimen(db, { orderId, orderedTestIds: tests.map((x) => x.id), user: 'tech' });
  await recordLabelPrint(db, specimenId, 'tech');
  await receiveSpecimen(db, specimenId, 'tech');
  const ft4 = tests.find((t) => t.localTestCode === 'FT4');
  if (ft4) await createSendOut(db, 'tech', { specimenId, labId, orderedTestIds: [ft4.id], dispatchedAt: minutesAgo(120), dispatchRef: 'DEMO-WB-0001' });
  console.log('sample: added a referral lab and a send-out waiting for its result');
  return true;
}

async function main() {
  if (!(await db.appUser.count())) throw new Error('run demo/seed.mjs first');
  if (await db.instrument.findUnique({ where: { id: MARK } })) {
    const added = [await instrumentDownSample(), await sendOutSample()];
    if (!added.some(Boolean)) console.log('sample: sample data already present, nothing to do');
    return;
  }

  // Catalogue: proposed by one approver, approved by another (a LOINC code links HMIS orders on approval).
  for (const c of CATALOGUE) {
    const draft = await proposeCatalogueEntry(db, people.a1, c, 'demo sample data');
    await approveCatalogueEntry(db, people.a2, draft.id);
  }

  // Instruments, mappings (two people) and, for two of them, placeholder verification records.
  for (const i of INSTRUMENTS) {
    await registerInstrumentRecord(db, i.reg, 'admin');
    const v = await saveMappingDraft(db, i.reg.instrumentId, i.mappings, 'tech');
    await approveAndActivateMappings(db, i.reg.instrumentId, v, people.a1);
    if (i.accept) {
      await recordInstrumentEvidence(db, i.reg.instrumentId, { kind: 'interface-test', testedBy: 'Demo Engineer', organisation: 'Demo vendor', testedAt: minutesAgo(60 * 24 * 30).toISOString(), recordRef: 'DEMO ONLY: not a real interface verification record', softwareVersion: i.reg.softwareVersion }, 'admin');
      await recordInstrumentEvidence(db, i.reg.instrumentId, { kind: 'lab-acceptance', signedBy: 'approver1', signedAt: minutesAgo(60 * 24 * 7).toISOString(), acceptanceRef: 'DEMO ONLY: not a real acceptance report' }, 'approver1');
    }
    await setInstrumentEnabled(db, i.reg.instrumentId, true, 'admin', 'demo sample data');
  }

  // Lab settings, all labelled as demo values.
  const anyAge = { sex: '', ageMin: '', ageMinUnit: 'years', ageMax: '', ageMaxUnit: 'years' };
  for (const [code, low, high, units] of [['TSH', '0.27', '4.20', 'uIU/mL'], ['FT4', '12.0', '22.0', 'pmol/L'], ['HB', '120', '160', 'g/L'], ['WBC', '4.00', '10.00', '10*9/L'], ['PLT', '150', '400', '10*9/L'], ['PT', '11.0', '13.5', 's']]) {
    await addReferenceRange(db, people.a1, { localTestCode: code, ...anyAge, low, high, units, reference: DEMO });
  }
  await addCriticalLimit(db, people.a1, { localTestCode: 'HB', ...anyAge, low: '70', high: '200', units: 'g/L', reference: DEMO });
  await addCriticalLimit(db, people.a1, { localTestCode: 'PLT', ...anyAge, low: '20', high: '1000', units: '10*9/L', reference: DEMO });
  await addDeltaRule(db, people.a1, { localTestCode: 'HB', maxAbs: '20', maxPercent: '', windowDays: '7', units: 'g/L', reference: DEMO });
  await addAutoverifyRule(db, people.a1, { localTestCode: 'TSH', low: '0.27', high: '4.20', units: 'uIU/mL', reference: DEMO, qcAcknowledged: true });
  await addTatTarget(db, people.a1, { localTestCode: '', priority: 'stat', minutes: '60', reference: DEMO });
  await addTatTarget(db, people.a1, { localTestCode: '', priority: 'routine', minutes: '240', reference: DEMO });
  await addStandardComment(db, people.a1, { code: 'HAEM', text: 'Sample haemolysed; please repeat if the result does not fit the clinical picture.', localTestCode: '' });
  await addStandardComment(db, people.a1, { code: 'FILM', text: 'Blood film reviewed.', localTestCode: 'HB' });
  await addQcRange(db, people.a1, { instrumentId: 'e411-demo', localTestCode: 'TSH', controlLot: 'LOT1', controlName: '', low: '1.20', high: '1.80', units: 'uIU/mL', reference: DEMO, targetMean: '1.50', targetSd: '0.10', westgardRules: ['1-2s', '1-3s', '2-2s'] });

  // Orders as the HMIS feed would bring them, then specimens collected and received.
  const orders = {};
  for (const [n, [key, familyName, givenName, sex, birthDate, ward, priority, tests]] of ORDERS.entries()) {
    const mrn = key.split('#')[0];
    const hmisOrderId = `DEMO-${key.replace('#', '-')}`;
    const order = { hmisOrderId, patient: { mrn, familyName, givenName, sex, birthDate }, encounter: { hmisEncounterId: `E-${mrn}`, type: 'inpatient', location: ward }, priority, orderedAt: minutesAgo(300 - n * 20).toISOString(), orderingClinician: 'Dr Demo', lines: tests.map((code, i) => ({ hmisLineId: `${hmisOrderId}-${i + 1}`, testCode: code })) };
    const { orderId } = await db.$transaction((tx) => ingestOrder(tx, HmisOrder.parse(order)));
    orders[key] = { orderId };
  }
  const collect = async (mrn) => {
    const tests = await db.orderedTest.findMany({ where: { orderId: orders[mrn].orderId }, orderBy: { hmisLineId: 'asc' } });
    const { specimenId, accessionNo } = await accessionSpecimen(db, { orderId: orders[mrn].orderId, orderedTestIds: tests.map((x) => x.id), user: 'tech' });
    await recordLabelPrint(db, specimenId, 'tech');
    await receiveSpecimen(db, specimenId, 'tech');
    Object.assign(orders[mrn], { specimenId, accessionNo, tests });
    return accessionNo;
  };
  for (const [key] of ORDERS) if (key !== 'MRN3012') await collect(key);
  const testOf = (key, code) => orders[key].tests.find((x) => x.localTestCode === code).id;
  const resultFor = (key, code) => db.result.findFirstOrThrow({ where: { orderedTestId: testOf(key, code) } });
  /** Review (tech), approve (approver1) and release, as far as `to`. */
  const step = async (key, code, to) => {
    const r = await resultFor(key, code);
    if (r.status === 'received') await review(db, r.id, 'tech', r.selectedVersionNo ?? 1);
    if (to === 'reviewed') return r.id;
    if ((await resultFor(key, code)).status === 'reviewed') await approve(db, r.id, people.a1, policy);
    if (to === 'released') await release(db, r.id, { username: 'approver1', displayName: 'Demo Approver One' });
    return r.id;
  };

  // e 411: TSH and FT4 uploads (cobas® type ASTM), an unknown tube, and a run of QC.
  const e411 = (rows) => astm(['H|\\^&|||cobas-e411^1|||||host|RSUPL^REAL|P|1', ...rows, 'L|1|N']);
  const sample = (n, id, results) => [`O|${n}|${id}|${40 + n}^0^${n}^^S1^SC|^^^10^|R||||||N||||1|||||||${stamp()}|||F`, ...results.map(([code, v, unit, flag], i) => `R|${i + 1}|^^^${code}/|${v}^|${unit}||${flag}||F||admin|||E1`)];
  await intake('e411-demo', async (raw) => {
    const send = (rows) => raw.storeAstmTransfer({ text: e411(['P|1', ...rows]), complete: true, frameCount: 1, receivedAt: new Date() });
    await send(sample(1, orders.MRN3001.accessionNo, [['10', '2.10', 'uIU/mL', ''], ['20', '15.2', 'pmol/L', '']]));
    await send(sample(2, orders.MRN3002.accessionNo, [['10', '6.85', 'uIU/mL', 'H']]));
    await send(sample(3, orders.MRN3005.accessionNo, [['10', '1.42', 'uIU/mL', ''], ['20', '9.8', 'pmol/L', 'L']]));
    await send(sample(4, orders.MRN3011.accessionNo, [['10', '3.05', 'uIU/mL', '']]));
    await send(sample(5, 'L99999999999', [['10', '0.95', 'uIU/mL', '']])); // a tube the lab does not know: unmatched
    for (const [n, v] of ['1.48', '1.55', '1.41', '1.62', '1.50', '1.38', '1.57', '1.45', '1.71', '1.53', '1.44', '1.66'].entries()) {
      await send([`O|${n + 1}|PreciControl^LOT1|${80 + n}^0^1^^QC^SC|^^^10^|R||||||Q||||1|||||||${stamp()}|||F`, `R|1|^^^10/|${v}^|uIU/mL||||F||admin|||E1`]);
    }
  });

  // Mindray: full blood counts (HL7 over MLLP); one critical haemoglobin, one delta.
  const cbc = (n, id, hb, wbc, plt) =>
    hl7(`MSH|^~\\&|||||${stamp()}||ORU^R01|${n}|P|2.3.1||||||UNICODE`, 'PID|1||DEMO^^^^MR', 'PV1|1', `OBR|1||${id}|00001^Automated Count^99MRC||${stamp()}`,
      `OBX|1|NM|718-7^HGB^LN||${hb}|g/L|120-160|N|||F`, `OBX|2|NM|6690-2^WBC^LN||${wbc}|10*9/L|4.00-10.00|N|||F`, `OBX|3|NM|777-3^PLT^LN||${plt}|10*9/L|150-400|N|||F`);
  await intake('bc-demo', async (raw) => {
    await raw.storeMllpMessage({ payload: cbc(1, orders.MRN3003.accessionNo, '118', '7.20', '245'), receivedAt: new Date() });
    await raw.storeMllpMessage({ payload: cbc(2, orders.MRN3004.accessionNo, '62', '13.40', '88'), receivedAt: new Date() }); // HB below the demo critical limit
    await raw.storeMllpMessage({ payload: cbc(3, orders.MRN3006.accessionNo, '131', '9.10', '310'), receivedAt: new Date() });
  });
  for (const code of ['HB', 'WBC', 'PLT']) await step('MRN3006', code, 'approved'); // approved, so the repeat below has a value to compare with
  await intake('bc-demo', (raw) =>
    raw.storeMllpMessage({ payload: hl7(`MSH|^~\\&|||||${stamp()}||ORU^R01|4|P|2.3.1||||||UNICODE`, 'PID|1||DEMO^^^^MR', 'PV1|1', `OBR|1||${orders['MRN3006#2'].accessionNo}|00001^Automated Count^99MRC||${stamp()}`, 'OBX|1|NM|718-7^HGB^LN||98|g/L|120-160|L|||F'), receivedAt: new Date() }),
  );

  // Coagulation (generic HL7 profile): arrives, but the instrument is not cleared for clinical use.
  await intake('coag-demo', (raw) => raw.storeMllpMessage({ payload: hl7(`MSH|^~\\&|COAG|LAB|||${stamp()}||ORU^R01|C1|P|2.5`, `OBR|1|${orders.MRN3009.accessionNo}`, 'OBX|1|NM|PT||14.2|s|||||F'), receivedAt: new Date() }));

  // Manual tests: a positive malaria RDT (critical answer, waiting for the call), a negative one, a dipstick.
  await recordManualQc(db, 'tech', { localCode: 'MAL-RDT', lot: 'RDT-2611', lotExpiry: '2027-06-30', control: 'PF', expected: 'PF', observed: 'PF', comment: 'demo positive control' });
  await enterManualResult(db, 'tech', { orderedTestId: testOf('MRN3007', 'MAL-RDT'), value: 'PF', lot: 'RDT-2611' });
  await enterManualResult(db, 'tech', { orderedTestId: testOf('MRN3007', 'MAL-DENS'), value: '12500' });
  await enterManualResult(db, 'tech', { orderedTestId: testOf('MRN3008', 'MAL-RDT'), value: 'NEG', lot: 'RDT-2611' });
  await enterManualResult(db, 'tech', { orderedTestId: testOf('MRN3010', 'U-PROT'), value: '2+' });

  // Move results along: some released, some approved, some reviewed, the rest left to review.
  await step('MRN3001', 'TSH', 'released'); // autoverified on arrival, then released
  await step('MRN3001', 'FT4', 'released');
  await step('MRN3008', 'MAL-RDT', 'released');
  for (const code of ['HB', 'WBC', 'PLT']) await step('MRN3003', code, 'approved');
  await step('MRN3002', 'TSH', 'reviewed');
  await step('MRN3010', 'U-PROT', 'reviewed');

  // The critical haemoglobin: phoned to the ward, read back, then approved.
  const hb = await resultFor('MRN3004', 'HB');
  await recordCriticalCall(db, hb.id, 'tech', { versionNo: hb.selectedVersionNo ?? 1, notified: 'Nurse Demo', notifiedRole: 'Charge nurse, Medical ward', calledAt: new Date(), readBack: true, note: 'demo call' });
  await review(db, hb.id, 'tech', hb.selectedVersionNo ?? 1);
  await approve(db, hb.id, people.a1, policy);
  await addResultComment(db, hb.id, 'tech', { text: 'Blood film reviewed. Repeat sample requested by the ward.', onReport: true });

  // Downtime: one order registered by hand while the HMIS was down, still to reconcile.
  await registerDowntimeOrder(db, { familyName: 'Muthoni', givenName: 'Esther', sex: 'F', claimedMrn: 'MRN3013', location: 'Casualty', clinician: 'Dr Demo', priority: 'stat', tests: ['MAL-RDT'] }, 'tech');

  // A patient merge recorded by two people: MRN3011 was merged into MRN3010 in the HMIS.
  const from = await db.patient.findUniqueOrThrow({ where: { mrn: 'MRN3011' } });
  const mergeId = await proposeMerge(db, people.a1, { fromPatientId: from.id, intoMrn: 'MRN3010', reference: 'DEMO-MR-0001', reason: 'Duplicate registration (demo)' });
  await confirmMerge(db, people.a2, mergeId);
  await instrumentDownSample();
  await sendOutSample();

  const counts = Object.fromEntries(await Promise.all(['instrument', 'patient', 'labOrder', 'specimen', 'result', 'qcEvaluation', 'unmatchedResult', 'outboxMessage', 'auditEvent'].map(async (m) => [m, await db[m].count()])));
  console.log('sample: added demo sample data', JSON.stringify(counts));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
