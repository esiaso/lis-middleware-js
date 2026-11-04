import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the HMIS FHIR interface the lab proposed (tests only): a
 * client-credentials token endpoint, the order feed with a cursor, a
 * transaction endpoint that applies conditional PUTs, and an Observation
 * search by identifier. It follows the proposal, not any product, and says
 * nothing about how the real HMIS will behave.
 */
export interface Fault {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Answer after this long (to test timeouts). */
  delayMs?: number;
  /** Apply the request (store the result) but still answer with this fault: a lost answer. */
  apply?: boolean;
}

export interface StubFhir {
  base: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Feed entries in change order; each is a ServiceRequest with its Patient (and optional Encounter). */
  feed: { serviceRequest: Record<string, unknown>; patient: Record<string, unknown>; encounter?: Record<string, unknown> }[];
  /** Stored resources by type/id. */
  store: Map<string, Record<string, unknown>>;
  /** Raw bodies of each transaction received. */
  transactions: string[];
  tokensIssued: number;
  /** Requests seen: method and path with query. */
  requests: string[];
  /** Answers to give before behaving normally, keyed by "token", "feed", "transaction" or "search". */
  faults: Partial<Record<'token' | 'feed' | 'transaction' | 'search', Fault[]>>;
  /** Tokens the server no longer accepts (to test a refresh after 401). */
  revoked: Set<string>;
  tokenLifeSeconds: number;
  close(): Promise<void>;
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/fhir+json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const outcome = (text: string) => ({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'processing', diagnostics: text }] });
const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  });
const hasIdentifier = (r: Record<string, unknown>, system: string, value: string) =>
  ((r['identifier'] as { system?: string; value?: string }[] | undefined) ?? []).some((i) => i.system === system && i.value === value);
/** system|value with FHIR escapes \| \, \$ \\ */
function parseToken(t: string): [string, string] {
  let i = 0;
  for (; i < t.length; i++) {
    if (t[i] === '\\') i++;
    else if (t[i] === '|') break;
  }
  const unescape = (s: string) => s.replace(/\\(.)/g, '$1');
  return [unescape(t.slice(0, i)), unescape(t.slice(i + 1))];
}

export async function startStubFhir(): Promise<StubFhir> {
  let nextId = 1;
  const issued = new Set<string>();
  const stub = {
    clientId: 'lims-middleware',
    clientSecret: 'stub-secret-123',
    feed: [],
    store: new Map(),
    transactions: [],
    tokensIssued: 0,
    requests: [],
    faults: {},
    revoked: new Set<string>(),
    tokenLifeSeconds: 3600,
  } as unknown as StubFhir;

  const fault = async (kind: keyof StubFhir['faults'], res: ServerResponse): Promise<Fault | undefined> => {
    const f = stub.faults[kind]?.shift();
    if (!f) return undefined;
    if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
    return f;
  };
  const answerFault = (res: ServerResponse, f: Fault) => {
    if (res.destroyed) return;
    json(res, f.status, f.body ?? outcome(`stub fault ${f.status}`), f.headers);
  };

  function applyTransaction(bundle: { entry?: { fullUrl?: string; resource?: Record<string, unknown>; request?: { method?: string; url?: string } }[] }) {
    const out: { response: { status: string; location: string } }[] = [];
    const refs = new Map<string, string>();
    const planned = (bundle.entry ?? []).map((e) => {
      const [type, query] = (e.request?.url ?? '').split('?');
      const params = new URLSearchParams(query ?? '');
      const [system, value] = parseToken(params.get('identifier') ?? '');
      const existing = [...stub.store.entries()].find(([k, r]) => k.startsWith(`${type}/`) && hasIdentifier(r, system, value));
      const id = existing ? existing[0].split('/')[1]! : String(nextId++);
      if (e.fullUrl) refs.set(e.fullUrl, `${type}/${id}`);
      return { type: type!, id, resource: e.resource!, created: !existing };
    });
    for (const p of planned) {
      const text = JSON.stringify(p.resource).replace(/"(urn:uuid:[0-9a-f-]+)"/g, (m, u: string) => (refs.has(u) ? `"${refs.get(u)}"` : m));
      stub.store.set(`${p.type}/${p.id}`, { ...(JSON.parse(text) as Record<string, unknown>), id: p.id, rawJson: text });
      out.push({ response: { status: p.created ? '201 Created' : '200 OK', location: `${p.type}/${p.id}/_history/1` } });
    }
    return { resourceType: 'Bundle', type: 'transaction-response', entry: out };
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    stub.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const body = await read(req);
    if (url.pathname === '/token' && req.method === 'POST') {
      const f = await fault('token', res);
      if (f) return answerFault(res, f);
      const auth = req.headers.authorization ?? '';
      const [id, secret] = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString('utf8').split(':').map(decodeURIComponent);
      const form = new URLSearchParams(body);
      if (id !== stub.clientId || secret !== stub.clientSecret || form.get('grant_type') !== 'client_credentials') return json(res, 401, { error: 'invalid_client' });
      const token = `tok-${++stub.tokensIssued}`;
      issued.add(token);
      return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: stub.tokenLifeSeconds });
    }
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!issued.has(bearer) || stub.revoked.has(bearer)) return json(res, 401, outcome('token not accepted'));

    if (url.pathname === '/fhir/ServiceRequest/_lab-feed' && req.method === 'GET') {
      const f = await fault('feed', res);
      if (f) return answerFault(res, f);
      const from = Number(url.searchParams.get('cursor') ?? '0');
      const count = Number(url.searchParams.get('_count') ?? '100');
      const page = stub.feed.slice(from, from + count);
      const entry: unknown[] = [];
      const seen = new Set<string>();
      for (const p of page) entry.push({ fullUrl: `http://stub/fhir/ServiceRequest/${String(p.serviceRequest['id'])}`, resource: p.serviceRequest, search: { mode: 'match' } });
      for (const p of page) {
        for (const r of [p.patient, p.encounter]) {
          if (!r) continue;
          const key = `${String(r['resourceType'])}/${String(r['id'])}`;
          if (seen.has(key)) continue;
          seen.add(key);
          entry.push({ fullUrl: `http://stub/fhir/${key}`, resource: r, search: { mode: 'include' } });
        }
      }
      const next = `${stub.base}/ServiceRequest/_lab-feed?cursor=${from + page.length}&_count=${count}`;
      return json(res, 200, { resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }, { relation: 'next', url: next }], entry });
    }
    if (url.pathname === '/fhir' && req.method === 'POST') {
      stub.transactions.push(body);
      const f = await fault('transaction', res);
      if (f && !f.apply) return answerFault(res, f);
      const response = applyTransaction(JSON.parse(body) as Parameters<typeof applyTransaction>[0]);
      if (f) return answerFault(res, f);
      return json(res, 200, response);
    }
    if (url.pathname === '/fhir/Observation' && req.method === 'GET') {
      const f = await fault('search', res);
      if (f) return answerFault(res, f);
      const [system, value] = parseToken(url.searchParams.get('identifier') ?? '');
      const hits = [...stub.store.entries()].filter(([k, r]) => k.startsWith('Observation/') && hasIdentifier(r, system, value));
      return json(res, 200, { resourceType: 'Bundle', type: 'searchset', total: hits.length, entry: hits.map(([k, r]) => ({ fullUrl: `http://stub/fhir/${k}`, resource: { ...r, rawJson: undefined }, search: { mode: 'match' } })) });
    }
    return json(res, 404, outcome(`no route ${req.method} ${url.pathname}`));
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  stub.base = `http://127.0.0.1:${port}/fhir`;
  stub.tokenUrl = `http://127.0.0.1:${port}/token`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}

/** A feed entry as the proposal describes it: one ServiceRequest per order line. */
export function feedLine(o: {
  srId: string;
  order: string;
  line: string;
  test: string;
  mrn: string;
  status?: string;
  priority?: string;
  family?: string;
  given?: string[];
  encounter?: string;
}) {
  const patientId = `p-${o.mrn}`;
  return {
    serviceRequest: {
      resourceType: 'ServiceRequest',
      id: o.srId,
      identifier: [{ system: 'https://hmis.example/order-line', value: o.line }],
      requisition: { system: 'https://hmis.example/order', value: o.order },
      status: o.status ?? 'active',
      intent: 'order',
      priority: o.priority ?? 'routine',
      category: [{ coding: [{ system: 'http://snomed.info/sct', code: '108252007' }] }],
      code: { coding: [{ system: 'https://hmis.example/test', code: o.test }] },
      subject: { reference: `Patient/${patientId}` },
      ...(o.encounter ? { encounter: { reference: `Encounter/${o.encounter}` } } : {}),
      authoredOn: '2026-11-04T08:15:00+03:00',
      requester: { display: 'Dr Ward' },
    },
    patient: {
      resourceType: 'Patient',
      id: patientId,
      identifier: [{ system: 'https://hmis.example/mrn', value: o.mrn }],
      name: [{ family: o.family ?? 'Example', given: o.given ?? ['Pat'] }],
      gender: 'female',
      birthDate: '1990-05-01',
    },
    ...(o.encounter
      ? { encounter: { resourceType: 'Encounter', id: o.encounter, identifier: [{ system: 'https://hmis.example/encounter', value: `E-${o.encounter}` }], class: { code: 'IMP' }, location: [{ location: { display: 'Ward 3' } }] } }
      : {}),
  };
}

export const SYSTEMS = { mrn: 'https://hmis.example/mrn', order: 'https://hmis.example/order', orderLine: 'https://hmis.example/order-line', test: 'https://hmis.example/test' };
