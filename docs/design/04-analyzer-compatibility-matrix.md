# 04. Analyzer Compatibility Matrix

**No instrument in this document is verified.** "[DOC]" means a vendor
document we hold says so. It becomes "[VERIFIED-ONSITE]" only after the
installed instrument passes the interface tests in
[12](12-validation-and-acceptance.md) with the vendor's engineer present.

Document abbreviations:

* **e411 HIM**: Roche cobas e 411 Host Interface Manual v2.2, Nov 2013 (page references like B-2, E-15).
* **c111 HIM**: Roche cobas c 111 Host Interface Manual v2.2, June 2021, SW ≥ 3.0 (section references).
* **Mindray HL7**: Mindray "3107 HL7 Communication Protocol", Z-110-002557-002-2.0 (section references).

## 1. Summary

| Instrument | Discipline | Interface (per doc) | Transport | Orders to analyzer | Results from analyzer | Status |
|---|---|---|---|---|---|---|
| Roche cobas e 411 | Immunoassay | ASTM E1381-91 / E1394-91, two record dialects: "Elecsys® type" and "cobas® type" [DOC e411 HIM A-2] | RS-232C, half duplex, one port [DOC e411 HIM B-2] | **Yes**: real-time inquiry (query) and batch download [DOC e411 HIM C-2] | Yes: real-time and batch [DOC e411 HIM C-2] | Documented, **unverified**. Installed SW version unknown (B-1). |
| Mindray, model TBC (file name says BC-5000 / BC-5150) | Haematology | HL7 v2.3.1 over MLLP [DOC Mindray §1, 4.3.1] | "TCP interface communication/port communication" [DOC Mindray §1]. Listener side and port **not stated**. | **Query only**: analyzer sends ORM^O01 per sample, LIS answers ORR^O02 [DOC Mindray 4.1.2, 5.5]. No unsolicited download described. | Yes: ORU^R01, LIS answers ACK^R01 [DOC Mindray 4.1.1, 5.2] | Document applicability **unconfirmed** (B-3). Transport details unknown (B-4). |
| Roche cobas c 111 | Clinical chemistry | ASTM E1381-97 / E1394-97 [DOC c111 HIM 7.1.1] | RS-232 [DOC c111 HIM 5.2, 6.3] | Yes: query and batch download [DOC c111 HIM 6.1] | Yes [DOC c111 HIM 6.4] | **Not in requested scope.** Manual received; confirm whether installed (D-12). |

## 2. Roche cobas e 411

### 2.1 Physical and link layer

| Item | Value | Source | Status |
|---|---|---|---|
| Connector | D-SUB 9 "HOST", left side of analyzer | e411 HIM B-7, Fig. B-1 | [DOC] |
| Wiring | 3-wire: analyzer RXD pin 2, TXD pin 3, SG pin 5; pins 7 and 8 bridged on analyzer side | e411 HIM B-7, Fig. B-2 | [DOC] |
| Max cable length | 15 m | e411 HIM B-2 | [DOC] |
| Speed | 19200 / 9600 / 4800 bps; recommended 9600 | e411 HIM B-2 | [DOC] |
| Character format | 8 options from 7E2 to 8O1; recommended 8N1 | e411 HIM B-2, Table B-2 | [DOC] |
| Duplex | Half duplex | e411 HIM B-2 | [DOC] |
| Flow control | Not stated. Wiring has no RTS/CTS to the host. | e411 HIM B-7 | Assume none; [UNVERIFIED] |
| Character encoding | ASCII. Alarm messages "do not correspond to UTF-8". | e411 HIM D-3, E-18 | Decode as `latin1` (lossless byte-to-char), keep raw bytes |
| Trace file on analyzer | `d:\e411\data\log\host_trace.log` (send to technical support) | e411 HIM A-2 | [DOC] |

### 2.2 ASTM low level (E1381)

| Item | Value | Source |
|---|---|---|
| Frame | `STX FN text ETB|ETX C1 C2 CR LF`; text ≤ 240 bytes; frame ≤ 247 bytes | e411 HIM D-3 |
| Frame number | Starts at 1, runs 1 to 7 then 0 to 7 (mod 8) | e411 HIM D-3 note 1 |
| Checksum | Sum of bytes from FN through ETB/ETX inclusive, last two hex digits, uppercase ASCII `0-9A-F` | e411 HIM D-3 note 4, D-4 worked example |
| Forbidden in text | SOH, STX, ETX, EOT, ENQ, ACK, LF, DLE, DC1–DC4, NAK, SYN, ETB | e411 HIM D-3 note 2 |
| Elecsys® type | One record per frame at most; record > 240 bytes split ETB/ETX | e411 HIM D-2 |
| cobas® type | A frame may contain several records | e411 HIM D-2 |
| Establishment | Sender sends ENQ; receiver replies ACK. NAK = busy: analyzer waits 10 s and retries, up to 6 retries. | e411 HIM D-5, D-6 |
| Contention | Both send ENQ: **analyzer has priority**. Host must stop sending ENQ and reply ACK or NAK. Analyzer waits 1 s and re-sends ENQ. | e411 HIM D-6 |
| No response | Sender sends EOT after 15 s and shows an error | e411 HIM D-6 |
| Transfer, host receiving | Host must ACK each good frame. Non-ACK: analyzer resends the frame, up to 6 times, then EOT. No response: EOT after 15 s. | e411 HIM D-8 |
| Transfer, host sending | Analyzer checks FN and checksum, replies ACK or NAK. Incomplete frame with no EOT for 15 s: analyzer discards the incomplete message. | e411 HIM D-8 |
| Termination | Sender sends EOT; no reply. | e411 HIM D-10 |
| Automatic recovery of session | Optional setting (cobas® type): automatic reconnection after an E1381 error; the erroneous message and host messages sent before reconnection completes are **rejected** | e411 HIM B-6 |

**Design consequence.** The host has 15 s to ACK each frame. The adapter
persists each received frame (or at least each completed message) to
PostgreSQL **before** sending the ACK that commits it; a database round trip
is milliseconds. If the database is unavailable, the adapter does **not**
ACK. The analyzer will retry up to 6 times and then show an error; the lab
then re-sends results from the analyzer's Data Review screen in batch
[DOC e411 HIM C-2]. That is safer than acknowledging data we have not stored.

### 2.3 Messages and flows

| Text | Direction | Elecsys® real/batch | cobas® real/batch | Source |
|---|---|---|---|---|
| Inquiry for order | e 411 → host | Yes / No | Yes / No | e411 HIM C-2, Table C-1 |
| Order for test request | host → e 411 | Yes / Yes | Yes / Yes | ″ |
| Result report | e 411 → host | Yes / Yes | Yes / Yes | ″ |
| Inquiry of result | host → e 411 | No / No | No / No | ″ |

Other documented facts:

* Header comment field identifies the message: `TSREQ^REAL` (query),
  `TSDWN^REPLY` / `TSDWN^BATCH` (orders), `RSUPL^REAL` / `RSUPL^BATCH`
  (results). cobas® type sender is `cobas-e411^1`, receiver `host`
  [DOC e411 HIM E-6].
* Patient **and QC** results are sent; **calibration results are not**
  [DOC e411 HIM C-2].
* No query is sent for control samples [DOC e411 HIM C-2].
* **No auto-rerun**; reruns are defined manually [DOC e411 HIM C-2].
* If the host does not answer a query within **15 s**, the analyzer sends a
  cancel (`Q` record with status `A`) [DOC e411 HIM F-2, F-3]. Rack-type
  communication that does not complete in **about 40 s** is cancelled
  [DOC e411 HIM F-5].
* The host must echo SequenceNo, CarrierNo and Position unchanged in the
  reply [DOC e411 HIM F-2].
* "No order" reply: Elecsys® type uses report type `Z`; cobas® type returns an
  O record with an empty test field [DOC e411 HIM F-2, F-3].
* Batch download stores up to **2000 tests**; when full, **older tests are
  overwritten** [DOC e411 HIM F-9]. This is why A-3 prefers real-time query.
* Up to 60 orders per O record, but only up to 18 for test selection
  [DOC e411 HIM E-12].
* Sending the same test twice in one sample record is not allowed (valid from
  SW 02-04) [DOC e411 HIM E-13 note 6, revision history].
* Barcode read error: sample ID is generated as `@<sequence no.>`. On a rack
  system with a generated rack number, the host **cannot identify** the
  sample [DOC e411 HIM E-2, E-9].
* Sample ID: string, max 22 [DOC e411 HIM E-8, E-11].
* Host test codes must be configured in the Host Test Code table for every
  test, including new applications; "mandatory … to upload results"
  [DOC e411 HIM B-5, B-6].
* Application codes carry a "generation" digit; cobas® type can map one host
  code to several generations, and the analyzer may run a different
  generation than ordered [DOC e411 HIM E-13].
* STAT result upload "By Sample" or "By Test" (by test sends each result as
  soon as available) [DOC e411 HIM B-6]. The adapter must therefore accept
  several result messages for one sample.
* "Send result only" mode disables inquiries (not applied to batch)
  [DOC e411 HIM B-6].
* QC: control name (or name and lot) is sent as the sample ID; cobas® sample
  type `QC`, Elecsys® `CONTROL`; action code `Q` / `X\Q` [DOC e411 HIM E-11,
  E-12, F-8].

### 2.4 Result record content (cobas® type)

| Field | Meaning | Source |
|---|---|---|
| R-3 Universal Test ID | `^^^<host test code>/<dilution>/<pre-dilution>`; dilution 1, 2, 5, 10, 20, 50, 100; pre-dilution `not` / `pre-diluted` | e411 HIM E-15 |
| R-4 Value | Quantitative: `<value>^<message value>`. Qualitative: `<qualitative>^<cut-off index>` where qualitative is `1` positive, `0` borderline, `-1` negative. `<` or `>` prefix on measuring-range error. **Seven spaces** if no result. | e411 HIM E-16 |
| R-5 Units | Free text, e.g. `ulU/ml`, `COI` (as sent; spelling preserved) | e411 HIM E-16, F-6 |
| R-6 Reference range | `<low>^<high>`; QC range for controls. Empty in the cobas® examples. | e411 HIM E-16, F-6 |
| R-7 Abnormal flag | `L`, `H`, `LL`, `HH`, `N`, `A` (Elecsys® uses `<` `>` instead of LL/HH) | e411 HIM E-16 |
| R-9 Result status | `F` initial result, `C` rerun result | e411 HIM E-16 |
| R-11 Operator | Operator ID; host cannot set | e411 HIM E-16 |
| R-14 Instrument ID | `E1` in examples | e411 HIM E-16, F-6 |
| C record after R | `C|1|I|<alarm no>|I`; absent when no data alarm. Alarm numbers listed in Table E-5. | e411 HIM E-18, E-19 |
| Review by exception | cobas® type does not transmit tests that have an exception alarm unless "with Review by Exception Results" is chosen for batch send | e411 HIM E-17 |

### 2.5 Open items specific to e 411

* Software version and whether this manual matches it (B-1).
* Current configuration screen values (B-2).
* Disk or rack version (D-10).
* Whether the analyzer accepts a TCP-bridged serial link without timing
  issues **[UNVERIFIED]**.
* Behaviour on receiving a reply after it has already sent a cancel
  **[UNVERIFIED]**.
* Maximum number of samples per batch message **[UNVERIFIED]**.

## 3. Mindray (model to be confirmed)

### 3.1 Transport and framing

| Item | Value | Source | Status |
|---|---|---|---|
| Framing | MLLP: `0x0B` + data + `0x1C 0x0D` | Mindray §1 | [DOC] |
| Encoding | UTF-8; MSH-18 = `UNICODE` | Mindray §1, 4.3.1 | [DOC] |
| HL7 version | 2.3.1 | Mindray 4.3.1 | [DOC] |
| Transport | "TCP interface communication / port communication" | Mindray §1 | Physical medium, listener side, and port **[UNVERIFIED]** (B-4) |
| Sender | "The PC connecting the analyzer" sends results | Mindray 4.1.1 | Whether that is an embedded PC or a separate workstation: **[UNVERIFIED]** (D-14) |
| Timeouts, retransmission, keep-alive | Not stated | — | **[UNVERIFIED]** |

### 3.2 Messages

| Flow | Messages | Source |
|---|---|---|
| Results and QC | Analyzer sends `ORU^R01`; LIS replies `ACK^R01` with `MSA-1 = AA` and `MSA-2` = received `MSH-10`. QC messages carry `MSH-11 = Q` and the reply echoes `Q`. | Mindray 4.1.1, 4.2.1, 5.2–5.4 |
| Worklist query | Analyzer sends `ORM^O01` with `ORC-1 = RF`, `ORC-3` = sample ID, `ORC-5 = IP`. LIS replies `ORR^O02` with MSH, MSA, and on a hit PID, PV1, ORC (`ORC-1 = AF`, `ORC-2` = sample ID), OBR (`OBR-2` must equal `ORC-2` or the message is "regarded as incorrect"), and OBX for mode data. | Mindray 4.1.2, 4.2.3–4.2.4, 4.3.7, 5.5 |
| Error codes | MSA-1 `AA`/`AE`/`AR`; MSA-6 codes 0, 100–103, 200–207 | Mindray 4.3.2 |

### 3.3 Result content

| Item | Value | Source |
|---|---|---|
| Sample ID | OBR-3 (Filler Order Number) in result messages; QC file number in QC messages | Mindray 4.3.5 |
| Patient ID | PID-3 `id^^^^MR`; lot number in QC messages | Mindray 4.3.3 |
| Result type | OBR-4 `00001^Automated Count^99MRC` (sample) or `00003^LJ QCR^99MRC` (L-J QC) | Mindray 5.7 |
| Parameter identity | OBX-3 `ID^Name^EncodeSys`; ID and EncodeSys identify the parameter, Name is descriptive. LOINC (`LN`) or Mindray (`99MRC`) codes. | Mindray 4.3.6, 5.8 |
| Value | OBX-5; types `NM`, `ST`, `IS`, `ED` (Base64 histograms / BMP) | Mindray 4.3.6, 6.2 |
| Units | OBX-6, e.g. `10*9/L`, `g/L`, `fL` | Mindray 5.9 |
| Reference range | OBX-7: `low-high`, `<upper`, or `>lower` | Mindray 4.3.6 |
| Abnormal flags | OBX-8: `N`, `A`, `H`, `L`; may combine with `~` (e.g. `H~A`) | Mindray 4.3.6 |
| Result status | OBX-11 `F` | Mindray 4.3.6 |
| Edit flags | OBX-13: `O` reagent expired, `E` result edited, `e` result changed because a source parameter was edited | Mindray 4.3.6 |
| Recheck flag | OBX-3 `01006^Recheck flag^99MRC`, value `T`/`F` | Mindray 5.8 |
| Morphology flags | `12011` WBC abnormal, `34165-1` immature granulocytes?, etc., `IS` `T`/`F` | Mindray 5.8 |
| RUO parameters | `*ALY#`, `*ALY%`, `*LIC#`, `*LIC%` are marked "RUO" | Mindray 5.8 |

### 3.4 Concerns about the Mindray document

These need Mindray's written answer before the adapter is trusted (B-3):

1. **Model applicability.** The body never names BC-5000 or BC-5150; only the
   file name does. The title refers to "3107".
2. **Possible veterinary template.** PID-5 is described as
   `AnimalName^OwnerName` and OBR-10 as "Veterinarian" [Mindray 4.3.3, 4.3.5].
3. **Generic parameter list.** The list includes 3-part-diff fields (MID,
   GRAN) and 3-diff blood modes alongside 5-part fields, so not every code
   applies to a given model [Mindray 5.8, §6].
4. **Example errors.** The sample message gives MCV with unit `%`
   [Mindray 5.1], and section 4.2.4 is headed "ORM^O02" while describing
   ORR^O02. Examples must not be used as the source of mapping truth.
5. **Silent on failure behaviour**: no statement of what the analyzer does
   with `AE`/`AR`, a missing ACK, or an empty worklist reply.
6. **Confidentiality.** The document is marked "Security Classification:
   Secret". Confirm with Mindray that the hospital and its integrator may use
   it, and keep it out of source control.

### 3.5 Test selection via worklist

The ORR example carries `Blood Mode`, `Test Mode` (`CBC` or `CBC+5DIFF`),
`Age`, and `Remark` as OBX segments [DOC Mindray 5.5, §6]. Whether the
analyzer actually applies a test mode from the worklist reply, or only uses
the demographics, is **[UNVERIFIED]** (B-5). Until confirmed, the design
treats the Mindray as a **query-for-demographics** instrument; the full CBC
panel ordered in the middleware is matched to whatever parameters arrive.

## 4. Roche cobas c 111 (not in scope until confirmed)

Recorded so the information is not lost if D-12 confirms an installed unit.

* RS-232, speeds 1200 to 115200 bps (default 9600), handshake none / RTS-CTS
  / XON-XOFF (default **XON/XOFF**), line modes 7/8 bit, parity, stop bits
  (default N81), 15 m max [DOC c111 HIM 5.2, 6.3].
* Real-time and batch; query once or always (always is used to pick up rerun
  orders); query timeout 10 to 300 s, default 10 s [DOC c111 HIM 5.1].
* **Host can request results** (`RSREQ`) [DOC c111 HIM 6.4.1], unlike e 411.
* Calibration and raw absorbance data can be sent (M-CR, M-RR records)
  [DOC c111 HIM 6.4].
* If the host does not confirm a communication in time, **unconfirmed
  records are not re-sent**; after 3 failed attempts on content errors the
  block is aborted and results must be re-sent manually [DOC c111 HIM 6.5].
* Sample ID up to 23 printable ASCII characters [DOC c111 HIM 6.2.1].
* Database holds max 300 samples; downloads beyond that are not stored
  [DOC c111 HIM 6.1.2.2].

## 5. Capability-driven workflow per instrument

| Capability | e 411 (doc) | Mindray (doc) | Middleware behaviour |
|---|---|---|---|
| Host query for orders | Yes | Yes (ORM/ORR) | Answer from local DB within the instrument timeout |
| Unsolicited order download | Yes (batch, max 2000 tests, overwrite risk) | Not described | e 411: optional, off by default. Mindray: not used. |
| Results upload | Yes | Yes | Persist raw, then ACK |
| Host requests results | No | Not described | Operator re-sends from analyzer; UI shows the analyzer-side procedure |
| QC upload | Yes | Yes (`MSH-11 = Q`) | Routed to the QC store, never to patient results |
| Calibration upload | No | Not described | n/a |
| Rerun indication | `R-9 = C` | Recheck flag `01006` | New result version marked as repeat |
| Operator-edited result | Not described | OBX-13 `E` / `e` | Highlighted in review; cannot be autoverified |

When an instrument cannot receive orders (query disabled, licence missing, or
link down), the lab uses the **manual loading workflow**: the middleware
prints a load list per instrument (accession, barcode, tests, priority); the
operator programs tests on the analyzer; results are matched by barcode on
arrival. See [06](06-database-and-state-machines.md) §5 and
[09](09-ui-wireframes.md) screen W-5.
