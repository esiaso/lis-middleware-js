import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HmisOrder, type HmisResultState, type HmisResultSubmission, type HmisResultValue, type SubmitOutcome } from '@lis/contracts';
import { readSecretFile } from '@lis/db';
import type { HmisConnector } from './connector.js';

/**
 * HMIS connector for FHIR R4 over REST (01 A-30), built to the interface
 * the lab proposed to the in-house HMIS team ("Proposed HMIS interface for
 * the lab middleware"; D-1 to D-6 answered 2026-11-04). The HMIS has no test
 * instance yet, so this is tested against a stand-in server only and is not
 * claimed to work with the HMIS until the acceptance tests in that proposal
 * pass.
 *
 * - Orders: `GET {base}/ServiceRequest/_lab-feed?cursor=…&_count=100` returns
 *   a searchset Bundle of changed lab ServiceRequests (one per order line)
 *   with their Patient and Encounter included, and a `next` link carrying
 *   the cursor for the following call.
 * - Results: one transaction Bundle per result, with conditional PUTs of an
 *   Observation (keyed by the order line) and its DiagnosticReport, so a
 *   repeat changes nothing; a lookup by the submission key settles a send
 *   whose answer was lost.
 * - Security: OAuth 2.0 client credentials; the token is cached and the
 *   secret read again at each token request, so a rotated secret needs no
 *   restart.
 */
export interface FhirHmisSettings {
  /** FHIR base, such as https://hmis.hospital.example/fhir */
  baseUrl: URL;
  tokenUrl: URL;
  clientId: string;
  /** Read at each token request. */
  clientSecret: () => string;
  scopes: string;
  /** 100 by default; 10 or 25 for shorter responses (D-5). */
  pageSize: 10 | 25 | 100;
  /** Identifier systems the HMIS uses. */
  systems: { mrn: string; order: string; orderLine: string; test: string };
  /** Prefix of the identifier systems the middleware writes: <prefix>result, <prefix>submission, <prefix>report. */
  limsSystemPrefix: string;
  timeoutMs: number;
  /** Tests only: an http:// stand-in. Never set from the environment. */
  allowHttp?: boolean;
  fetch?: typeof fetch;
}

const PAGE_SIZES = [10, 25, 100] as const;
const DEFAULT_SCOPES = 'system/ServiceRequest.read system/Patient.read system/Observation.read system/Observation.write system/DiagnosticReport.read system/DiagnosticReport.write';

function secretReader(env: NodeJS.ProcessEnv): () => string {
  const dir = env['CREDENTIALS_DIRECTORY'];
  const file = env['LIMS_HMIS_CLIENT_SECRET_FILE'];
  const plain = env['LIMS_HMIS_CLIENT_SECRET'];
  return () => {
    if (dir) {
      try {
        return readFileSync(join(dir, 'hmis_client_secret'), 'utf8').trim();
      } catch {
        // not provided as a credential; fall through
      }
    }
    if (file) return readSecretFile('hmis_client_secret', file).trim();
    if (plain) return plain;
    throw new Error('the HMIS client secret is missing: store it with lims secrets set hmis_client_secret');
  };
}

/** Undefined when no HMIS is configured (orders are then entered in downtime mode only). Throws on a half-done setup. */
export function fhirHmisSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): FhirHmisSettings | undefined {
  const profile = env['LIMS_HMIS_PROFILE']?.trim();
  if (!profile) return undefined;
  if (profile !== 'fhir-r4') throw new Error(`LIMS_HMIS_PROFILE "${profile.slice(0, 40)}" is not known; the only profile is fhir-r4`);
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is required when LIMS_HMIS_PROFILE is set`);
    return v;
  };
  const https = (k: string) => {
    const u = new URL(need(k));
    if (u.protocol !== 'https:') throw new Error(`${k} must be an https:// address`);
    return u;
  };
  const baseUrl = https('LIMS_HMIS_BASE_URL');
  const tokenUrl = https('LIMS_HMIS_TOKEN_URL');
  const pageSize = Number(env['LIMS_HMIS_PAGE_SIZE']?.trim() || '100');
  if (!(PAGE_SIZES as readonly number[]).includes(pageSize)) throw new Error('LIMS_HMIS_PAGE_SIZE must be 100, 25 or 10');
  const timeoutMs = Number(env['LIMS_HMIS_TIMEOUT_MS']?.trim() || '30000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new Error('LIMS_HMIS_TIMEOUT_MS must be a whole number of milliseconds from 1000 to 120000');
  const system = (k: string) => {
    const v = need(k);
    if (/[\s|]/.test(v)) throw new Error(`${k} must be a URI with no spaces or "|"`);
    return v;
  };
  const env2 = { ...env };
  const reader = secretReader(env2);
  if (!env2['CREDENTIALS_DIRECTORY'] && !env2['LIMS_HMIS_CLIENT_SECRET_FILE'] && !env2['LIMS_HMIS_CLIENT_SECRET']) reader(); // throws the clear message now, not at the first poll
  return {
    baseUrl: new URL(baseUrl.href.replace(/\/+$/, '')),
    tokenUrl,
    clientId: need('LIMS_HMIS_CLIENT_ID'),
    clientSecret: reader,
    scopes: env['LIMS_HMIS_SCOPES']?.trim() || DEFAULT_SCOPES,
    pageSize: pageSize as FhirHmisSettings['pageSize'],
    systems: { mrn: system('LIMS_HMIS_MRN_SYSTEM'), order: system('LIMS_HMIS_ORDER_SYSTEM'), orderLine: system('LIMS_HMIS_ORDER_LINE_SYSTEM'), test: system('LIMS_HMIS_TEST_SYSTEM') },
    limsSystemPrefix: env['LIMS_HMIS_LIMS_SYSTEM_PREFIX']?.trim() || 'urn:lims-middleware:',
    timeoutMs,
  };
}

// ---------- FHIR shapes (only what is read) ----------

interface Identifier { system?: string; value?: string }
interface Reference { reference?: string; identifier?: Identifier; display?: string }
interface Coding { system?: string; code?: string; display?: string }
interface Resource { resourceType: string; id?: string; [k: string]: unknown }
interface BundleEntry { fullUrl?: string; resource?: Resource; search?: { mode?: string }; response?: { status?: string; location?: string } }
interface Bundle { resourceType: 'Bundle'; type?: string; link?: { relation?: string; url?: string }[]; entry?: BundleEntry[]; total?: number }

/** A protocol problem in what the HMIS sent: the poll fails loudly rather than dropping an order. */
export class FhirProtocolError extends Error {}

const pick = (ids: unknown, system: string): string | undefined => (Array.isArray(ids) ? (ids as Identifier[]) : []).find((i) => i.system === system)?.value;

/** FHIR search token escaping: \ | , $ */
const token = (system: string, value: string) => `${system}|${value.replace(/[\\|,$]/g, (c) => `\\${c}`)}`;

const GENDER: Record<string, 'F' | 'M' | 'O' | 'U'> = { female: 'F', male: 'M', other: 'O', unknown: 'U' };
const PRIORITY: Record<string, 'routine' | 'urgent' | 'stat'> = { routine: 'routine', urgent: 'urgent', asap: 'urgent', stat: 'stat' };
const CANCELLED = ['revoked', 'entered-in-error'];
const V3_FLAGS = ['H', 'HH', 'L', 'LL', 'N', 'A', 'AA'];

const DECIMAL = /^[+-]?\d+(\.\d+)?$/;
/** JSON.stringify writes numbers without trailing zeros; a decimal keeps its places (5.40 stays 5.40). */
function stringifyWithDecimals(body: unknown): string {
  const marks = new Map<string, string>();
  const json = JSON.stringify(body, (_k, v: unknown) => {
    if (v && typeof v === 'object' && '__decimal' in v) {
      const key = `__dec_${marks.size}__`;
      marks.set(key, (v as { __decimal: string }).__decimal);
      return key;
    }
    return v;
  });
  return json.replace(/"__dec_(\d+)__"/g, (m) => marks.get(m.slice(1, -1)) ?? m);
}
const decimal = (s: string) => {
  if (!DECIMAL.test(s)) throw new Error(`"${s}" is not a decimal number`);
  return { __decimal: s.replace(/^\+/, '') };
};

export class FhirR4Hmis implements HmisConnector {
  readonly profile = 'fhir-r4@1';
  #token: { value: string; until: number } | null = null;
  readonly #fetch: typeof fetch;

  constructor(readonly settings: FhirHmisSettings) {
    for (const u of [settings.baseUrl, settings.tokenUrl]) {
      if (u.protocol !== 'https:' && !(settings.allowHttp && u.protocol === 'http:')) throw new Error('the HMIS connector needs https:// addresses');
    }
    this.#fetch = settings.fetch ?? fetch;
  }

  private sys(kind: 'result' | 'submission' | 'report'): string {
    return `${this.settings.limsSystemPrefix}${kind}`;
  }

  private async token(force = false): Promise<string> {
    if (!force && this.#token && this.#token.until > Date.now()) return this.#token.value;
    const s = this.settings;
    let secret: string;
    try {
      secret = s.clientSecret();
    } catch (e) {
      throw new TokenError((e as Error).message, 0);
    }
    const basic = Buffer.from(`${encodeURIComponent(s.clientId)}:${encodeURIComponent(secret)}`).toString('base64');
    let res: Response;
    let body: { access_token?: unknown; expires_in?: unknown };
    try {
      res = await this.#fetch(s.tokenUrl, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: s.scopes }).toString(),
        signal: AbortSignal.timeout(s.timeoutMs),
      });
      if (!res.ok) throw new TokenError(`token request refused: HTTP ${res.status}`, res.status);
      body = (await res.json()) as typeof body;
    } catch (e) {
      // No result has been sent yet, so any failure here is safe to retry.
      if (e instanceof TokenError) throw e;
      const err = e as Error;
      throw new TokenError(`token request failed: ${err.name === 'TimeoutError' ? 'no answer in time' : (errorCode(e) || err.message)}`, 0);
    }
    if (typeof body.access_token !== 'string' || !body.access_token) throw new TokenError('token response has no access_token', 0);
    const life = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 300;
    this.#token = { value: body.access_token, until: Date.now() + Math.max(30, life - 60) * 1000 };
    return body.access_token;
  }

  /** One authorised request; a 401 gets one fresh token and one more try (07 §6.5). */
  private async call(url: URL, init: { method: 'GET' | 'POST'; body?: string }): Promise<Response> {
    const go = async (force: boolean) =>
      this.#fetch(url, {
        method: init.method,
        headers: { authorization: `Bearer ${await this.token(force)}`, accept: 'application/fhir+json', ...(init.body ? { 'content-type': 'application/fhir+json' } : {}) },
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
    const first = await go(false);
    if (first.status !== 401) return first;
    await first.body?.cancel();
    return go(true);
  }

  private async bundle(url: URL): Promise<Bundle> {
    const res = await this.call(url, { method: 'GET' });
    if (!res.ok) throw new FhirProtocolError(`${url.pathname}: HTTP ${res.status} ${await outcomeText(res)}`);
    const b = (await res.json()) as Bundle;
    if (b?.resourceType !== 'Bundle') throw new FhirProtocolError(`${url.pathname}: the answer is not a FHIR Bundle`);
    return b;
  }

  async pullOrders(cursor: string | null): Promise<{ orders: HmisOrder[]; nextCursor: string | null }> {
    const s = this.settings;
    const url = new URL(`${s.baseUrl.href}/ServiceRequest/_lab-feed`);
    if (cursor) url.searchParams.set('cursor', cursor);
    url.searchParams.set('_count', String(s.pageSize));
    const b = await this.bundle(url);
    const next = b.link?.find((l) => l.relation === 'next')?.url;
    const nextCursor = next ? new URL(next, s.baseUrl).searchParams.get('cursor') : null;
    if (!nextCursor) throw new FhirProtocolError('the order feed answered without a next link carrying a cursor');
    return { orders: this.ordersFrom(b), nextCursor };
  }

  /** Lines of one requisition become one order. A page may hold only some lines of an order; the rest come later and are added to it. */
  ordersFrom(b: Bundle): HmisOrder[] {
    const s = this.settings.systems;
    const included = new Map<string, Resource>();
    for (const e of b.entry ?? []) {
      const r = e.resource;
      if (!r?.id || e.search?.mode === 'match') continue;
      included.set(`${r.resourceType}/${r.id}`, r);
      if (e.fullUrl) included.set(e.fullUrl, r);
    }
    const byOrder = new Map<string, HmisOrder>();
    for (const e of b.entry ?? []) {
      const sr = e.resource;
      if (sr?.resourceType !== 'ServiceRequest' || e.search?.mode === 'include') continue;
      const where = `ServiceRequest/${sr.id ?? '?'}`;
      const fail = (why: string): never => {
        throw new FhirProtocolError(`${where}: ${why}`);
      };
      const req = sr['requisition'] as Identifier | undefined;
      const orderId = (req?.system === undefined || req.system === s.order ? req?.value : undefined) ?? fail(`no requisition with system ${s.order}`);
      const lineId = pick(sr['identifier'], s.orderLine) ?? fail(`no identifier with system ${s.orderLine}`);
      const codings = ((sr['code'] as { coding?: Coding[] } | undefined)?.coding ?? []).filter((c) => c.system === s.test);
      const testCode = codings[0]?.code ?? fail(`no code with system ${s.test}`);
      const subject = (sr['subject'] as Reference | undefined) ?? fail('no subject');
      const patient = subject.reference ? included.get(subject.reference) : undefined;
      const mrn = (patient ? pick(patient['identifier'], s.mrn) : undefined) ?? (subject.identifier?.system === s.mrn ? subject.identifier.value : undefined) ?? fail(`no patient identifier with system ${s.mrn}`);
      const authoredOn = typeof sr['authoredOn'] === 'string' ? sr['authoredOn'] : fail('no authoredOn');
      const status = String(sr['status'] ?? '');
      const name = (patient?.['name'] as { family?: string; given?: string[] }[] | undefined)?.[0];
      const enc = (sr['encounter'] as Reference | undefined)?.reference;
      const encounter = enc ? included.get(enc) : undefined;
      const encId = encounter ? (((encounter['identifier'] as Identifier[] | undefined) ?? [])[0]?.value ?? encounter.id) : undefined;
      const location = (encounter?.['location'] as { location?: Reference }[] | undefined)?.[0]?.location?.display;
      const encType = (encounter?.['class'] as Coding | undefined)?.code;
      const order: HmisOrder = byOrder.get(orderId) ?? {
        hmisOrderId: orderId,
        patient: {
          mrn,
          ...(name?.family ? { familyName: name.family.slice(0, 100) } : {}),
          ...(name?.given?.length ? { givenName: name.given.join(' ').slice(0, 100) } : {}),
          ...(typeof patient?.['birthDate'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patient['birthDate']) ? { birthDate: patient['birthDate'] } : {}),
          ...(typeof patient?.['gender'] === 'string' && GENDER[patient['gender']] ? { sex: GENDER[patient['gender']] } : {}),
        },
        ...(encId ? { encounter: { hmisEncounterId: String(encId).slice(0, 64), ...(encType ? { type: encType.slice(0, 40) } : {}), ...(location ? { location: location.slice(0, 80) } : {}) } } : {}),
        priority: PRIORITY[String(sr['priority'] ?? 'routine')] ?? 'routine',
        orderedAt: authoredOn,
        ...((sr['requester'] as Reference | undefined)?.display ? { orderingClinician: (sr['requester'] as Reference).display!.slice(0, 100) } : {}),
        lines: [],
        // An order is cancelled line by line; a page may not hold all of its lines.
        status: 'active',
      };
      if (order.patient.mrn !== mrn) fail(`order ${orderId} has lines for two patients`);
      order.lines.push({ hmisLineId: lineId, testCode, status: CANCELLED.includes(status) ? 'cancelled' : 'active' });
      byOrder.set(orderId, order);
    }
    return [...byOrder.values()].map((o) => {
      const p = HmisOrder.safeParse(o);
      if (!p.success) throw new FhirProtocolError(`order ${o.hmisOrderId}: ${p.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      return p.data;
    });
  }

  /** The transaction the HMIS receives for one result (exported for tests and for the lab's own records). */
  resultTransaction(r: HmisResultSubmission, idempotencyKey: string): string {
    const s = this.settings.systems;
    const obsUrl = `urn:uuid:${randomUUID()}`;
    const subject = r.patient ? { subject: { identifier: { system: s.mrn, value: r.patient.mrn } } } : {};
    const basedOn = { basedOn: [{ identifier: { system: s.orderLine, value: r.hmisLineId } }] };
    const code = { code: { coding: [{ system: s.test, code: r.testCode }] } };
    const notes = [...r.comments, ...(r.status === 'corrected' && r.reason ? [`Corrected: ${r.reason}`] : [])];
    const observation = {
      resourceType: 'Observation',
      identifier: [
        { system: this.sys('result'), value: r.hmisLineId },
        { system: this.sys('submission'), value: idempotencyKey },
      ],
      status: r.status,
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
      ...code,
      ...subject,
      ...basedOn,
      ...(r.specimen.collectedAt ? { effectiveDateTime: r.specimen.collectedAt } : r.performedAt ? { effectiveDateTime: r.performedAt } : {}),
      issued: r.approvedAt,
      performer: [{ display: r.approvedBy.displayName }],
      ...valueElement(r.value),
      ...(r.abnormalFlag ? { interpretation: [V3_FLAGS.includes(r.abnormalFlag) ? { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: r.abnormalFlag }] } : { text: r.abnormalFlag }] } : {}),
      ...(r.referenceRange ? { referenceRange: [{ text: r.referenceRange }] } : {}),
      ...(r.instrument ? { device: { display: r.instrument } } : {}),
      ...(r.specimen.accessionNo ? { specimen: { display: r.specimen.accessionNo } } : {}),
      ...(notes.length ? { note: notes.map((text) => ({ text })) } : {}),
    };
    const report = {
      resourceType: 'DiagnosticReport',
      identifier: [{ system: this.sys('report'), value: r.hmisLineId }],
      status: r.status,
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB' }] }],
      ...code,
      ...subject,
      ...basedOn,
      issued: r.approvedAt,
      result: [{ reference: obsUrl }],
    };
    return stringifyWithDecimals({
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { fullUrl: obsUrl, resource: observation, request: { method: 'PUT', url: `Observation?identifier=${encodeURIComponent(token(this.sys('result'), r.hmisLineId))}` } },
        { fullUrl: `urn:uuid:${randomUUID()}`, resource: report, request: { method: 'PUT', url: `DiagnosticReport?identifier=${encodeURIComponent(token(this.sys('report'), r.hmisLineId))}` } },
      ],
    });
  }

  async submitResult(r: HmisResultSubmission, idempotencyKey: string): Promise<SubmitOutcome> {
    let body: string;
    try {
      body = this.resultTransaction(r, idempotencyKey);
    } catch (e) {
      return { kind: 'rejected', reason: `not sent: ${(e as Error).message}` };
    }
    let res: Response;
    try {
      res = await this.call(this.settings.baseUrl, { method: 'POST', body });
    } catch (e) {
      return classifyFailure(e);
    }
    const status = res.status;
    if (status >= 200 && status < 300) {
      let b: Bundle;
      try {
        b = (await res.json()) as Bundle;
      } catch {
        return { kind: 'ambiguous', reason: `HTTP ${status} with a body that is not JSON` };
      }
      const location = b?.resourceType === 'Bundle' ? b.entry?.[0]?.response?.location : undefined;
      if (!location) return { kind: 'ambiguous', reason: `HTTP ${status} without a transaction-response` };
      return { kind: 'accepted', hmisResultId: location.replace(/\/_history\/.*$/, '') };
    }
    const why = `HTTP ${status} ${await outcomeText(res)}`.trim();
    if ([408, 425, 429, 502, 503, 504].includes(status)) {
      const after = retryAfterMs(res.headers.get('retry-after'));
      return after === undefined ? { kind: 'retryable', reason: why } : { kind: 'retryable', reason: why, retryAfterMs: after };
    }
    if (status === 401 || status === 403) return { kind: 'retryable', reason: `${why} (check the HMIS client and its scopes)` };
    if (status >= 500) return { kind: 'ambiguous', reason: why };
    return { kind: 'rejected', reason: why };
  }

  async findResult(lookup: { idempotencyKey: string; hmisOrderId: string; hmisLineId: string }): Promise<HmisResultState | null> {
    const url = new URL(`${this.settings.baseUrl.href}/Observation`);
    url.searchParams.set('identifier', token(this.sys('submission'), lookup.idempotencyKey));
    const b = await this.bundle(url);
    const obs = (b.entry ?? []).map((e) => e.resource).filter((r): r is Resource => r?.resourceType === 'Observation');
    if (obs.length === 0) return null;
    if (obs.length > 1) throw new FhirProtocolError(`${obs.length} Observations carry submission ${lookup.idempotencyKey}`);
    const o = obs[0]!;
    const key = pick(o['identifier'], this.sys('submission'));
    if (key !== lookup.idempotencyKey) throw new FhirProtocolError('the Observation found does not carry the submission key searched for');
    return { hmisResultId: `Observation/${o.id ?? ''}`, idempotencyKey: key, status: o['status'] === 'corrected' ? 'corrected' : 'final', value: valueFrom(o) };
  }
}

/** The token could not be had; nothing was sent to the HMIS. */
export class TokenError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function valueElement(v: HmisResultValue): Record<string, unknown> {
  switch (v.type) {
    case 'numeric':
      return { valueQuantity: { value: decimal(v.value), ...(v.unit ? { unit: v.unit } : {}) } };
    case 'censored':
      return { valueQuantity: { value: decimal(v.value), comparator: v.comparator, ...(v.unit ? { unit: v.unit } : {}) } };
    case 'coded':
      // A code the lab chose without a system stays text only: no system is invented for it.
      return v.system
        ? { valueCodeableConcept: { coding: [{ system: v.system, code: v.code, ...(v.display ? { display: v.display } : {}) }], text: v.display ?? v.code } }
        : { valueCodeableConcept: { text: v.display ?? v.code } };
    case 'text':
      return { valueString: v.text };
  }
}

function valueFrom(o: Resource): HmisResultValue {
  const q = o['valueQuantity'] as { value?: number | string; comparator?: string; unit?: string } | undefined;
  if (q && q.value !== undefined) {
    const value = String(q.value);
    const unit = q.unit ? { unit: q.unit } : {};
    if (q.comparator === '<' || q.comparator === '<=' || q.comparator === '>' || q.comparator === '>=') return { type: 'censored', comparator: q.comparator, value, ...unit };
    return { type: 'numeric', value, ...unit };
  }
  const c = o['valueCodeableConcept'] as { text?: string; coding?: Coding[] } | undefined;
  if (c) {
    const coding = c.coding?.[0];
    if (coding?.code) return { type: 'coded', code: coding.code, ...(coding.system ? { system: coding.system } : {}), ...(coding.display ? { display: coding.display } : {}) };
    return { type: 'coded', code: c.text ?? '' };
  }
  return { type: 'text', text: typeof o['valueString'] === 'string' ? o['valueString'] : '' };
}

async function outcomeText(res: Response): Promise<string> {
  try {
    const b = (await res.json()) as { resourceType?: string; issue?: { diagnostics?: string; code?: string }[] };
    if (b?.resourceType === 'OperationOutcome') return (b.issue ?? []).map((i) => i.diagnostics ?? i.code ?? '').filter(Boolean).join('; ').slice(0, 500);
  } catch {
    // no JSON body
  }
  return '';
}

function retryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined;
  if (/^\d+$/.test(h.trim())) return Number(h.trim()) * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** The system error code behind a failed fetch; a host with several addresses fails with one per address. */
function errorCode(e: unknown): string {
  const cause = (e as { cause?: { code?: string; errors?: { code?: string }[] } }).cause;
  return cause?.code ?? cause?.errors?.find((x) => x.code)?.code ?? '';
}

/** 07 §6.5: refused before sending is retryable; anything after the request may have reached the HMIS is ambiguous. */
function classifyFailure(e: unknown): SubmitOutcome {
  if (e instanceof TokenError) return { kind: 'retryable', reason: e.message };
  const err = e as Error;
  const code = errorCode(e);
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(code)) {
    return { kind: 'retryable', reason: `not sent: ${code}` };
  }
  return { kind: 'ambiguous', reason: `${err.name === 'TimeoutError' ? 'no answer in time' : (code || err.message)}: the HMIS may have the result` };
}
