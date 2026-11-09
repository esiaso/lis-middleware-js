// A stand-in HMIS for the demo (demo/README.md). It is not the hospital's HMIS and says
// nothing about how that system will behave. It offers:
//  - http://localhost:3100: a page to place lab orders and see the results sent back;
//  - https://hmis:8443: the FHIR R4 interface the lab proposed (07 §6.6): client-credentials
//    token, the order feed with a cursor, result transactions with conditional updates, and
//    an Observation search by identifier for read-back.
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

const SYS = { mrn: 'https://hmis.demo/mrn', order: 'https://hmis.demo/order', orderLine: 'https://hmis.demo/order-line', test: 'https://hmis.demo/test', encounter: 'https://hmis.demo/encounter' };
// The tests this demo HMIS can order: a LOINC code where the demo catalogue has one, otherwise a local HMIS code.
const TESTS = [
  { code: '32700-7', name: 'Malaria rapid test' },
  { code: 'MAL-DENS', name: 'Malaria parasite density' },
  { code: 'U-PROT', name: 'Urine protein (dipstick)' },
];
const CLIENT_ID = process.env.HMIS_CLIENT_ID ?? 'lims-middleware';
const CLIENT_SECRET = process.env.HMIS_CLIENT_SECRET ?? 'demo-hmis-secret';
const STORE = process.env.HMIS_STORE ?? './hmis-store.json';

/** Everything the demo HMIS keeps, saved to one JSON file so a restart keeps orders and results. */
const state = existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : { seq: 0, feed: [], orders: [], resources: {}, received: [] };
const save = () => {
  writeFileSync(`${STORE}.tmp`, JSON.stringify(state));
  renameSync(`${STORE}.tmp`, STORE);
};
const tokens = new Set();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const body = (req) => new Promise((resolve) => { const p = []; req.on('data', (c) => p.push(c)); req.on('end', () => resolve(Buffer.concat(p).toString('utf8'))); });
const fhir = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/fhir+json' }); res.end(JSON.stringify(data)); };
const outcome = (text) => ({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'processing', diagnostics: text }] });
const hasId = (r, system, value) => (r.identifier ?? []).some((i) => i.system === system && i.value === value);
function token(t) {
  let i = 0;
  for (; i < t.length; i++) { if (t[i] === '\\') i++; else if (t[i] === '|') break; }
  const un = (s) => s.replace(/\\(.)/g, '$1');
  return [un(t.slice(0, i)), un(t.slice(i + 1))];
}

function placeOrder(f) {
  const n = ++state.seq;
  const order = `ORD-${String(n).padStart(5, '0')}`;
  const mrn = f.mrn.trim();
  const patient = { resourceType: 'Patient', id: `p-${mrn}`, identifier: [{ system: SYS.mrn, value: mrn }], name: [{ family: f.family.trim(), given: [f.given.trim()].filter(Boolean) }], gender: f.sex || 'unknown', ...(f.birthDate ? { birthDate: f.birthDate } : {}) };
  const encounter = f.ward.trim() ? { resourceType: 'Encounter', id: `e-${n}`, identifier: [{ system: SYS.encounter, value: `E-${n}` }], status: 'in-progress', class: { code: 'IMP' }, location: [{ location: { display: f.ward.trim() } }] } : undefined;
  const lines = [];
  for (const [i, code] of f.tests.entries()) {
    const line = `${order}-${i + 1}`;
    const sr = {
      resourceType: 'ServiceRequest', id: `sr-${line}`, identifier: [{ system: SYS.orderLine, value: line }], requisition: { system: SYS.order, value: order },
      status: 'active', intent: 'order', priority: f.priority || 'routine', code: { coding: [{ system: SYS.test, code }] },
      subject: { reference: `Patient/${patient.id}` }, ...(encounter ? { encounter: { reference: `Encounter/${encounter.id}` } } : {}),
      authoredOn: new Date().toISOString(), requester: { display: f.requester.trim() || 'Dr Demo' },
    };
    state.feed.push({ sr, patient, encounter });
    lines.push({ line, code, sr });
  }
  state.orders.unshift({ order, mrn, name: `${f.family} ${f.given}`.trim(), ward: f.ward, priority: f.priority || 'routine', at: new Date().toISOString(), lines: lines.map((l) => ({ line: l.line, code: l.code, status: 'active' })) });
  save();
}

function cancelOrder(order) {
  const o = state.orders.find((x) => x.order === order);
  if (!o) return;
  for (const l of o.lines.filter((x) => x.status === 'active')) {
    const prev = [...state.feed].reverse().find((e) => e.sr.identifier[0].value === l.line);
    state.feed.push({ ...prev, sr: { ...prev.sr, status: 'revoked' } });
    l.status = 'revoked';
  }
  save();
}

function applyTransaction(bundle) {
  const refs = new Map();
  const planned = (bundle.entry ?? []).map((e) => {
    const [type, query] = (e.request?.url ?? '').split('?');
    const [system, value] = token(new URLSearchParams(query ?? '').get('identifier') ?? '');
    const existing = Object.keys(state.resources).find((k) => k.startsWith(`${type}/`) && hasId(state.resources[k], system, value));
    const id = existing ? existing.split('/')[1] : String(++state.seq);
    if (e.fullUrl) refs.set(e.fullUrl, `${type}/${id}`);
    return { type, id, resource: e.resource, created: !existing };
  });
  const entry = planned.map((p) => {
    const text = JSON.stringify(p.resource).replace(/"(urn:uuid:[0-9a-f-]+)"/g, (m, u) => (refs.has(u) ? `"${refs.get(u)}"` : m));
    state.resources[`${p.type}/${p.id}`] = { ...JSON.parse(text), id: p.id };
    if (p.type === 'Observation') state.received.unshift({ key: `${p.type}/${p.id}`, at: new Date().toISOString(), updated: !p.created });
    return { response: { status: p.created ? '201 Created' : '200 OK', location: `${p.type}/${p.id}/_history/1` } };
  });
  save();
  return { resourceType: 'Bundle', type: 'transaction-response', entry };
}

// ---------- FHIR interface (https, for the middleware) ----------
async function onFhir(req, res) {
  const url = new URL(req.url ?? '/', 'https://hmis');
  const text = await body(req);
  if (url.pathname === '/token' && req.method === 'POST') {
    const [id, secret] = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString('utf8').split(':').map(decodeURIComponent);
    if (id !== CLIENT_ID || secret !== CLIENT_SECRET || new URLSearchParams(text).get('grant_type') !== 'client_credentials') return fhir(res, 401, { error: 'invalid_client' });
    const t = `demo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tokens.add(t);
    return fhir(res, 200, { access_token: t, token_type: 'Bearer', expires_in: 3600 });
  }
  if (!tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) return fhir(res, 401, outcome('token not accepted'));
  if (url.pathname === '/fhir/ServiceRequest/_lab-feed' && req.method === 'GET') {
    const from = Number(url.searchParams.get('cursor') ?? '0') || 0;
    const count = Number(url.searchParams.get('_count') ?? '100') || 100;
    const page = state.feed.slice(from, from + count);
    const entry = page.map((p) => ({ fullUrl: `https://hmis:8443/fhir/ServiceRequest/${p.sr.id}`, resource: p.sr, search: { mode: 'match' } }));
    const seen = new Set();
    for (const p of page) for (const r of [p.patient, p.encounter]) {
      if (!r || seen.has(`${r.resourceType}/${r.id}`)) continue;
      seen.add(`${r.resourceType}/${r.id}`);
      entry.push({ fullUrl: `https://hmis:8443/fhir/${r.resourceType}/${r.id}`, resource: r, search: { mode: 'include' } });
    }
    return fhir(res, 200, { resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'next', url: `https://hmis:8443/fhir/ServiceRequest/_lab-feed?cursor=${from + page.length}&_count=${count}` }], entry });
  }
  if (url.pathname === '/fhir' && req.method === 'POST') return fhir(res, 200, applyTransaction(JSON.parse(text)));
  if (url.pathname === '/fhir/Observation' && req.method === 'GET') {
    const [system, value] = token(url.searchParams.get('identifier') ?? '');
    const hits = Object.entries(state.resources).filter(([k, r]) => k.startsWith('Observation/') && hasId(r, system, value));
    return fhir(res, 200, { resourceType: 'Bundle', type: 'searchset', total: hits.length, entry: hits.map(([k, r]) => ({ fullUrl: `https://hmis:8443/fhir/${k}`, resource: r, search: { mode: 'match' } })) });
  }
  return fhir(res, 404, outcome(`no route ${req.method} ${url.pathname}`));
}

// ---------- Page for people (http) ----------
function valueText(o) {
  if (o.valueQuantity) return `${o.valueQuantity.comparator ?? ''}${o.valueQuantity.value} ${o.valueQuantity.unit ?? ''}`;
  if (o.valueCodeableConcept) return o.valueCodeableConcept.text ?? o.valueCodeableConcept.coding?.map((c) => c.display ?? c.code).join(', ');
  if (o.valueString !== undefined) return o.valueString;
  return o.dataAbsentReason ? `(no value: ${o.dataAbsentReason.text ?? o.dataAbsentReason.coding?.[0]?.code})` : '';
}

function page(msg = '') {
  const orders = state.orders.slice(0, 50).map((o) => `<tr><td><code>${esc(o.order)}</code></td><td>${esc(o.mrn)}</td><td>${esc(o.name)}</td><td>${esc(o.ward)}</td><td>${esc(o.priority)}</td><td>${o.lines.map((l) => `${esc(l.code)}${l.status !== 'active' ? ` (${esc(l.status)})` : ''}`).join(', ')}</td><td>${esc(o.at.slice(0, 16).replace('T', ' '))}</td><td>${o.lines.some((l) => l.status === 'active') ? `<form method="post" action="/orders/${esc(o.order)}/cancel"><button>Cancel</button></form>` : ''}</td></tr>`).join('');
  const results = state.received.slice(0, 50).map((r) => {
    const o = state.resources[r.key] ?? {};
    const line = (o.basedOn ?? []).map((b) => b.identifier?.value ?? b.reference).join(', ');
    const code = (o.code?.coding ?? []).map((c) => c.code).join(', ') || o.code?.text || '';
    return `<tr><td>${esc(r.at.slice(0, 19).replace('T', ' '))}${r.updated ? ' <b>(update)</b>' : ''}</td><td><code>${esc(line)}</code></td><td>${esc(code)}</td><td><b>${esc(valueText(o))}</b></td><td>${esc(o.status)}</td><td>${esc((o.interpretation ?? []).flatMap((i) => i.coding ?? []).map((c) => c.code).join(', '))}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Demo HMIS</title><meta http-equiv="refresh" content="30">
<style>body{font-family:system-ui,sans-serif;margin:1.5rem;max-width:72rem}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}td,th{border-bottom:1px solid #ccc;padding:.3rem;text-align:left;font-size:.9rem}fieldset{border:1px solid #ccc;padding:.75rem}label{display:inline-block;margin:.25rem .75rem .25rem 0}.note{background:#fff3cd;padding:.5rem}</style></head><body>
<h1>Demo HMIS</h1><p class="note">A stand-in for testing the LIMS middleware. Not the hospital's HMIS; made-up patients only. Orders reach the middleware on its next poll (about 10 seconds). This page refreshes every 30 seconds.</p>
${msg ? `<p><b>${esc(msg)}</b></p>` : ''}
<form method="post" action="/orders"><fieldset><legend>Place a lab order</legend>
<label>MRN <input name="mrn" required maxlength="20" value="MRN${1001 + state.orders.length}"></label>
<label>Family name <input name="family" required maxlength="40" value="Demo"></label>
<label>Given name <input name="given" maxlength="40" value="Patient"></label>
<label>Sex <select name="sex"><option value="female">female</option><option value="male">male</option><option value="unknown">unknown</option></select></label>
<label>Born <input name="birthDate" type="date" value="1990-05-01"></label>
<label>Ward <input name="ward" maxlength="40" value="Ward 3"></label>
<label>Priority <select name="priority"><option>routine</option><option>urgent</option><option>stat</option></select></label>
<label>Requester <input name="requester" maxlength="40" value="Dr Demo"></label><br>
${TESTS.map((t) => `<label><input type="checkbox" name="tests" value="${esc(t.code)}"> ${esc(t.name)} <code>${esc(t.code)}</code></label>`).join('')}<br>
<button>Place order</button></fieldset></form>
<h2>Orders</h2><table><thead><tr><th>Order</th><th>MRN</th><th>Patient</th><th>Ward</th><th>Priority</th><th>Tests</th><th>Placed (UTC)</th><th></th></tr></thead><tbody>${orders || '<tr><td colspan="8">No orders yet.</td></tr>'}</tbody></table>
<h2>Results received from the LIMS</h2><table><thead><tr><th>Received (UTC)</th><th>Order line</th><th>Test</th><th>Value</th><th>Status</th><th>Flags</th></tr></thead><tbody>${results || '<tr><td colspan="6">No results yet.</td></tr>'}</tbody></table>
</body></html>`;
}

async function onPage(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const html = (status, text) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(text); };
  if (req.method === 'GET' && url.pathname === '/') return html(200, page());
  if (req.method === 'POST' && url.pathname === '/orders') {
    const f = new URLSearchParams(await body(req));
    const tests = f.getAll('tests').filter((c) => TESTS.some((t) => t.code === c));
    const form = { mrn: f.get('mrn') ?? '', family: f.get('family') ?? '', given: f.get('given') ?? '', sex: f.get('sex') ?? '', birthDate: f.get('birthDate') ?? '', ward: f.get('ward') ?? '', priority: f.get('priority') ?? 'routine', requester: f.get('requester') ?? '', tests };
    if (!/^[A-Za-z0-9-]{1,20}$/.test(form.mrn.trim()) || !form.family.trim() || !tests.length) return html(422, page('Give an MRN (letters, digits, -), a family name and at least one test.'));
    placeOrder(form);
    res.writeHead(303, { location: '/' });
    return res.end();
  }
  const cancel = url.pathname.match(/^\/orders\/(ORD-\d+)\/cancel$/);
  if (req.method === 'POST' && cancel) {
    cancelOrder(cancel[1]);
    res.writeHead(303, { location: '/' });
    return res.end();
  }
  return html(404, 'Not found');
}

createHttps({ cert: readFileSync(process.env.HMIS_CERT), key: readFileSync(process.env.HMIS_KEY) }, (req, res) => void onFhir(req, res).catch((e) => fhir(res, 500, outcome(e.message)))).listen(8443, '0.0.0.0');
createHttp((req, res) => void onPage(req, res).catch((e) => { res.writeHead(500); res.end(String(e.message)); })).listen(3100, '0.0.0.0');
console.log('demo HMIS: page on :3100, FHIR on https :8443');
