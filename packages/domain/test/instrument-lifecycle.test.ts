import { describe, expect, it } from 'vitest';
import { InstrumentRegistration, type InstrumentState } from '@lis/contracts';
import { applyEvidence, changeRegistration, clinicalGate, identityMismatches, registerInstrument } from '@lis/domain';

const reg = InstrumentRegistration.parse({
  instrumentId: 'chem-02',
  displayName: 'Chemistry 2',
  manufacturer: 'ExampleCo',
  model: 'Model X',
  serialNo: 'SN1',
  softwareVersion: '2.1',
  discipline: 'chemistry',
  interfaceManualRef: 'Host interface manual rev 3',
  connection: {
    instrumentId: 'chem-02',
    adapter: 'generic-astm',
    adapterOptions: { profile: 'generic-astm', sampleId: { record: 'O', field: 3 } },
    transport: { type: 'tcp-client', host: '10.20.5.20', port: 4003 },
  },
});

const interfaceTest = { kind: 'interface-test' as const, testedBy: 'FSE A', organisation: 'ExampleCo', testedAt: '2026-11-10T09:00:00+03:00', recordRef: 'IVR-0007', softwareVersion: '2.1' };
const acceptance = { kind: 'lab-acceptance' as const, signedBy: 'dr.lab', signedAt: '2026-11-30T09:00:00+03:00', acceptanceRef: 'PAR-0003' };

function accepted(): InstrumentState {
  let s = { ...registerInstrument(reg), enabled: true };
  const a = applyEvidence(s, interfaceTest, 'it.admin');
  if (!a.ok) throw new Error(a.error.detail);
  const b = applyEvidence(a.state, acceptance, 'dr.lab');
  if (!b.ok) throw new Error(b.error.detail);
  s = b.state;
  return s;
}

describe('instrument lifecycle', () => {
  it('registers new instruments unverified and disabled, and blocks clinical release', () => {
    const s = registerInstrument(reg);
    expect(s).toMatchObject({ verificationStatus: 'unverified', enabled: false });
    expect(clinicalGate(s)).toMatchObject({ releasable: false, reason: 'disabled' });
    expect(clinicalGate({ ...s, enabled: true })).toMatchObject({ releasable: false, reason: 'not-lab-accepted' });
  });

  it('needs an interface test, then lab acceptance, in that order', () => {
    const s = registerInstrument(reg);
    expect(applyEvidence(s, acceptance, 'dr.lab')).toMatchObject({ ok: false, error: { code: 'EVIDENCE_NOT_ALLOWED' } });
    expect(clinicalGate(accepted())).toEqual({ releasable: true });
  });

  it('rejects an interface test for a different software version', () => {
    const r = applyEvidence(registerInstrument(reg), { ...interfaceTest, softwareVersion: '2.2' }, 'it.admin');
    expect(r).toMatchObject({ ok: false, error: { code: 'SOFTWARE_MISMATCH' } });
  });

  it('only lets the signer record lab acceptance', () => {
    const a = applyEvidence(registerInstrument(reg), interfaceTest, 'it.admin');
    if (!a.ok) throw new Error();
    expect(applyEvidence(a.state, acceptance, 'someone.else')).toMatchObject({ ok: false, error: { code: 'SIGNER_MISMATCH' } });
  });

  it('resets to unverified when the profile, software or model changes, but not for a new IP', () => {
    const s = accepted();
    const newProfile = changeRegistration(s, {
      ...reg,
      connection: { ...reg.connection, adapterOptions: { profile: 'generic-astm', sampleId: { record: 'O', field: 4 } } },
    });
    expect(newProfile.state.verificationStatus).toBe('unverified');
    expect(newProfile.resetReasons).toEqual(['generic profile changed']);
    expect(clinicalGate(newProfile.state)).toMatchObject({ releasable: false });

    const sw = changeRegistration(s, { ...reg, softwareVersion: '2.2' });
    expect(sw.resetReasons).toEqual(['softwareVersion changed']);

    const ip = changeRegistration(s, { ...reg, connection: { ...reg.connection, transport: { type: 'tcp-client', host: '10.20.5.21', port: 4003, connectTimeoutMs: 5000, keepAliveMs: 30000, reconnectMinMs: 1000, reconnectMaxMs: 60000 } } });
    expect(ip.state.verificationStatus).toBe('lab_accepted');
    expect(ip.retestReasons).toEqual(['transport changed']);
  });

  it('ignores key order when comparing profiles', () => {
    const s = accepted();
    const reordered = { sampleId: { field: 3, record: 'O' }, profile: 'generic-astm' };
    expect(changeRegistration(s, { ...reg, connection: { ...reg.connection, adapterOptions: reordered } }).resetReasons).toEqual([]);
  });

  it('suspends from any state and re-enters through unverified', () => {
    const s = applyEvidence(accepted(), { kind: 'suspension', reason: 'wrong values seen on QC' }, 'dr.lab');
    if (!s.ok) throw new Error();
    expect(clinicalGate(s.state)).toMatchObject({ releasable: false });
    const back = applyEvidence(s.state, { kind: 'reverification', reason: 'driver fixed, retest booked' }, 'dr.lab');
    expect(back).toMatchObject({ ok: true, state: { verificationStatus: 'unverified' } });
  });

  it('reports identity mismatches from the instrument header', () => {
    expect(identityMismatches(accepted(), { softwareVersion: '2.3', serialNo: 'SN1' })).toEqual([
      'software version reported "2.3", registered "2.1"',
    ]);
  });
});

describe('InstrumentRegistration validation', () => {
  it('validates the generic profile inside adapterOptions and requires the manual reference', () => {
    const r = InstrumentRegistration.safeParse({
      ...reg,
      interfaceManualRef: undefined,
      connection: { ...reg.connection, adapterOptions: { profile: 'generic-astm' } },
    });
    expect(r.success).toBe(false);
    const paths = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('connection.adapterOptions.sampleId');
    expect(paths).toContain('interfaceManualRef');
  });

  it('requires the connection to belong to the same instrument', () => {
    const r = InstrumentRegistration.safeParse({ ...reg, connection: { ...reg.connection, instrumentId: 'chem-03' } });
    expect(r.success).toBe(false);
  });
});
