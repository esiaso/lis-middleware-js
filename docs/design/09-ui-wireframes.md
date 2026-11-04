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
[10](10-security-and-audit.md) §8. As built: the manifest is there, the
signature is not yet (A-16).
