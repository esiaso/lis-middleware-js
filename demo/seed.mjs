// Demo accounts and tests (demo/README.md). Runs once per database; safe to run again.
// Everything here is made up for testing. None of it is clinical guidance or the lab's policy.
import { createDb } from '@lis/db';
import { createUser } from '@lis/web';
import { approveCatalogueEntry, proposeCatalogueEntry, setCallTarget } from '@lis/lab';

const db = createDb(process.env.DATABASE_URL);
const password = process.env.DEMO_PASSWORD ?? 'demo-password-1';

const USERS = [
  ['admin', 'Demo Administrator', ['admin']],
  ['tech', 'Demo Technologist', ['technologist']],
  ['approver1', 'Demo Approver One', ['approver']],
  ['approver2', 'Demo Approver Two', ['approver']],
  ['auditor', 'Demo Auditor', ['auditor']],
];

const base = { section: 'Parasitology', loincCode: '', loincDisplay: '', shaCode: '', specimenType: 'Blood', performedBy: 'MANUAL', unit: '', decimals: '' };
// Example tests read by a person. A positive malaria result is marked critical to show the call workflow (A-36).
const TESTS = [
  { ...base, localCode: 'MAL-RDT', name: 'Malaria rapid test (demo)', loincCode: '32700-7', loincDisplay: 'Demo LOINC name', resultType: 'NOMINAL', answers: 'NEG | Negative\nPF | P. falciparum positive | critical\nINV | Invalid' },
  { ...base, localCode: 'MAL-DENS', name: 'Malaria parasite density (demo)', resultType: 'NUMERIC', answers: '', unit: '/uL', decimals: '0' },
  { ...base, localCode: 'U-PROT', name: 'Urine protein, dipstick (demo)', section: 'Urinalysis', specimenType: 'Urine', resultType: 'ORDINAL', answers: 'NEG | Negative\nTR | Trace\n1+ | 1+ | abnormal\n2+ | 2+ | abnormal\n3+ | 3+ | abnormal' },
];
// HMIS test codes the demo HMIS offers for tests without a LOINC code (A LOINC code links itself on approval).
const CODE_MAP = [['MAL-DENS', 'MAL-DENS'], ['U-PROT', 'U-PROT']];

async function main() {
  if (await db.appUser.count()) {
    console.log('seed: demo data already present, nothing to do');
    return;
  }
  for (const [username, displayName, roles] of USERS) await createUser(db, { username, displayName, roles, password }, 'system:demo-seed');
  for (const t of TESTS) {
    const draft = await proposeCatalogueEntry(db, 'approver1', t, 'demo test');
    await approveCatalogueEntry(db, 'approver2', draft.id);
  }
  for (const [hmisTestCode, localTestCode] of CODE_MAP) await db.hmisCodeMap.create({ data: { hmisTestCode, localTestCode } });
  await setCallTarget(db, 'approver1', { localTestCode: '', minutes: '30', reference: 'Demo only, not a lab policy' });
  console.log(`seed: created ${USERS.length} demo accounts and ${TESTS.length} demo tests`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
