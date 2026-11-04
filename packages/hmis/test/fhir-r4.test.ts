import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HmisResultSubmission } from '@lis/contracts';
import { FhirProtocolError, FhirR4Hmis, fhirHmisSettingsFromEnv, type FhirHmisSettings } from '@lis/hmis';
import { feedLine, startStubFhir, SYSTEMS, type StubFhir } from './fhir-stub.js';

const sub = (over: Partial<HmisResultSubmission> = {}): HmisResultSubmission => ({
  idempotencyKey: 'res-1:v1',
  hmisOrderId: 'ORD-1',
  hmisLineId: 'L-1',
  patient: { mrn: 'MRN1' },
  testCode: 'TSH',
  status: 'final',
  value: { type: 'numeric', value: '5.40', unit: 'mIU/L' },
  referenceRange: '0.27-4.20',
  abnormalFlag: 'H',
  approvedBy: { username: 'dr.lab', displayName: 'Dr Lab' },
  approvedAt: '2026-11-04T10:40:00+03:00',
  specimen: { accessionNo: 'L26110400001', collectedAt: '2026-11-04T08:40:00+03:00' },
  instrument: 'cobas e 411 (e411-01)',
  comments: ['Haemolysed sample'],
  correctionOf: null,
  ...over,
});

describe('FHIR R4 HMIS connector against a stand-in server', () => {
  let stub: StubFhir;
  let settings: FhirHmisSettings;
  let hmis: FhirR4Hmis;

  beforeEach(async () => {
    stub = await startStubFhir();
    settings = {
      baseUrl: new URL(stub.base),
      tokenUrl: new URL(stub.tokenUrl),
      clientId: stub.clientId,
      clientSecret: () => stub.clientSecret,
      scopes: 'system/ServiceRequest.read',
      pageSize: 100,
      systems: SYSTEMS,
      limsSystemPrefix: 'urn:lims-middleware:',
      timeoutMs: 2000,
      allowHttp: true,
    };
    hmis = new FhirR4Hmis(settings);
  });
  afterEach(async () => {
    await stub.close();
  });

  it('reads the feed page by page with the cursor and groups lines by requisition', async () => {
    stub.feed.push(
      feedLine({ srId: 'sr1', order: 'ORD-1', line: 'L-1', test: 'TSH', mrn: 'MRN1', encounter: 'enc1', priority: 'stat' }),
      feedLine({ srId: 'sr2', order: 'ORD-1', line: 'L-2', test: 'FT4', mrn: 'MRN1', encounter: 'enc1', priority: 'stat' }),
      feedLine({ srId: 'sr3', order: 'ORD-2', line: 'L-3', test: 'GLU', mrn: 'MRN2', family: 'Second', given: ['A', 'B'] }),
    );
    hmis = new FhirR4Hmis({ ...settings, pageSize: 10 });
    const p1 = await hmis.pullOrders(null);
    expect(p1.nextCursor).toBe('3');
    expect(p1.orders).toEqual([
      {
        hmisOrderId: 'ORD-1',
        patient: { mrn: 'MRN1', familyName: 'Example', givenName: 'Pat', birthDate: '1990-05-01', sex: 'F' },
        encounter: { hmisEncounterId: 'E-enc1', type: 'IMP', location: 'Ward 3' },
        priority: 'stat',
        orderedAt: '2026-11-04T08:15:00+03:00',
        orderingClinician: 'Dr Ward',
        lines: [
          { hmisLineId: 'L-1', testCode: 'TSH', status: 'active' },
          { hmisLineId: 'L-2', testCode: 'FT4', status: 'active' },
        ],
        status: 'active',
      },
      expect.objectContaining({ hmisOrderId: 'ORD-2', patient: expect.objectContaining({ mrn: 'MRN2', givenName: 'A B' }), lines: [{ hmisLineId: 'L-3', testCode: 'GLU', status: 'active' }] }),
    ]);
    expect(stub.requests.at(-1)).toBe('GET /fhir/ServiceRequest/_lab-feed?_count=10');
    const p2 = await hmis.pullOrders(p1.nextCursor);
    expect(p2).toEqual({ orders: [], nextCursor: '3' });
    expect(stub.requests.at(-1)).toBe('GET /fhir/ServiceRequest/_lab-feed?cursor=3&_count=10');
    // One token for all of it.
    expect(stub.tokensIssued).toBe(1);
  });

  it('a line the HMIS revoked arrives as cancelled', async () => {
    stub.feed.push(feedLine({ srId: 'sr1', order: 'ORD-1', line: 'L-1', test: 'TSH', mrn: 'MRN1', status: 'revoked' }), feedLine({ srId: 'sr2', order: 'ORD-1', line: 'L-2', test: 'FT4', mrn: 'MRN1', status: 'entered-in-error' }));
    const { orders } = await hmis.pullOrders(null);
    expect(orders[0]?.lines.map((l) => l.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('a feed entry missing what the lab needs stops the poll with the reason, rather than dropping the order', async () => {
    const bad = feedLine({ srId: 'sr9', order: 'ORD-9', line: 'L-9', test: 'TSH', mrn: 'MRN9' });
    (bad.serviceRequest as Record<string, unknown>)['code'] = { coding: [{ system: 'http://loinc.org', code: '3016-3' }] };
    stub.feed.push(bad);
    await expect(hmis.pullOrders(null)).rejects.toThrow(new FhirProtocolError('ServiceRequest/sr9: no code with system https://hmis.example/test'));
    const noMrn = feedLine({ srId: 'sr8', order: 'ORD-8', line: 'L-8', test: 'TSH', mrn: 'MRN8' });
    (noMrn.patient as Record<string, unknown>)['identifier'] = [{ system: 'https://other.example/id', value: 'X' }];
    stub.feed.splice(0, 1, noMrn);
    await expect(hmis.pullOrders(null)).rejects.toThrow(/no patient identifier with system https:\/\/hmis.example\/mrn/);
  });

  it('a feed answer without a next cursor is refused', async () => {
    stub.faults.feed = [{ status: 200, body: { resourceType: 'Bundle', type: 'searchset', entry: [] } }];
    await expect(hmis.pullOrders(null)).rejects.toThrow(/without a next link carrying a cursor/);
  });

  it('sends one transaction with conditional PUTs, keeping the decimal places', async () => {
    const out = await hmis.submitResult(sub(), 'res-1:v1');
    expect(out).toEqual({ kind: 'accepted', hmisResultId: 'Observation/1' });
    const raw = stub.transactions[0]!;
    expect(raw).toContain('"value":5.40');
    const t = JSON.parse(raw) as { entry: { request: { method: string; url: string }; resource: Record<string, unknown> }[] };
    expect(t.entry.map((e) => e.request)).toEqual([
      { method: 'PUT', url: `Observation?identifier=${encodeURIComponent('urn:lims-middleware:result|L-1')}` },
      { method: 'PUT', url: `DiagnosticReport?identifier=${encodeURIComponent('urn:lims-middleware:report|L-1')}` },
    ]);
    const obs = t.entry[0]!.resource;
    expect(obs).toMatchObject({
      resourceType: 'Observation',
      status: 'final',
      identifier: [
        { system: 'urn:lims-middleware:result', value: 'L-1' },
        { system: 'urn:lims-middleware:submission', value: 'res-1:v1' },
      ],
      subject: { identifier: { system: SYSTEMS.mrn, value: 'MRN1' } },
      basedOn: [{ identifier: { system: SYSTEMS.orderLine, value: 'L-1' } }],
      code: { coding: [{ system: SYSTEMS.test, code: 'TSH' }] },
      effectiveDateTime: '2026-11-04T08:40:00+03:00',
      issued: '2026-11-04T10:40:00+03:00',
      interpretation: [{ coding: [{ code: 'H' }] }],
      referenceRange: [{ text: '0.27-4.20' }],
      note: [{ text: 'Haemolysed sample' }],
    });
    // The report points at the Observation the server created.
    expect(stub.store.get('DiagnosticReport/2')).toMatchObject({ result: [{ reference: 'Observation/1' }] });
  });

  it('a repeat or a correction updates the same Observation rather than adding one', async () => {
    await hmis.submitResult(sub(), 'res-1:v1');
    await hmis.submitResult(sub(), 'res-1:v1');
    const c = await hmis.submitResult(sub({ status: 'corrected', idempotencyKey: 'res-1:v2', value: { type: 'censored', comparator: '<', value: '0.005', unit: 'mIU/L' }, correctionOf: 'res-1:v1', reason: 'wrong sample' }), 'res-1:v2');
    expect(c).toEqual({ kind: 'accepted', hmisResultId: 'Observation/1' });
    expect([...stub.store.keys()].filter((k) => k.startsWith('Observation/'))).toEqual(['Observation/1']);
    expect(stub.store.get('Observation/1')).toMatchObject({ status: 'corrected', valueQuantity: { value: 0.005, comparator: '<' }, note: [{ text: 'Haemolysed sample' }, { text: 'Corrected: wrong sample' }] });
    expect(await hmis.findResult({ idempotencyKey: 'res-1:v1', hmisOrderId: 'ORD-1', hmisLineId: 'L-1' })).toBeNull();
    expect(await hmis.findResult({ idempotencyKey: 'res-1:v2', hmisOrderId: 'ORD-1', hmisLineId: 'L-1' })).toEqual({
      hmisResultId: 'Observation/1',
      idempotencyKey: 'res-1:v2',
      status: 'corrected',
      value: { type: 'censored', comparator: '<', value: '0.005', unit: 'mIU/L' },
    });
  });

  it('gets a fresh token once when the HMIS refuses the cached one', async () => {
    await hmis.pullOrders(null);
    stub.revoked.add('tok-1');
    await hmis.pullOrders(null);
    expect(stub.tokensIssued).toBe(2);
  });

  it('classifies HMIS answers: busy is retryable with its wait, a refusal is rejected, a server fault is ambiguous', async () => {
    stub.faults.transaction = [
      { status: 429, headers: { 'retry-after': '120' } },
      { status: 503 },
      { status: 422, body: { resourceType: 'OperationOutcome', issue: [{ diagnostics: 'unknown test code TSH' }] } },
      { status: 500 },
      { status: 200, body: { resourceType: 'Bundle', type: 'transaction-response', entry: [] } },
    ];
    expect(await hmis.submitResult(sub(), 'k')).toEqual({ kind: 'retryable', reason: 'HTTP 429 stub fault 429', retryAfterMs: 120_000 });
    expect(await hmis.submitResult(sub(), 'k')).toMatchObject({ kind: 'retryable' });
    expect(await hmis.submitResult(sub(), 'k')).toEqual({ kind: 'rejected', reason: 'HTTP 422 unknown test code TSH' });
    expect(await hmis.submitResult(sub(), 'k')).toMatchObject({ kind: 'ambiguous' });
    expect(await hmis.submitResult(sub(), 'k')).toMatchObject({ kind: 'ambiguous', reason: 'HTTP 200 without a transaction-response' });
  });

  it('no answer in time is ambiguous; the result may be stored, and the lookup finds it', async () => {
    hmis = new FhirR4Hmis({ ...settings, timeoutMs: 300 });
    stub.faults.transaction = [{ status: 200, delayMs: 800, apply: true }];
    const out = await hmis.submitResult(sub(), 'res-1:v1');
    expect(out).toMatchObject({ kind: 'ambiguous', reason: expect.stringMatching(/no answer in time/) });
    await new Promise((r) => setTimeout(r, 700)); // the HMIS finishes its work after the middleware stopped waiting
    expect(await hmis.findResult({ idempotencyKey: 'res-1:v1', hmisOrderId: 'ORD-1', hmisLineId: 'L-1' })).toMatchObject({ idempotencyKey: 'res-1:v1', status: 'final' });
  });

  it('a token that cannot be had is retryable: nothing was sent', async () => {
    stub.faults.token = [{ status: 503 }];
    expect(await hmis.submitResult(sub(), 'k')).toEqual({ kind: 'retryable', reason: 'token request refused: HTTP 503' });
    expect(stub.transactions).toHaveLength(0);
    const wrong = new FhirR4Hmis({ ...settings, clientSecret: () => 'not-the-secret' });
    expect(await wrong.submitResult(sub(), 'k')).toMatchObject({ kind: 'retryable', reason: 'token request refused: HTTP 401' });
    const closed = await startStubFhir();
    await closed.close();
    const down = new FhirR4Hmis({ ...settings, tokenUrl: new URL(closed.tokenUrl) });
    expect(await down.submitResult(sub(), 'k')).toMatchObject({ kind: 'retryable', reason: expect.stringMatching(/token request failed: ECONNREFUSED/) });
  });

  it('an HMIS that cannot be reached is retryable: nothing was sent', async () => {
    await hmis.pullOrders(null); // token cached
    const closed = await startStubFhir();
    await closed.close();
    const down = new FhirR4Hmis({ ...settings, baseUrl: new URL(closed.base) });
    (down as unknown as { token: () => Promise<string> }).token = async () => 'tok-1';
    expect(await down.submitResult(sub(), 'k')).toEqual({ kind: 'retryable', reason: 'not sent: ECONNREFUSED' });
  });

  it('a value that is not a decimal is refused before sending', async () => {
    const r = sub({ value: { type: 'censored', comparator: '>', value: 'lots', unit: 'x' } });
    expect(await hmis.submitResult(r, 'k')).toEqual({ kind: 'rejected', reason: 'not sent: "lots" is not a decimal number' });
    expect(stub.transactions).toHaveLength(0);
  });

  it('refuses plain http unless a test allows it', () => {
    expect(() => new FhirR4Hmis({ ...settings, allowHttp: false })).toThrow(/https/);
  });
});

describe('fhirHmisSettingsFromEnv', () => {
  const env = {
    LIMS_HMIS_PROFILE: 'fhir-r4',
    LIMS_HMIS_BASE_URL: 'https://hmis.hospital.example/fhir/',
    LIMS_HMIS_TOKEN_URL: 'https://hmis.hospital.example/oauth/token',
    LIMS_HMIS_CLIENT_ID: 'lims',
    LIMS_HMIS_CLIENT_SECRET: 'a-long-secret',
    LIMS_HMIS_MRN_SYSTEM: 'https://hmis.hospital.example/mrn',
    LIMS_HMIS_ORDER_SYSTEM: 'https://hmis.hospital.example/order',
    LIMS_HMIS_ORDER_LINE_SYSTEM: 'https://hmis.hospital.example/order-line',
    LIMS_HMIS_TEST_SYSTEM: 'https://hmis.hospital.example/test',
  };

  it('is off without a profile and reads a complete setup', () => {
    expect(fhirHmisSettingsFromEnv({})).toBeUndefined();
    const s = fhirHmisSettingsFromEnv(env)!;
    expect(s.baseUrl.href).toBe('https://hmis.hospital.example/fhir');
    expect(s.pageSize).toBe(100);
    expect(s.clientSecret()).toBe('a-long-secret');
    expect(s.limsSystemPrefix).toBe('urn:lims-middleware:');
    expect(fhirHmisSettingsFromEnv({ ...env, LIMS_HMIS_PAGE_SIZE: '25' })!.pageSize).toBe(25);
  });

  it('refuses a half-done or unsafe setup with the reason', () => {
    expect(() => fhirHmisSettingsFromEnv({ ...env, LIMS_HMIS_PROFILE: 'hl7v2' })).toThrow(/only profile is fhir-r4/);
    expect(() => fhirHmisSettingsFromEnv({ ...env, LIMS_HMIS_BASE_URL: 'http://hmis/fhir' })).toThrow(/LIMS_HMIS_BASE_URL must be an https/);
    expect(() => fhirHmisSettingsFromEnv({ ...env, LIMS_HMIS_PAGE_SIZE: '1000' })).toThrow(/100, 25 or 10/);
    expect(() => fhirHmisSettingsFromEnv({ ...env, LIMS_HMIS_TEST_SYSTEM: '' })).toThrow(/LIMS_HMIS_TEST_SYSTEM is required/);
    expect(() => fhirHmisSettingsFromEnv({ ...env, LIMS_HMIS_MRN_SYSTEM: 'a|b' })).toThrow(/no spaces or "\|"/);
    const { LIMS_HMIS_CLIENT_SECRET: _, ...noSecret } = env;
    expect(() => fhirHmisSettingsFromEnv(noSecret)).toThrow(/lims secrets set hmis_client_secret/);
  });
});
