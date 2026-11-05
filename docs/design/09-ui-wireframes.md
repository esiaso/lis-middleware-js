# 09. UI Wireframes

Server-rendered Handlebars pages with Bootstrap (vendored locally). Pages
work without JavaScript; small scripts add barcode-scanner focus handling and
auto-refresh of status panels. Every page shows the logged-in user, role, and
the hospital time zone.

## Status vocabulary (used everywhere)

| Badge | Meaning | Colour + icon (never colour alone) |
|---|---|---|
| RECEIVED | Stored from analyzer, not reviewed | grey, inbox icon |
| REVIEWED | Technologist reviewed | blue, eye icon |
| APPROVED | Authorised, about to queue | indigo, check icon |
| QUEUED | Waiting for HMIS delivery | amber, clock icon |
| SENT | HMIS accepted the request | teal, arrow icon |
| HMIS-CONFIRMED | Read back from HMIS and matches | green, double-check icon |
| FAILED | Delivery failed or rejected | red, warning icon |

Analyzer link states use a separate vocabulary (CONNECTED, IDLE, RECEIVING,
SENDING, DISCONNECTED, LEASE CONFLICT) so they are never confused with result
states.

## W-1 Integration health

```
+------------------------------------------------------------------------------+
| LIMS Middleware   Health | Orders | Specimens | Analyzers | Review | Admin   |
|                                              jdoe (approver) · Africa/Nairobi|
+------------------------------------------------------------------------------+
| SYSTEM                                                                       |
| [● Web OK] [● Jobs OK] [● DB OK 12ms] [▲ Disk DB 68% free] [● HMIS OK 340ms] |
|                                                                              |
| ANALYZER LINKS                                                               |
| Instrument      Verification   Link          Last message     Today  Errors |
| e411-01         UNVERIFIED     ● IDLE        10:41:02 result  132    0      |
| mindray-01      UNVERIFIED     ✖ DISCONNECTED 09:58:10        57     3  [>] |
|                                                                              |
| QUEUES                     Pending   Oldest    Dead   Ambiguous             |
| Analyzer inbox                   0      —         0        —                |
| HMIS order inbox                 2    00:00:14    0        —                |
| HMIS result outbox              14    00:22:40 ▲  1        1  [View]        |
|                                                                              |
| NEEDS ATTENTION                                                              |
| ▲ 3 unmatched results (oldest 01:12)              [Open unmatched results]   |
| ▲ 1 critical result not acknowledged (00:07)      [Open]                     |
| ▲ 1 ambiguous HMIS delivery                       [Reconcile]                |
+------------------------------------------------------------------------------+
```

## W-2 Orders and sample registration

```
+------------------------------------------------------------------------------+
| Orders            [Scan / search: MRN, name, order, accession ______ ] [Go]  |
| Filter: (•) Awaiting collection ( ) Collected ( ) In lab ( ) All   [STAT ☐]  |
+------------------------------------------------------------------------------+
| Pri  HMIS order       Patient (MRN)            Tests          Ordered  Src   |
| STAT ORD-…0123        EXAMPLE, Test (MRN0001)  TSH FT4 | CBC  08:15    HMIS  |
|      ORD-…0124        SAMPLE, Ann (MRN0042)    CBC            08:20    HMIS  |
|      DT-000007        PROVISIONAL Smith J      TSH            08:31    DOWNTIME⚠|
+------------------------------------------------------------------------------+
| [+ Downtime registration]  (enabled only for operator+ ; banner when HMIS down)|
```

Order detail / collection:

```
+------------------------------------------------------------------------------+
| ORD-2026-000123   STAT   Patient EXAMPLE, Test  F  1980-01-31  MRN0001234    |
| Encounter ENC-889 OPD-3  Ordered 08:15 by Dr Example                         |
+------------------------------------------------------------------------------+
| Specimen 1: SERUM  (TSH, FT4)   Status: PENDING COLLECTION                   |
|   Collected at [08:40] by [jdoe]   [Collect & print label]                   |
| Specimen 2: EDTA WB (CBC)       Status: COLLECTED  L26110300043  [Reprint]   |
|   [Reject…] [Request recollection…]                                          |
+------------------------------------------------------------------------------+
| Label preview:  ||||| L26110300042 |||||  EXAMPLE T  F 1980-01-31  SERUM STAT|
+------------------------------------------------------------------------------+
```

Reprinting creates an audit event and shows the reprint count. Rejection
requires a coded reason and free text.

## W-3 Specimen tracking

```
+------------------------------------------------------------------------------+
| Specimen L26110300042  SERUM  STAT     Status: IN PROCESS                    |
+------------------------------------------------------------------------------+
| Timeline                                                                     |
| 08:15 Order received from HMIS (ORD-…0123)                                   |
| 08:40 Collected by jdoe · label printed (1)                                  |
| 09:02 Received in lab by mkim                                                |
| 09:05 e411-01 query → replied TSH, FT4 (reply 0.4 s)                          |
| 10:16 e411-01 result TSH 1.25 µIU/mL                    [raw msg 🔒]          |
| 10:30 e411-01 result FT4 (rerun, status C)              [raw msg 🔒]          |
+------------------------------------------------------------------------------+
```

`🔒` links require the `raw_message.read` permission and create an audit
event when opened.

## W-4 Analyzer connections

```
+------------------------------------------------------------------------------+
| e411-01  cobas e 411  SN —   SW —            Verification: UNVERIFIED  ⚠     |
| Adapter cobas-e411-astm@1.0.0 (cobas® type)   Transport tcp-client 10.20.5.11:4001|
| Link: ● IDLE   Lease: lims-srv01:4120 epoch 17   Since 07:12                 |
| Today: frames 1,284 · NAK sent 2 · checksum errors 2 · timeouts 0            |
| [Pause link] [Reconnect] [View trace (last 200 frames) 🔒] [Edit config…]    |
+------------------------------------------------------------------------------+
| Pending outbound: none (batch download disabled)                             |
+------------------------------------------------------------------------------+
```

The "UNVERIFIED" banner stays until an administrator records an interface
verification with the vendor report attached.

## W-5 Worklists and manual load lists

```
+------------------------------------------------------------------------------+
| Worklist: mindray-01   Mode: QUERY (demographics) + MANUAL TEST SELECTION    |
+------------------------------------------------------------------------------+
| ☐ Barcode        Patient            Tests       Pri   Received   Loaded     |
| ☑ L26110300043   EXAMPLE, Test      CBC          STAT  09:02      ✔ 09:10    |
| ☐ L26110300051   SAMPLE, Ann        CBC                09:15      —          |
+------------------------------------------------------------------------------+
| [Print load list] [Mark selected as loaded]                                  |
| Barcode reconciliation: 1 loaded > 60 min without result [View]              |
+------------------------------------------------------------------------------+
```

## W-6 Result review, approval and release

```
+------------------------------------------------------------------------------+
| Review queue   Instrument [All ▾]  Priority [All ▾]  Status [RECEIVED ▾]     |
+------------------------------------------------------------------------------+
| L26110300042  EXAMPLE, Test  F 46y   ORD-…0123   STAT                        |
| Test  Version  Value          Units    Ref        Flag  Instr flags  Status  |
| TSH   v1       1.25           µIU/mL   0.27-4.20  N     —            RECEIVED|
| FT4   v1       0.091 ⚠        ng/dL    0.93-1.70  L     48 Below     RECEIVED|
|       v2 rerun 1.52 (dil 2)   ng/dL    0.93-1.70  N     —            ← select|
|       Original text: "1.52^"  raw 🔒                                         |
| CBC   (13 params) [expand]    ⚠ WBC edited on instrument (OBX-13 E)          |
+------------------------------------------------------------------------------+
| Comment: [______________________]                                            |
| [Mark reviewed]   [Approve & release]  (approver; cannot be the reviewer if  |
|                                         two-person rule is on)               |
| Critical: none                                                               |
+------------------------------------------------------------------------------+
```

* A critical version shows a red banner with the time waiting and a
  "Record the call" form (person told, role and ward, minutes ago, read-back
  ticked). Approval is refused until it is saved (08 §12).
* Selecting a version is explicit; the default is the latest, but a newer
  version arriving after review resets the item to RECEIVED.
* Approve & release shows a confirmation listing exactly which values will
  be sent.
* Corrections open a form: new value or choose version, mandatory reason,
  approver signature (re-enter password or SSO step-up if available).

## W-7 Unmatched results

```
+------------------------------------------------------------------------------+
| Unmatched results (3)                                                        |
+------------------------------------------------------------------------------+
| Received  Instr     Sample ID   Reason            Tests        Action        |
| 09:44     e411-01   @412        READ ERROR        TSH          [Resolve…]    |
| 10:02     mindray-01 L2611039999 UNKNOWN BARCODE  CBC          [Resolve…]    |
| 10:20     e411-01   L26110300050 NOT ORDERED      PRL          [Resolve…]    |
+------------------------------------------------------------------------------+
Resolve: [Link to specimen (scan barcode)…] [Add test to order (reason)…]
         [Discard (reason)…]    · second-person check: required
```

As built: a link always needs two people, whatever their role (stricter than
the role table in [10](10-security-and-audit.md) §2, which lets an approver act
alone). It only goes to the same local test on the scanned specimen, never to
a different test, and an unmapped instrument code must be mapped first.

"Add test to order" (A-34) is offered only for a result that was not ordered on
a tube whose barcode the instrument read. It asks for that tube's accession
(filled in from the barcode, and refused for any other tube), the clinician
who asked for the test and how the request came. A second person confirms with
their password. The result page then says the result is held from the HMIS,
and the order page lists **Tests added by the lab**: who asked, who added and
confirmed it, and either "waiting for the HMIS line" or, once the clinician's
line has arrived, a choice of that line and a password to match it. The new
line is shown unticked under "To collect", with a note to match it instead of
collecting again.

## W-8 Failed transmissions

```
+------------------------------------------------------------------------------+
| HMIS delivery failures                                                       |
+------------------------------------------------------------------------------+
| Result        Topic        Attempts  Last error                Outcome       |
| TSH L…0042    submit       12        503 Service Unavailable    DEAD [Replay]|
| FT4 L…0042    correct      1         timeout after send         AMBIGUOUS    |
|                                                       [Check HMIS] [Mark…]   |
+------------------------------------------------------------------------------+
| [View attempts] shows each attempt: time, HTTP status, redacted excerpt      |
```

## W-9 Test mappings and configuration history

```
+------------------------------------------------------------------------------+
| e411-01 mappings   Active: v3 (approved by lab director 2026-10-30)          |
| [Create draft v4 from v3]                                                    |
+------------------------------------------------------------------------------+
| Local test  Instr code  Dir    Units      Decimals  Qual map   Reportable    |
| TSH         10          BOTH   µIU/mL     2         —          yes           |
| HIV-COMBI   400         BOTH   COI        —         -1/0/1     yes           |
+------------------------------------------------------------------------------+
| Diff v3 → v2 [view]   History: v1 2026-09-01 · v2 2026-10-02 · v3 2026-10-30 |
```

Draft → Approved (by a different user with `mapping.approve`) → Active
(scheduled time). Results record the mapping version used.

## W-11 Add or edit an instrument

```
+------------------------------------------------------------------------------+
| New instrument                                                 [Save draft]  |
+------------------------------------------------------------------------------+
| ID [chem-02    ]  Name [Chemistry 2        ]  Discipline [Chemistry   v]     |
| Manufacturer [         ]  Model [         ]  Serial [      ]  SW [     ]     |
| Location [Main lab, bench 3]  Interface manual [title, doc no., revision  ]  |
+------------------------------------------------------------------------------+
| Driver ( ) cobas-e411-astm ( ) cobas-c111-astm ( ) mindray-hl7-mllp          |
|        (•) Generic ASTM (results only)  ( ) Generic HL7/MLLP (results only)  |
|  Sample ID   record [O v] field [3 ] component [1 ]        (required)        |
|  Test code   R-3.4   Value R-4   Units R-5   Flags R-7   Status R-9 [edit]   |
|  Status map  F → final  [+ add]          QC rule  O-12 = Q  [edit]           |
|  ⚠ Generic profiles never answer host queries: use load lists (W-5).         |
+------------------------------------------------------------------------------+
| Transport (•) TCP client  host [10.20.5.20] port [4003]  ( ) Serial ( ) Listen|
+------------------------------------------------------------------------------+
| [Test parse: paste a captured message] → shows the normalised result         |
+------------------------------------------------------------------------------+
| Status: UNVERIFIED · Disabled · not for clinical use                         |
| [Record interface test…] [Record lab acceptance…] [Suspend…]                 |
+------------------------------------------------------------------------------+
```

Saving a change to identity, driver or profile shows "this resets the
instrument to UNVERIFIED" and asks for a reason. "Test parse" runs the
profile on a captured message (from the link trace) without storing
anything, so the administrator can check field positions before the
interface test.

## W-12 Turnaround times

**Reports → Turnaround** (A-22): a date range (days in the lab's time zone, A-24, both included, at
most 366) and a priority filter. One row for all tests and one per test.
Each step column shows the median and 90th percentile and how many results
had both times: ordered to collected, collected to received in the lab,
received to first value, first value to approved, approved to released,
released to accepted by the HMIS, and collected to accepted. Approvers and
auditors can download the per-result times as CSV, without patient names.
With targets set (**Turnaround → Targets**, approvers, step-up, audited) a
column shows how many met the receipt-to-release target and how many were
late; **Overdue results** lists unreleased results past target, and the
dashboard shows a warning while any are.

## W-13 Patient history

**Patients**: search by MRN (an exact MRN opens the patient) or by the start
of the family name, among patients the HMIS has sent orders for. The patient
page is a cumulative report: one row per test, one column per collection
time (newest first, the newest 12), each value linking to its result, with
abnormal, critical and delta flags; values not yet approved are in italics.
It holds results from this middleware only. A reconciled provisional record
points to the HMIS patient its results moved to. The result and order pages
link to it.

## W-14 Printed result report

**Order → Print result report**: an A4 page for the browser's print dialog,
headed by `LIMS_REPORT_HEADER` (11), with the patient, the order, the
specimens and one line per ordered test. Only approved results (by a person
or by autoverification) carry a value, with units, abnormal and critical
flags, "corrected" where it applies, the reference range text the
instrument sent with the value, or the lab's own range when one applies (A-25, marked "lab", with "below range" or "above range"),
and who approved it and when, with any report comments (A-26) under the line. Every other test prints as pending or
cancelled, never with a value. Each view is recorded in the audit trail
(`order.report-viewed`). For handing results out during HMIS downtime; the
HMIS record stays the official result once it has it.

## W-15 QC chart (Levey-Jennings)

**QC ranges → chart** (also linked from each control on the QC log): the
latest 60 numeric QC results for one range, oldest on the left, drawn as
inline SVG on the server (no script). The axis is in the control's units.
With a target mean and SD (A-23) it shows the mean and ±1, ±2, ±3 SD lines
over mean ± 4 SD, widened to include the acceptable range; without them,
only the range limits with a margin. Dots are coloured by outcome
(accepted, Westgard rejection, out of range); a value beyond the axis is a
triangle at the edge, never dropped. Each dot's tooltip and the table below
give the value, z score and rules broken. Results in other units are not
plotted. The x axis is result order, not time.

## W-16 Workload

**Reports → Workload** (linked from Turnaround times): what the instruments
measured over a date range (days in the lab's time zone, A-24, at most 366), by instrument, by test
(with a column per instrument) and by day. A measurement is an instrument
value stored on a patient result, counted on the day its message arrived;
values typed or corrected by a person are not counted. A repeat is any
measurement after the first on the same result. QC counts the QC log;
quarantined counts patient values that arrived with no matching order and is
shown beside the total, not added to it, because some are attached later
and then counted as measurements. Counts only, no patient data. The CSV
(day, instrument, test, measurements, repeats) is limited to approvers and
auditors and each export is audited (`report.workload-export`).

## W-17 Reference ranges

**Results → Reference ranges** (also linked from Critical limits): the
lab's ranges per test, for everyone or one sex, for all ages or an age band,
inclusive, in exact units, with the source document. Approvers add and
retire them (password confirmation, audited); none are shipped. The result
page shows the range for its patient above the versions, and each version
whose value is below or above it gets a badge; without a lab range it shows
the text the instrument sent, if any. The printed report (W-14) does the
same and names the source.

## W-18 Result comments

**Result → Comments**: every comment on the result, oldest first, marked
"lab only" or "on the report", with who added it and when. Technologists and
approvers add comments; only an approver can tick "Print it on the result
report" or withdraw such a comment. Withdrawing needs a reason; the comment
stays, struck through, with who withdrew it and why.

## W-19 Standard comments

**Results → Standard comments** (also linked from a result's Comments): the
lab's active standard comments by code, with their text, the test they are
offered on (or every test), and who added them. Approvers add one with
their password, and retire one with a reason and their password; retired
comments are listed below with who retired them and why. On a result page
the comment form gains a "Standard comment" list of the active ones for that
test, beside the free-text box; staff pick one or type, not both.

## W-20 QC summary

**QC → QC summary**: one row per QC range that had results in the period
(from and to dates, default the current month so far): instrument, test,
control, the range and target, then n, observed mean, SD, CV %, lowest and
highest value, bias % and shift in SD against the target, and the counts of
rejected, warning and not-compared results, with a link to the range's
Levey-Jennings chart (W-15). A retired range is marked. Approvers and
auditors can download the same as CSV; each download is audited as
`report.qc-summary-export`.

## W-21 HMIS link

**HMIS link** (top menu; any signed-in user; refreshes every minute): how
the jobs worker's link to the HMIS is going (07 §6.6).

* **Order feed**: the connector, the last poll and whether it worked (or
  how many times in a row it failed), the last poll that worked and how many
  orders it brought, when the feed position last moved, and the last error
  with its time. With no poll recorded the page says the link is not
  configured.
* **Results on their way**: released results not yet delivered, oldest
  first, with their submission key (linked to the result), state (waiting
  for a first try, being sent, will try again), tries, next try and last
  error, and how many were given up on (linked to Failed deliveries).
* **Latest delivery attempts**: the last 20, with outcome and detail.

The dashboard shows an HMIS warning, linking here, when the last three or
more polls failed, when no poll was attempted for two hours, or when a
released result has waited more than 15 minutes.

## W-22 Test catalogue

**Catalogue** (top menu; any signed-in user can read it; administrators and
approvers change it): the lab's own tests (A-31).

* **Waiting for approval**: drafts with code, version, test, LOINC code,
  result type and answers, why, and who proposed them. Another administrator
  or approver approves (password or hospital sign-in again) or discards with
  a reason; the proposer sees "Another person approves this."
* **Tests in use**: the active version of each test, with bench, LOINC code
  and name, SHA code if any, result type with unit or answers (abnormal
  answers marked *), specimen, and who approved it. "Change" fills the form
  from the active version; "Retire" takes a reason and the password.
* **Add a test / Change**: local code, name, bench, specimen, LOINC code
  (check digit checked) and name, SHA code, performed by (a person or an
  instrument), result type, unit (UCUM) and decimals for numbers, answers one
  per line as `code | words`, then `| abnormal` and a LOINC answer code if
  any, and why. Saving makes a draft. A panel lists its component tests'
  local codes, one per line, in report order (A-32). A test read by a person
  also says what QC entering a result needs (no check, warn or block) and how
  many hours a passing control counts, empty for the whole lot (A-33).

## W-23 Manual worksheet

**Worksheet** (top menu; technologists and approvers enter results): received
specimens waiting for a test performed by a person, STAT first, then oldest
first, filtered by bench (A-31).

* Each row shows the test, its code and LOINC code, the accession, the
  patient, STAT, the ward and when the specimen was received.
* The result field is a list of the catalogue's answers (abnormal ones
  marked), a number box with the unit, or a text box. Nothing is chosen in
  advance. "Performed by" defaults to the person entering, and the kit or
  strip lot is optional.
* A panel order line is one card with a field per component waiting for a
  person. Fields left empty stay on the worksheet; every filled field is
  checked first and one bad value saves none of them (A-32).
* A refused value stays on the row with the reason. A saved result leaves
  the worksheet and waits on the results list for review; its result page
  says who performed it, the lot and who entered it, and shows each answer's
  words next to its code.
* A card for a test that needs QC lists the lots with a passing control now
  and links to the manual QC page. With block, the lot is required and a
  result on a lot without passing QC is refused with the reason; with warn,
  it is saved and its result page says "QC missing for the lot" (A-33).

## W-24 Manual QC

**Manual QC** (from the worksheet; technologists and approvers record):

* **Lots that may be used now**: each test with a QC rule, the rule and window,
  and the lots whose controls all passed, or "no lot has a passing control".
* **Record a control**: pick the test, then the lot and its expiry date, the
  control's name, what it should read and what it read (lists of the test's
  answers for a choice test, where the outcome follows; otherwise text and a
  pass or fail), who ran it and a comment. A failed control is recorded too.
* **Recent controls**: when, test, lot and expiry, control, readings,
  pass or fail, and who ran it. Records are never changed; a mistake is
  corrected by running the control again.

## W-10 Audit search and export

```
+------------------------------------------------------------------------------+
| Audit   Entity [Result ▾] ID [_____]  Actor [_____]  Action [All ▾]          |
| From [2026-11-01] To [2026-11-03]                      [Search] [Export…]    |
+------------------------------------------------------------------------------+
| Time      Actor   Action           Entity          Reason      Corr. ID      |
| 10:40:00  jdoe    result.approve   result 6f1c…    —           9a2e…         |
| 10:40:00  system  outbox.enqueue   outbox 77b0…    —           9a2e…         |
| 10:41:12  system  hmis.delivered   outbox 77b0…    —           9a2e…         |
+------------------------------------------------------------------------------+
| Chain verification: last run 02:00 ✔ (seq 1 – 482,117)                       |
```

Export produces a signed bundle (JSON lines + hash manifest), see
[10](10-security-and-audit.md) §8. As built: event lines, then the
manifest, then an Ed25519 signature line when a signing key is set (A-16).
The page says whether exports are signed and with which key, and offers the
public key (`/audit/signing-key.pem`); with a key that cannot be used it
says so and refuses to export. `lims audit verify-export` checks a file on
its own.
