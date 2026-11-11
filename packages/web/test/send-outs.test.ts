import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db } from '@lis/db';
import { approveCatalogueEntry, documentType, proposeCatalogueEntry, sentTests } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES =
  'send_out_document, send_out_test, send_out, referral_test, referral_lab, user_session, app_user, audit_event, delivery_attempt, outbox_message, critical_call, result_event, result_comment, result_version, result, specimen, ordered_test, lab_order, patient, hmis_code_map, test_catalogue, manual_qc, instrument';

// Example tests; the lab chooses its own codes, units and referral labs.
const entry = (localCode: string, name: string, performedBy: string) => ({
  localCode, name, section: 'Chemistry', loincCode: '', loincDisplay: '', shaCode: '', specimenType: 'Serum',
  performedBy, resultType: 'NUMERIC', answers: '', unit: 'nmol/L', decimals: '1', components: '', qcRule: '', qcValidHours: '',
});
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe.skipIf(!url)('send-outs to referral labs (A-43)', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let specimenId: string;
  let vitD: string;
  let tsh: string;

  const as = async (username: string) => {
    const b = new Browser(base);
    expect((await b.signIn(username)).status).toBe(303);
    return b;
  };
  const upload = async (b: Browser, path: string, file: Buffer, fields: Record<string, string>) => {
    const form = new FormData();
    form.append('_csrf', await b.csrf(path));
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', new Blob([file], { type: 'application/pdf' }), 'Report 12-3 (final).pdf');
    const res = await fetch(`${base}${path}/documents`, { method: 'POST', redirect: 'manual', body: form, headers: { cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    return { status: res.status, location: res.headers.get('location'), html: await res.text() };
  };

  beforeAll(async () => {
    db = createDb(url as string);
    app = await createApp(db, { secureCookies: false, twoPersonRule: false, logger: pino({ level: 'silent' }) });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await db?.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    await app?.close();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    await createUser(db, { username: 'tech', displayName: 'Tech One', password: PW, roles: ['technologist'] }, 'test');
    await createUser(db, { username: 'dr.lab', displayName: 'Dr Lab', password: PW, roles: ['approver'] }, 'test');
    await createUser(db, { username: 'dr.two', displayName: 'Dr Two', password: PW, roles: ['approver'] }, 'test');
    for (const e of [entry('VITD', 'Vitamin D', 'MANUAL'), entry('TSH', 'TSH', 'INSTRUMENT')]) {
      const d = await proposeCatalogueEntry(db, 'dr.lab', e as never, 'example');
      await approveCatalogueEntry(db, 'dr.two', d.id);
    }
    const patientId = uuidv7();
    const orderId = uuidv7();
    specimenId = uuidv7();
    vitD = uuidv7();
    tsh = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN7', familyName: 'Example', givenName: 'Sam', sex: 'M' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-7', patientId, priority: 'routine', orderedAt: new Date(), status: 'active', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: 'L26111100077', barcode: 'L26111100077', status: 'received', receivedAt: new Date(), createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: vitD, orderId, hmisLineId: '1', hmisTestCode: 'H-VITD', localTestCode: 'VITD', status: 'active', specimenId } });
    await db.orderedTest.create({ data: { id: tsh, orderId, hmisLineId: '2', hmisTestCode: 'H-TSH', localTestCode: 'TSH', status: 'active', specimenId } });
  });

  const setUpLab = async (dr: Browser) => {
    const csrf = await dr.csrf('/referral-labs');
    const bad = await dr.post('/referral-labs', { _csrf: csrf, code: 'bad code!', name: 'X', address: '', phone: '', email: 'nope', notes: '' });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('short code');
    const made = await dr.post('/referral-labs', { _csrf: csrf, code: 'refa', name: 'Reference Lab A', address: 'PO Box 1', phone: '0700 000000', email: 'lab@example.org', notes: 'Courier Tuesdays' });
    expect(made.status).toBe(303);
    const labId = /\/referral-labs\/([0-9a-f-]{36})/.exec(made.location ?? '')![1]!;
    const lab = await dr.get(`/referral-labs/${labId}`);
    expect(lab.html).toContain('REFA');
    const c2 = await dr.csrf(`/referral-labs/${labId}`);
    expect((await dr.post(`/referral-labs/${labId}/tests`, { _csrf: c2, localTestCode: 'VITD', tatHours: '0', specimenNote: '' })).html).toContain('whole hours');
    expect((await dr.post(`/referral-labs/${labId}/tests`, { _csrf: c2, localTestCode: 'VITD', tatHours: '72', specimenNote: '2 mL serum, frozen' })).status).toBe(303);
    return labId;
  };

  it('sends a test to a referral lab, tracks receipt and papers, types its result in for another person to approve, and measures turnaround', async () => {
    const dr = await as('dr.lab');
    const tech = await as('tech');
    expect((await tech.post('/referral-labs', { _csrf: await tech.csrf('/referral-labs'), code: 'X', name: 'Not allowed', address: '', phone: '', email: '', notes: '' })).status).toBe(403);
    const labId = await setUpLab(dr);

    // To send: only VITD (a referral lab does it); TSH shows only when the accession is scanned.
    const toSend = (await tech.get('/send-outs?tab=send')).html;
    expect(toSend).toContain('L26111100077');
    expect(toSend).toContain('Vitamin D');
    expect(toSend).not.toContain('>TSH<');
    expect((await tech.get('/send-outs?tab=send&accession=L26111100077')).html).toContain('no referral lab has this test yet');

    const csrf = await tech.csrf('/send-outs?tab=send');
    // TSH has no agreed turnaround at this lab, so it cannot go there.
    const refused = await tech.post('/send-outs', { _csrf: csrf, specimenId, labId, testIds: [vitD, tsh], dispatchRef: 'WB-1', dispatchedAt: '' });
    expect(refused.status).toBe(422);
    expect(refused.html).toContain('REFA has no agreed turnaround for TSH');
    expect(await db.sendOut.count()).toBe(0);

    const sent = await tech.post('/send-outs', { _csrf: csrf, specimenId, labId, testIds: vitD, dispatchRef: 'WB-1', dispatchedAt: '' });
    expect(sent.status).toBe(303);
    const sendOutId = /\/send-outs\/([0-9a-f-]{36})/.exec(sent.location ?? '')![1]!;
    const so = await db.sendOut.findUniqueOrThrow({ where: { id: sendOutId } });
    expect(so.status).toBe('sent');
    expect(Math.round((so.dueAt.getTime() - so.dispatchedAt.getTime()) / 3_600_000)).toBe(72);
    expect(await db.auditEvent.count({ where: { action: 'send-out.dispatch' } })).toBe(1);
    // It is no longer waiting to be sent, and a second send of it is refused.
    expect((await tech.get('/send-outs?tab=send')).html).not.toContain('L26111100077');
    expect((await tech.post('/send-outs', { _csrf: csrf, specimenId, labId, testIds: vitD, dispatchRef: '', dispatchedAt: '' })).html).toContain('VITD is already sent out');

    const path = `/send-outs/${sendOutId}`;
    expect((await tech.get(path)).html).toContain('WB-1');
    expect((await tech.post(`${path}/received`, { _csrf: await tech.csrf(path), labRef: 'RA-555', receivedAt: '' })).status).toBe(303);
    expect((await db.sendOut.findUniqueOrThrow({ where: { id: sendOutId } })).status).toBe('received');

    // Papers: a PDF is kept and downloaded as a file; a file that is not a PDF or image is refused.
    expect((await upload(tech, path, Buffer.from('<html><script>x</script></html>'), { kind: 'receiving-report', note: '' })).html).toContain('must be a PDF, PNG or JPEG');
    const up = await upload(tech, path, PDF, { kind: 'receiving-report', note: 'faxed' });
    expect(up.status).toBe(303);
    const doc = await db.sendOutDocument.findFirstOrThrow({ where: { sendOutId } });
    expect(doc.fileName).toBe('Report 12-3 _final_.pdf');
    expect(doc.contentType).toBe('application/pdf');
    const got = await fetch(`${base}${path}/documents/${doc.id}`, { headers: { cookie: [...tech.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    expect(got.headers.get('content-disposition')).toContain('attachment');
    expect(Buffer.from(await got.arrayBuffer()).equals(PDF)).toBe(true);
    expect(documentType(PDF)).toBe('application/pdf');

    // Results from their report: the report number is needed, the value is checked.
    const c = await tech.csrf(path);
    expect((await tech.post(`${path}/results`, { _csrf: c, reportRef: '', [`value-${vitD}`]: '55.2' })).html).toContain('report number');
    expect((await tech.post(`${path}/results`, { _csrf: c, reportRef: 'RA-R-9', [`value-${vitD}`]: 'high' })).status).toBe(422);
    expect((await tech.post(`${path}/results`, { _csrf: c, reportRef: 'RA-R-9', [`value-${vitD}`]: '55.2' })).status).toBe(303);
    const done = await db.sendOut.findUniqueOrThrow({ where: { id: sendOutId } });
    expect(done.status).toBe('resulted');
    const r = await db.result.findFirstOrThrow({ where: { orderedTestId: vitD } });
    const detail = (await dr.get(`/results/${r.id}`)).html;
    expect(detail).toContain('typed in from their report');
    expect(detail).toContain('Report RA-R-9, typed by tech');

    // The typist does not approve it; another person does.
    expect((await tech.post(`/results/${r.id}/review`, { _csrf: await tech.csrf(`/results/${r.id}`), versionNo: '1' })).status).toBe(303);
    await createUser(db, { username: 'both', displayName: 'Both', password: PW, roles: ['technologist', 'approver'] }, 'test');
    const both = await as('both');
    expect((await both.post(`/results/${r.id}/approve`, { _csrf: await both.csrf(`/results/${r.id}`), password: PW })).status).not.toBe(409);

    // The list: on time, with how long it took.
    const list = (await dr.get('/send-outs')).html;
    expect(list).toContain('VITD');
    expect(list).toContain('Resulted on time');
    expect(list).toContain('3 days');
  });

  it('shows a test past its turnaround as overdue, and a cancelled send-out frees its tests', async () => {
    const dr = await as('dr.lab');
    const labId = await setUpLab(dr);
    const tech = await as('tech');
    const csrf = await tech.csrf('/send-outs?tab=send');
    const sent = await tech.post('/send-outs', { _csrf: csrf, specimenId, labId, testIds: vitD, dispatchRef: '', dispatchedAt: '' });
    const id = /\/send-outs\/([0-9a-f-]{36})/.exec(sent.location ?? '')![1]!;
    const later = new Date(Date.now() + 80 * 3_600_000);
    const { rows, counts } = await sentTests(db, { now: later });
    expect(rows[0]!.state).toBe('overdue');
    expect(counts.overdue).toBe(1);
    expect((await dr.get('/send-outs')).html).toContain('Awaiting result');

    const path = `/send-outs/${id}`;
    expect((await tech.post(`${path}/cancel`, { _csrf: await tech.csrf(path), reason: 'x' })).status).toBe(422);
    expect((await tech.post(`${path}/cancel`, { _csrf: await tech.csrf(path), reason: 'Tube leaked in transit' })).status).toBe(303);
    expect((await db.sendOut.findUniqueOrThrow({ where: { id } })).status).toBe('cancelled');
    expect((await tech.get('/send-outs?tab=send')).html).toContain('L26111100077');
    expect((await dr.get('/send-outs?state=cancelled')).html).toContain('Cancelled');
  });
});
