# 12. Validation Plan and Measurable Acceptance Criteria

## 1. Levels

| Level | What | Environment | Who |
|---|---|---|---|
| Unit | Codecs, parsers, value parsing, state machines, matching, retry maths | CI, no I/O | Developers |
| Contract | Adapter fixtures built from vendor-document examples; HMIS schemas against vendor samples | CI | Developers |
| Integration | Real PostgreSQL (CI service), transports over loopback TCP and virtual serial pairs (`socat` on Linux, com0com on Windows) | CI + Windows runner | Developers |
| Simulator system tests | Full processes + instrument simulators + HMIS simulator | Staging VM | Developers, QA |
| Installation qualification (IQ) | Offline install on a clean target server | Hospital test VM | Vendor + hospital IT |
| Interface verification | Each installed instrument, with the vendor's engineer | Lab, non-clinical samples/QC | Vendor FSE + lab + integrator |
| Operational / performance qualification (OQ/PQ) | End-to-end with synthetic patients, then parallel run | Lab | Lab QA |
| Laboratory acceptance | Sign-off against §5 | Lab | Lab director |

No clinical use until interface verification **and** laboratory acceptance
are signed. Until then the instrument's `verificationStatus` stays
`UNVERIFIED` and the UI shows the banner.

## 2. Simulators

* **ASTM simulator** (`packages/simulators/astm`): plays the analyzer or host
  side of E1381 with scriptable faults: split frames at every byte boundary,
  coalesced frames, wrong checksum, wrong FN, missing ACK, NAK storms, ENQ
  contention, EOT mid-message, 16 s silence, garbage between frames, 7-bit
  framing. Message content from fixtures derived from the e 411 manual
  examples [DOC e411 HIM F-2 to F-9].
* **HL7/MLLP simulator**: sends ORU/ORM with partial blocks, two blocks in one
  write, missing `0x1C 0x0D`, oversized block, invalid UTF-8, missing MSH-10,
  slow-loris byte-by-byte sends.
* **HMIS simulator**: configurable latency, 429/5xx, timeouts after
  receiving the body, lost responses (commit then drop connection),
  duplicate webhooks, out-of-order events, pagination edge cases.
* **Fixtures are synthetic**. No real patient data in the repository.

## 3. Test catalogue (must pass)

| ID | Area | Test |
|---|---|---|
| T-01 | Framing | Valid single and multi-frame ASTM messages (ETB/ETX), FN wrap 7→0 |
| T-02 | Framing | Every possible split point of a message across TCP reads produces the same parsed result |
| T-03 | Framing | Two frames + control chars in one read |
| T-04 | Framing | Bad checksum → NAK; resend accepted; duplicate FN not double-appended |
| T-05 | Framing | Oversized frame/block → bounded memory, NAK/close, incident logged |
| T-06 | Link | Missing ACK from host side → simulator retries per doc; our sender times out at 15 s, max 6 retries |
| T-07 | Link | Contention: middleware yields to analyzer [DOC e411 HIM D-6] |
| T-08 | Link | Reconnect after device server restart; lease kept; no duplicate session |
| T-09 | Link | Second worker for same instrument refuses to start; stale-epoch insert rejected |
| T-10 | Query | e 411 query answered < 2 s at p99 under load; echo of seq/carrier/position correct; "no order" reply correct for both dialects |
| T-11 | Query | Query cancel after deadline handled |
| T-12 | Results | Qualitative (`-1^0.303`), censored (`<0.01`, `>1000`), absent (7 spaces), masked (`***.*`), flagged (L/H/LL/HH, `H~A`), alarm comments |
| T-13 | Results | Rerun (`C`) and dilution create new versions; byte-identical resend does not |
| T-14 | Results | Mindray edited flags (`E`/`e`) shown and block autoverification |
| T-15 | Matching | Unknown barcode, read-error placeholder, unmapped test, not-ordered test, cancelled test, rejected specimen → quarantine with correct reason |
| T-16 | Matching | QC message never creates a patient result |
| T-17 | Mapping | Mapping change does not alter already-stored results; results record mapping version |
| T-18 | HMIS | Duplicate webhook → single order; poll overlap → no duplicates |
| T-19 | HMIS | 429/503 retried with backoff and jitter; `Retry-After` honoured |
| T-20 | HMIS | Lost response after commit → no duplicate in HMIS simulator (key honoured) or reconciliation case created (key not honoured) |
| T-21 | Crash | Kill analyzer worker between persist and ACK, and between ACK and next frame: no loss of ACKed data; no duplicate results |
| T-22 | Crash | Kill jobs worker mid-handler and mid-HTTP call: lease expiry → recovery; outcome correct |
| T-23 | Crash | Kill PostgreSQL during receipt: no ACK sent for unpersisted data |
| T-24 | Concurrency | Two jobs workers, 10,000 queued messages: each processed once, no deadlocks |
| T-25 | Release | Attempt release without approval via API and via direct SQL as `lims_app`: blocked |
| T-26 | Audit | Every action in [10](10-security-and-audit.md) §8.1 produces an event with actor, reason, correlation ID; chain verifies; tampering detected |
| T-27 | Performance | At 3× expected peak (A-7), event-loop delay p99 < 50 ms in analyzer workers; query reply p99 < 2 s |
| T-28 | Install | Offline install on a clean VM with no internet: completes, `lims verify` passes, no outbound connection attempts (checked with firewall logs) |
| T-29 | Backup | Restore to clean VM; audit chain verifies; counts match |
| T-31 | c 111 | Query reply < 3 s at p99; record-per-frame outbound framing; H-5 SW/serial captured and alert on change; `R-9 = R` re-transmission creates no new version; `X` quarantined; M.CR/M.RR never reach patient results; RSREQ recovery retrieves results after a simulated lost transfer; XON/XOFF bytes outside frames tolerated |
| T-30 | Security | CSRF, session fixation, XSS in all free-text fields, role bypass attempts, raw message access audited |

## 4. Interface verification protocol (per instrument, with vendor)

1. Record instrument model, serial, software version, interface settings
   (screenshots), cable/device server model and settings, adapter version,
   mapping set version.
2. Link tests: establish, idle 1 h, unplug/replug, device server restart,
   middleware worker restart, DB restart.
3. Query tests (if supported): known barcode, unknown barcode, STAT,
   multiple tests, reply after deadline.
4. Result tests using QC material and non-clinical samples: every mapped
   test at least once; a value below and above the measuring range; a
   qualitative test; a rerun; a dilution; a result with an instrument alarm.
5. QC tests: each QC level; confirm QC never appears as a patient result.
6. Re-send from analyzer (batch) and confirm no duplicate versions.
7. Compare every value, unit, flag, and timestamp with the instrument
   printout/screen. 100 % agreement required.
8. Vendor engineer signs the record. Status → `VENDOR_TESTED`.

## 5. Acceptance criteria (measurable)

| # | Criterion | Measure | Pass |
|---|---|---|---|
| AC-1 | Correct patient, encounter, specimen, and test matching | Parallel run of ≥ 200 samples per instrument (or 2 weeks, whichever is larger) comparing middleware results with the instrument printout and the manual HMIS entry | 100 % of matched results correct; 0 wrong-patient or wrong-test matches; every non-match quarantined |
| AC-2 | Acknowledged messages survive restart | T-21 to T-23 repeated 50 times each with random kill points | 0 lost ACKed messages |
| AC-3 | No duplicate clinical results from retries | T-13, T-20, T-21, T-24 and the parallel run | 0 duplicate result versions; 0 duplicate HMIS results |
| AC-4 | No release of unapproved results | T-25 + audit query over the parallel run: every release has a prior approval by an approver | 100 % |
| AC-5 | End-to-end traceability | For 20 randomly chosen released results, an auditor traces raw message → normalised observation → result version → review → approval → release → delivery attempts → HMIS confirmation using only the UI and audit export | 20/20 complete |
| AC-6 | Responsiveness | T-10, T-27 | thresholds met |
| AC-7 | Offline install | T-28 on a clean target | pass |
| AC-8 | Backup restore | T-29 | pass, with documented RTO ≤ 4 h and RPO ≤ 15 min (to be agreed with hospital IT) |
| AC-9 | Audit integrity | T-26 + nightly verification for the parallel-run period | 0 unexplained failures |
| AC-10 | Downtime | Simulated 4 h HMIS outage during the parallel run | All approved results delivered after recovery; downtime orders reconciled; no duplicates |

## 6. Documentation for the validation file

* Vendor manuals (by checksum), interface verification records, settings
  screenshots.
* Requirements → test traceability matrix (this document's IDs).
* Test evidence (CI reports, simulator logs, parallel-run spreadsheets).
* Installation verification outputs.
* Risk assessment (e.g. ISO 14971-style hazard list for wrong-patient,
  wrong-value, lost-result, delayed-critical-result).
* Sign-offs: integrator, vendor FSE, hospital IT, lab director.
