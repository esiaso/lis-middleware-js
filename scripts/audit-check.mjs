#!/usr/bin/env node
// Dependency gate (10 §10): run `npm audit` on what ships (no dev dependencies) and fail on any
// high or critical advisory that security/audit-exceptions.json does not explain, or whose
// explanation is past its review date. Moderate and low findings are printed, not fatal.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const today = new Date().toISOString().slice(0, 10);
const { exceptions } = JSON.parse(readFileSync(new URL('../security/audit-exceptions.json', import.meta.url), 'utf8'));
const r = spawnSync('npm', ['audit', '--omit=dev', '--package-lock-only', '--json'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
let report;
try {
  report = JSON.parse(r.stdout);
} catch {
  console.error(`npm audit gave no report (exit ${r.status}): ${r.stderr.trim()}`);
  process.exit(2);
}
if (report.error) {
  console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(2);
}

// Advisories are on the package that has them; parents only point at children.
const found = [];
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via) if (typeof via === 'object') found.push({ name, id: via.url?.split('/').pop() ?? String(via.source), severity: via.severity, title: via.title });
}
let bad = 0;
for (const f of found) {
  const ex = exceptions.find((e) => e.advisory === f.id && e.package === f.name);
  const serious = f.severity === 'high' || f.severity === 'critical';
  let verdict;
  if (ex && ex.reviewBy < today) {
    verdict = `FAIL  explanation expired ${ex.reviewBy}: read the advisory again and update security/audit-exceptions.json`;
    bad++;
  } else if (ex) verdict = `ok    explained: ${ex.reason}`;
  else if (serious) {
    verdict = 'FAIL  not explained: upgrade, or record why it does not apply in security/audit-exceptions.json';
    bad++;
  } else verdict = 'note  below high';
  console.log(`${f.severity.padEnd(8)} ${f.name} ${f.id} ${f.title}\n         ${verdict}`);
}
for (const e of exceptions) if (!found.some((f) => f.id === e.advisory && f.name === e.package)) console.log(`unused   ${e.package} ${e.advisory}: no longer reported; remove it from security/audit-exceptions.json`);
console.log(bad ? `\nRESULT: FAIL (${bad})` : '\nRESULT: PASS');
process.exit(bad ? 1 : 0);
