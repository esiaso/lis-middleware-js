# 13. Phased Implementation Plan and MVP Scope

Durations are rough, for a team of 2 to 3 developers plus part-time QA, and
depend on discovery answers arriving on time. External dependencies are
marked with the discovery IDs from [01](01-assumptions-and-discovery.md).

## Phase 0: Discovery and foundations (2 to 3 weeks)

* Close B-1 to B-8 as far as possible; book vendor interface-test slots (D-15).
* Monorepo skeleton: npm workspaces, strict TS, lint boundary rules, CI with
  PostgreSQL service, Windows + Linux runners.
* `packages/config`, `packages/logging`, `packages/contracts` (initial),
  Prisma baseline migration, roles.
* Offline bundle builder proof: produce a bundle, install on a clean VM with
  no internet, `lims verify` incl. serialport load (de-risks AC-7 early).

**Exit:** bundle installs offline on both target OSes; discovery status
reviewed with the lab.

## Phase 1: Protocol cores and simulators (3 to 4 weeks)

* `protocol-astm`: E1381 codec + link state machine + E1394 parser for both
  e 411 dialects, from the manual we hold.
* `protocol-hl7v2`: MLLP codec + HL7 v2 parser/encoder.
* ASTM, MLLP, and HMIS simulators. Tests T-01 to T-07, T-12.
* Transports (serial, tcp-client, tcp-server) with backpressure and leases
  (T-08, T-09).

**Exit:** all codec tests green; fuzz tests (random splits, random bytes)
run for 1 h without crash or unbounded memory.

## Phase 2: MVP (6 to 8 weeks)

**MVP scope (deliberately narrow):**

| In | Out (later) |
|---|---|
| One cobas e 411 via device server, cobas® type (or Elecsys® per B-2), real-time query + result upload | e 411 batch download |
| Patients/encounters/orders from HMIS via **one** intake mode (whichever the HMIS supports) | Second intake mode |
| Specimen collection, accessioning, barcode labels (one printer model), receipt | Label designer |
| Result receipt, matching, quarantine, versioning, review, approval, release | Autoverification |
| HMIS result submission with idempotency + confirmation (as supported) | Corrections via API if the HMIS does not support them (manual process documented) |
| Durable inbox/outbox, retries, failed queue, replay | Bulk replay |
| Clinical audit with hash chain + daily signed export | SIEM streaming (if no SIEM yet) |
| UI screens W-1, W-2, W-3, W-4, W-6, W-7, W-8, W-11 (instrument registration) | W-5 load lists (unless Mindray is in MVP), W-9 editor (mappings loaded from reviewed file), W-10 advanced search |
| Local accounts + LDAPS **or** OIDC (one) | Second IdP method |
| Windows **or** Linux installer (whichever the hospital chooses, D-17) | The other OS |
| Downtime registration + manual reconciliation | Assisted matching proposals |

**Exit:** T-10 to T-26 green on simulators; IQ on the hospital test VM.

**Status (2026-11-03), against a stand-in HMIS** (`@lis/hmis` `SimulatedHmis`,
because D-1 to D-6 are still open): orders, accessioning, matching,
review, approval, release, corrections, delivery with read-back, replay and
the hash-chained audit trail are built and tested end to end. Screens built:
sign-in (local accounts, A-13), dashboard with instrument clearance, result
list and detail with review, approve, release, replay and correct (password
re-entry on approve, release and correct), unmatched results (close with a
reason), failed deliveries, a health endpoint, W-11 instrument
registration (identity, driver or generic profile, connection; changes that
reset verification are explained on the form), verification evidence
(interface test, lab acceptance signed with the approver's own password,
suspension, re-verification), turning instruments on and off, and loading
the reviewed mapping file as a draft that a different approver activates,
W-2 orders and collection (list with STAT first, search and accession scan;
tests grouped by specimen type; one container per collection; printable
barcode label with a reprint count, A-14; receipt in the lab; coded
rejection with recollection), W-3 specimen history, and W-7 linking an unmatched result to the same test
on a specimen (one person proposes with a reason, a different person sees
the patient and confirms with their password; unmapped codes and rejected
specimens are refused), and downtime registration with results held until
the order is reconciled to the HMIS order (A-15), and W-10 audit search,
export (A-16) and on-demand chain verification for auditors, and the W-9
row-by-row mapping editor (the approver sees what a draft changes against
the active set), and account management for administrators (create with a
temporary password that must be replaced at first sign-in, change roles,
disable and re-enable, unlock, reset password; each change needs the
administrator's own password, nobody can change their own account, and the
last active administrator cannot be removed), and hospital sign-in through
OIDC with directory groups mapped to roles and a fresh IdP sign-in to confirm
each approval-type action (A-17; tested against a stand-in IdP, not yet
against the hospital's, D-19), and critical results (limits from the lab
with their source, a flag on each version as it arrives, approval held
until the call with read-back is recorded, and the waiting list with its
timer on the dashboard; A-18, 08 §12), autoverification (off for
every test until the lab director adds a rule naming the validation report;
approves only, release stays with a person; A-19), delta checks (rules from the lab, flag shown to reviewers and holding autoverification; A-20), a QC log (QC results checked against the lab's ranges and optional Westgard rules, Levey-Jennings charts (W-15), a dashboard warning, an optional QC window for autoverification; A-21, A-23), a turnaround-time report with CSV export, lab-set targets and an overdue list (A-22, W-12), a workload report with CSV export (W-16), a patient history page with a cumulative report (W-13), and a printed result report per order (W-14), and DPAPI encryption of secret files on Windows
(10 §7; tested on the Windows CI runner, not yet on the hospital server).
Not built yet: "add test to order" from an
unmatched result (needs the HMIS, D-1 to D-6), assisted reconciliation when the HMIS returns (beyond the candidate list),
LDAPS, and the real HMIS connector, which waits for D-1 to D-6.

## Phase 3: Instrument verification and parallel run (3 to 6 weeks, calendar-bound)

* Interface verification of the e 411 with Roche (12 §4).
* Parallel run (AC-1 to AC-10). Lab continues the existing process; the
  middleware's HMIS delivery points to the HMIS **test** environment until
  sign-off, then production for a limited test set.
* Fix-and-retest cycle; each fix goes through CI and a new signed bundle.

**Exit:** laboratory acceptance signed for e 411 → `LAB_ACCEPTED`; go-live.

## Phase 3b: cobas c 111 (3 to 4 weeks, can overlap phase 3)

* Close B-9 (software version, Host Settings, Sample ID mode, ACN/Host Code table).
* `cobas-c111-astm` adapter on the existing ASTM core: record mapping, R-9
  status handling, C-record flags, M.CR/M.RR routing, H-5 identity check,
  RSREQ result recovery job (T-31).
* Second device server; XON/XOFF decision with Roche.
* Interface verification with Roche, parallel run, acceptance.

## Phase 4: Mindray (4 to 6 weeks after B-3, B-4, B-5 close)

* Confirm the right Mindray document for the installed model and firmware.
* `mindray-hl7-mllp` adapter, OBX mapping for the confirmed parameter set,
  ED blob handling, load lists (W-5) if worklist test selection is not
  supported.
* Interface verification with Mindray, parallel run, acceptance.

## Phase 5: Hardening and extensions

* Within-run rules (R-4s), if the lab wants them here (A-23).
* Critical-result escalation via hospital SMS/email gateway, and a target time with escalation steps (A-18). The on-screen workflow is built.
* Mapping editor UI with approval workflow (W-9).
* Second OS installer; SIEM streaming; archive tooling.
* Additional instruments from the inventory (D-26). From phase 2 an
  administrator can register them with a generic result-only profile
  ([14](14-adding-instruments.md)), already built and tested in
  `@lis/adapter-generic`. A model-specific driver follows when the
  instrument needs host query, each onboarded the same way: vendor manual for the installed version → row in the compatibility
  matrix → adapter on the shared protocol cores → simulator tests → vendor
  interface verification → parallel run → acceptance.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| HMIS API undocumented or unstable | Blocks phase 2 delivery | Build against simulator; insist on test environment before phase 3 |
| Installed e 411 software differs from the 2013 manual | Parser changes | B-1 early; simulators updated from on-site traces (`host_trace.log`) |
| Mindray document does not apply to installed model | Phase 4 slip | B-3 before phase 4 starts |
| Device server timing/buffering issues | Link errors | Test in phase 0 with a loopback; vendor-recommended settings |
| No idempotency or read-back in HMIS | Ambiguous deliveries need humans | Reconciliation UI in MVP; agree SLA with lab |
| Network change approvals slow | Calendar slip | Submit firewall request (11 §6) in phase 0 |
| Large Mindray messages | Disk growth | Short blob retention; measure in phase 4 |
