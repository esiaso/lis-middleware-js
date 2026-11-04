import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db, type JsonInput } from '@lis/db';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES = 'result_comment, reference_range, user_session, app_user, audit_event, result_event, result_version, result, observation, normalized_message, specimen, ordered_test, lab_order, patient';

describe.skipIf(!url)('printed result report', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let orderId: string;
  let specimenId: string;

  const test = async (line: string, code: string, opts: { status?: string; value?: string; testStatus?: string; approvedBy?: string; range?: string; kind?: string } = {}) => {
    const testId = uuidv7();
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: line, hmisTestCode: `HMIS-${code}`, localTestCode: code, status: opts.testStatus ?? 'collected', specimenId } });
    if (!opts.status) return;
    const resultId = uuidv7();
    await db.result.create({ data: { id: resultId, orderedTestId: testId, status: opts.status, selectedVersionNo: 1, ...(opts.approvedBy ? { approvedBy: opts.approvedBy } : {}) } });
    let observationId: string | null = null;
    if (opts.range) {
      const nm = uuidv7();
      observationId = uuidv7();
      await db.normalizedMessage.create({ data: { id: nm, rawMessageId: uuidv7(), seq: 1, instrumentId: 'c111-01', adapterName: 't', adapterVersion: '1', kind: 'result', sampleClass: 'patient', sampleIdReadError: false, payload: { observations: [{ referenceRangeText: opts.range }] } as JsonInput } });
      await db.observation.create({ data: { id: observationId, normalizedMessageId: nm, seq: 1, instrumentTestCode: code, originalValueText: opts.value ?? '', value: {}, abnormalFlags: [], mapping: 'MAPPED', localTestCode: code } });
    }
    await db.resultVersion.create({ data: { id: uuidv7(), resultId, versionNo: 1, kind: opts.kind ?? 'initial', value: { kind: 'numeric', value: opts.value ?? '1', scale: 1 }, units: 'mmol/L', abnormalFlags: opts.range ? ['H'] : [], observationId, createdBy: 'system:x' } });
    if (opts.approvedBy) await db.resultEvent.create({ data: { id: uuidv7(), resultId, kind: 'approve', versionNo: 1, actor: opts.approvedBy } });
  };

  beforeAll(async () => {
    db = createDb(url as string);
    app = await createApp(db, { secureCookies: false, twoPersonRule: true, logger: pino({ level: 'silent' }), reportHeader: 'District Hospital Laboratory, PO Box 1' });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    await createUser(db, { username: 'tech', displayName: 'Tech One', password: PW, roles: ['technologist'] }, 'test');
    await createUser(db, { username: 'dr.lab', displayName: 'Dr Lab', password: PW, roles: ['approver'] }, 'test');
    const patientId = uuidv7();
    orderId = uuidv7();
    specimenId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN9', familyName: 'Example', givenName: 'Ben', sex: 'M' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-9', patientId, priority: 'routine', orderedAt: new Date(), status: 'active', location: 'Ward 3', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: 'L26110400009', barcode: 'L26110400009', status: 'received', collectedAt: new Date(), createdBy: 'test' } });
  });

  it('prints approved values only, with the instrument range and the approver, and audits each view', async () => {
    await test('1', 'K', { status: 'sent', value: '5.6', approvedBy: 'dr.lab', range: '3.5-5.1' });
    await test('2', 'NA', { status: 'reviewed', value: '999.9' });
    await test('3', 'CL', { status: 'approved', value: '101.0', approvedBy: 'system:autoverify' });
    await test('4', 'CA', { testStatus: 'cancelled' });
    await test('5', 'GLU', { status: 'corrected', value: '7.1', approvedBy: 'dr.lab', kind: 'correction' });

    const b = new Browser(base);
    expect((await b.signIn('tech')).status).toBe(303);
    expect((await b.get(`/orders/${orderId}`)).html).toContain(`/orders/${orderId}/report`);
    const r = await b.get(`/orders/${orderId}/report`);
    expect(r.status).toBe(200);
    expect(r.html).toContain('District Hospital Laboratory, PO Box 1');
    expect(r.html).toContain('EXAMPLE, Ben');
    expect(r.html).toContain('5.6');
    expect(r.html).toContain('3.5-5.1');
    expect(r.html).toContain('Dr Lab');
    expect(r.html).toContain('autoverified');
    expect(r.html).toContain('(corrected)');
    expect(r.html).not.toContain('999.9'); // reviewed but not approved
    expect(r.html).toContain('Pending');
    expect(r.html).toContain('Cancelled');
    expect(r.html).toContain('Printed');
    expect(await db.auditEvent.count({ where: { action: 'order.report-viewed', entityId: orderId } })).toBe(1);
  });

  it('shows the lab\'s reference range where one fits the patient, with a mark, and keeps it after retirement', async () => {
    const dr = new Browser(base);
    expect((await dr.signIn('dr.lab')).status).toBe(303);
    const csrf = await dr.csrf('/reference-ranges');
    // Ranges here are made up for the test, not from any insert.
    const form = { localTestCode: 'K', sex: '', ageMin: '', ageMinUnit: 'years', ageMax: '', ageMaxUnit: 'years', low: '3.5', high: '5.1', units: 'mmol/L', reference: 'Lab ranges v1', password: PW, _csrf: csrf };
    const bad = await dr.post('/reference-ranges', { ...form, low: '6', high: '5' });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('must not be above the upper limit');
    expect((await dr.post('/reference-ranges', form)).location).toBe('/reference-ranges?notice=reference-range-added');
    expect((await dr.post('/reference-ranges', form)).html).toContain('already has an active range');
    // A female-only range does not apply to this male patient; an age band needs a birth date he does not have.
    expect((await dr.post('/reference-ranges', { ...form, localTestCode: 'NA', sex: 'F', low: '135', high: '145' })).status).toBe(303);
    expect((await dr.post('/reference-ranges', { ...form, localTestCode: 'CL', ageMin: '18', low: '98', high: '107' })).status).toBe(303);
    const list = await dr.get('/reference-ranges');
    expect(list.html).toContain('female, all ages');
    expect(list.html).toContain('everyone, from 18 years');

    await test('1', 'K', { status: 'sent', value: '5.6', approvedBy: 'dr.lab', range: '3.4-5.0' });
    await test('2', 'NA', { status: 'sent', value: '150', approvedBy: 'dr.lab' });
    await test('3', 'CL', { status: 'sent', value: '120', approvedBy: 'dr.lab' });

    const r = await dr.get(`/orders/${orderId}/report`);
    expect(r.html).toContain('3.5 to 5.1 mmol/L <span class="text-body-secondary">(lab)</span>'); // the lab's range wins over the instrument's 3.4-5.0
    expect(r.html).not.toContain('3.4-5.0');
    expect(r.html.match(/above range/g)?.length).toBe(1); // K only: no range applies to NA or CL
    expect(r.html).not.toContain('135 to 145');

    const k = await db.result.findFirstOrThrow({ where: { orderedTest: { localTestCode: 'K' } } });
    const page = await dr.get(`/results/${k.id}`);
    expect(page.html).toContain("(the lab's range for everyone, all ages; Lab ranges v1)");
    expect(page.html).toContain('<span class="badge text-bg-info">above range</span>');

    // Retiring the range leaves the stored value's report as it was.
    const range = await db.referenceRange.findFirstOrThrow({ where: { localTestCode: 'K' } });
    expect((await dr.post(`/reference-ranges/${range.id}/retire`, { _csrf: csrf, reason: 'new verification', password: PW })).location).toBe('/reference-ranges?notice=reference-range-retired');
    expect((await dr.get(`/orders/${orderId}/report`)).html).toContain('3.5 to 5.1 mmol/L');
    expect((await db.auditEvent.findMany({ where: { entityType: 'reference_range' } })).map((e) => e.action).sort()).toEqual(['reference-range.add', 'reference-range.add', 'reference-range.add', 'reference-range.retire']);
  });

  it('keeps comments on a result, prints only the approver\'s report comments, and never edits or deletes one', async () => {
    await test('1', 'K', { status: 'sent', value: '5.6', approvedBy: 'dr.lab' });
    await test('2', 'NA', { status: 'reviewed', value: '140' });
    const k = await db.result.findFirstOrThrow({ where: { orderedTest: { localTestCode: 'K' } } });
    const na = await db.result.findFirstOrThrow({ where: { orderedTest: { localTestCode: 'NA' } } });
    const tech = new Browser(base);
    expect((await tech.signIn('tech')).status).toBe(303);
    const dr = new Browser(base);
    expect((await dr.signIn('dr.lab')).status).toBe(303);

    let csrf = await tech.csrf(`/results/${k.id}`);
    expect((await tech.post(`/results/${k.id}/comments`, { _csrf: csrf, text: 'Sample   slightly\n haemolysed' })).location).toBe(`/results/${k.id}?notice=comment-added`);
    expect((await tech.post(`/results/${k.id}/comments`, { _csrf: csrf, text: 'On the report', onReport: 'yes' })).status).toBe(403);
    expect((await tech.post(`/results/${k.id}/comments`, { _csrf: csrf, text: 'x' })).status).toBe(422);
    const drCsrf = await dr.csrf(`/results/${k.id}`);
    await dr.post(`/results/${k.id}/comments`, { _csrf: drCsrf, text: 'Repeat advised in 24 hours.', onReport: 'yes' });
    await dr.post(`/results/${na.id}/comments`, { _csrf: drCsrf, text: 'Not yet approved, so not printed.', onReport: 'yes' });

    const page = await tech.get(`/results/${k.id}`);
    expect(page.html).toContain('Sample slightly haemolysed'); // whitespace collapsed
    expect(page.html).toContain('lab only');
    expect(page.html).toContain('on the report');
    let report = (await tech.get(`/orders/${orderId}/report`)).html;
    expect(report).toContain('Comment: Repeat advised in 24 hours.');
    expect(report).not.toContain('haemolysed');
    expect(report).not.toContain('Not yet approved');

    const reportComment = await db.resultComment.findFirstOrThrow({ where: { onReport: true, resultId: k.id } });
    csrf = await tech.csrf(`/results/${k.id}`);
    expect((await tech.post(`/results/${k.id}/comments/${reportComment.id}/withdraw`, { _csrf: csrf, reason: 'wrong patient' })).status).toBe(403);
    expect((await dr.post(`/results/${k.id}/comments/${reportComment.id}/withdraw`, { _csrf: drCsrf, reason: 'wrong patient' })).location).toBe(`/results/${k.id}?notice=comment-withdrawn`);
    expect((await dr.post(`/results/${k.id}/comments/${reportComment.id}/withdraw`, { _csrf: drCsrf, reason: 'wrong patient' })).status).toBe(409);
    expect((await dr.post(`/results/${na.id}/comments/${reportComment.id}/withdraw`, { _csrf: drCsrf, reason: 'wrong patient' })).status).toBe(404);
    report = (await tech.get(`/orders/${orderId}/report`)).html;
    expect(report).not.toContain('Repeat advised');
    expect((await tech.get(`/results/${k.id}`)).html).toContain('<s>Repeat advised in 24 hours.</s>');

    await expect(db.$executeRawUnsafe(`UPDATE result_comment SET text = 'changed' WHERE id = '${reportComment.id}'`)).rejects.toThrow();
    await expect(db.$executeRawUnsafe(`DELETE FROM result_comment WHERE id = '${reportComment.id}'`)).rejects.toThrow();
    expect((await db.auditEvent.findMany({ where: { action: { startsWith: 'result.comment' } } })).map((e) => e.action).sort()).toEqual(['result.comment', 'result.comment', 'result.comment', 'result.comment-withdrawn']);
  });
});
