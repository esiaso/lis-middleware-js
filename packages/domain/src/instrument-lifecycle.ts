import {
  isGenericAdapter,
  type InstrumentRegistration,
  type InstrumentState,
  type VerificationEvidence,
  type VerificationStatus,
} from '@lis/contracts';

/**
 * Instrument verification lifecycle. Pure functions: callers persist the
 * returned state and write the audit event in the same transaction.
 *
 *   unverified ──interface-test──▶ vendor_tested ──lab-acceptance──▶ lab_accepted
 *        ▲                                                               │
 *        └──────reverification────── suspended ◀──────suspension─────────┘ (from any state)
 *
 * Only `lab_accepted` + enabled lets results reach the HMIS. Any change to what
 * the instrument is (model, serial, software) or how it is decoded (driver or
 * profile) sends it back to `unverified`.
 */

export type LifecycleError =
  | { code: 'EVIDENCE_NOT_ALLOWED'; detail: string }
  | { code: 'SOFTWARE_MISMATCH'; detail: string }
  | { code: 'SIGNER_MISMATCH'; detail: string };

export type LifecycleResult = { ok: true; state: InstrumentState } | { ok: false; error: LifecycleError };

/** A newly registered instrument: always unverified and disabled. */
export function registerInstrument(registration: InstrumentRegistration): InstrumentState {
  return { registration, verificationStatus: 'unverified', enabled: false };
}

const ALLOWED: Record<VerificationStatus, readonly VerificationEvidence['kind'][]> = {
  unverified: ['interface-test', 'suspension'],
  vendor_tested: ['lab-acceptance', 'suspension'],
  lab_accepted: ['suspension'],
  suspended: ['reverification'],
};

/**
 * Apply recorded evidence. `actor` is the signed-in user recording it; the
 * caller has already checked the permission (`instrument.verify`).
 */
export function applyEvidence(state: InstrumentState, evidence: VerificationEvidence, actor: string): LifecycleResult {
  const status = state.verificationStatus;
  if (!ALLOWED[status].includes(evidence.kind)) {
    return { ok: false, error: { code: 'EVIDENCE_NOT_ALLOWED', detail: `${evidence.kind} is not accepted while ${status}` } };
  }
  switch (evidence.kind) {
    case 'interface-test': {
      const installed = state.registration.softwareVersion;
      if (!installed || installed !== evidence.softwareVersion) {
        return {
          ok: false,
          error: {
            code: 'SOFTWARE_MISMATCH',
            detail: `tested software "${evidence.softwareVersion}" does not match registered "${installed ?? '(none)'}"`,
          },
        };
      }
      return { ok: true, state: { ...state, verificationStatus: 'vendor_tested', verifiedSoftwareVersion: installed } };
    }
    case 'lab-acceptance':
      if (evidence.signedBy !== actor) {
        // The signature must be the signed-in person's own; nobody signs for someone else.
        return { ok: false, error: { code: 'SIGNER_MISMATCH', detail: 'lab acceptance must be recorded by the person signing it' } };
      }
      return { ok: true, state: { ...state, verificationStatus: 'lab_accepted' } };
    case 'suspension':
      return { ok: true, state: { ...state, verificationStatus: 'suspended' } };
    case 'reverification': {
      const { verifiedSoftwareVersion: _dropped, ...rest } = state;
      return { ok: true, state: { ...rest, verificationStatus: 'unverified' } };
    }
  }
}

export interface RegistrationChangeOutcome {
  state: InstrumentState;
  /** Why the status was reset; empty if it was kept. */
  resetReasons: string[];
  /** Changes that keep the status but need a link re-test before clinical use continues. */
  retestReasons: string[];
}

/** Fields whose change means the verified thing is no longer the thing in front of us. */
const IDENTITY_FIELDS = ['manufacturer', 'model', 'serialNo', 'softwareVersion'] as const;

export function changeRegistration(state: InstrumentState, next: InstrumentRegistration): RegistrationChangeOutcome {
  const prev = state.registration;
  const resetReasons: string[] = [];
  const retestReasons: string[] = [];
  if (next.instrumentId !== prev.instrumentId) throw new Error('instrumentId cannot change; register a new instrument');

  for (const f of IDENTITY_FIELDS) {
    if ((prev[f] ?? '') !== (next[f] ?? '')) resetReasons.push(`${f} changed`);
  }
  if (prev.connection.adapter !== next.connection.adapter) resetReasons.push('driver changed');
  else if (stableJson(prev.connection.adapterOptions) !== stableJson(next.connection.adapterOptions)) {
    resetReasons.push(isGenericAdapter(next.connection.adapter) ? 'generic profile changed' : 'driver options changed');
  }
  if (stableJson(prev.connection.transport) !== stableJson(next.connection.transport)) retestReasons.push('transport changed');
  if (prev.connection.maxMessageBytes !== next.connection.maxMessageBytes) retestReasons.push('message size limit changed');

  if (resetReasons.length > 0 && state.verificationStatus !== 'unverified') {
    const { verifiedSoftwareVersion: _dropped, ...rest } = state;
    return { state: { ...rest, registration: next, verificationStatus: 'unverified' }, resetReasons, retestReasons };
  }
  return { state: { ...state, registration: next }, resetReasons, retestReasons };
}

export type ClinicalGate =
  | { releasable: true }
  | { releasable: false; reason: 'disabled' | 'not-lab-accepted' | 'software-changed'; detail: string };

/**
 * Whether results from this instrument may be released to the HMIS. Results
 * from instruments that fail the gate are still received, stored and shown
 * (for verification work) under a "not for clinical use" banner.
 */
export function clinicalGate(state: InstrumentState): ClinicalGate {
  return clinicalGateFor({
    enabled: state.enabled,
    verificationStatus: state.verificationStatus,
    softwareVersion: state.registration.softwareVersion,
    verifiedSoftwareVersion: state.verifiedSoftwareVersion,
  });
}

/** The same gate from stored columns, for callers that do not load the full registration. */
export function clinicalGateFor(s: {
  enabled: boolean;
  verificationStatus: VerificationStatus;
  softwareVersion?: string | null | undefined;
  verifiedSoftwareVersion?: string | null | undefined;
}): ClinicalGate {
  if (!s.enabled) return { releasable: false, reason: 'disabled', detail: 'instrument is disabled' };
  if (s.verificationStatus !== 'lab_accepted') {
    return { releasable: false, reason: 'not-lab-accepted', detail: `verification status is ${s.verificationStatus}` };
  }
  if ((s.verifiedSoftwareVersion ?? undefined) !== (s.softwareVersion ?? undefined)) {
    return { releasable: false, reason: 'software-changed', detail: 'software version differs from the verified one' };
  }
  return { releasable: true };
}

/** Compare reported identity (e.g. ASTM H-5 or HL7 MSH-3) with the registration; a mismatch raises an alert. */
export function identityMismatches(
  state: InstrumentState,
  reported: { softwareVersion?: string; serialNo?: string },
): string[] {
  const out: string[] = [];
  const r = state.registration;
  if (reported.softwareVersion && r.softwareVersion && reported.softwareVersion !== r.softwareVersion) {
    out.push(`software version reported "${reported.softwareVersion}", registered "${r.softwareVersion}"`);
  }
  if (reported.serialNo && r.serialNo && reported.serialNo !== r.serialNo) {
    out.push(`serial number reported "${reported.serialNo}", registered "${r.serialNo}"`);
  }
  return out;
}

function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}
