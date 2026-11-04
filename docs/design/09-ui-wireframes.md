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
