# 04. Analyzer Compatibility Matrix

**No instrument in this document is verified.** "[DOC]" means a vendor
document we hold says so. It becomes "[VERIFIED-ONSITE]" only after the
installed instrument passes the interface tests in
[12](12-validation-and-acceptance.md) with the vendor's engineer present.

Document abbreviations:

* **e411 HIM**: Roche cobas e 411 Host Interface Manual v2.2, Nov 2013 (page references like B-2, E-15).
* **c111 HIM**: Roche cobas c 111 Host Interface Manual v2.2, June 2021, SW ≥ 3.0 (section references).

Other instruments in the lab have not been listed yet (D-26). Each one gets
its own row here, from its own vendor manual, before any adapter work.
* **Mindray HL7**: Mindray "3107 HL7 Communication Protocol", Z-110-002557-002-2.0 (section references).

## 1. Summary

| Instrument | Discipline | Interface (per doc) | Transport | Orders to analyzer | Results from analyzer | Status |
|---|---|---|---|---|---|---|
| Roche cobas e 411 | Immunoassay | ASTM E1381-91 / E1394-91, two record dialects: "Elecsys® type" and "cobas® type" [DOC e411 HIM A-2] | RS-232C, half duplex, one port [DOC e411 HIM B-2] | **Yes**: real-time inquiry (query) and batch download [DOC e411 HIM C-2] | Yes: real-time and batch [DOC e411 HIM C-2] | Documented, **unverified**. Installed SW version unknown (B-1). |
| Mindray, model TBC (file name says BC-5000 / BC-5150) | Haematology | HL7 v2.3.1 over MLLP [DOC Mindray §1, 4.3.1] | "TCP interface communication/port communication" [DOC Mindray §1]. Listener side and port **not stated**. | **Query only**: analyzer sends ORM^O01 per sample, LIS answers ORR^O02 [DOC Mindray 4.1.2, 5.5]. No unsolicited download described. | Yes: ORU^R01, LIS answers ACK^R01 [DOC Mindray 4.1.1, 5.2] | Document applicability **unconfirmed** (B-3). Transport details unknown (B-4). |
| Roche cobas c 111 | Clinical chemistry (photometry, optional ISE) | ASTM E1381-97 / E1394-97 [DOC c111 HIM 7.1.1] | RS-232, one port, 15 m [DOC c111 HIM 5.2, 6.3] | **Yes**: real-time query (once or always) and batch download [DOC c111 HIM 5.1, 6.1] | Yes: real-time and batch; **host may also request results** [DOC c111 HIM 6.4] | **In scope** (lab confirmed 2026-11-03). Documented for SW ≥ 3.0, **unverified**. Installed SW version unknown (B-9). |

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

## 4. Roche cobas c 111

In scope: the lab confirmed on 2026-11-03 that a cobas c 111 is installed.
The manual we hold covers **instrument software 3.0 and higher**; the
installed version is unknown (B-9).

### 4.1 Physical and link layer

| Item | Value | Source | Status |
|---|---|---|---|
| Connector | Topmost RS-232 connector on the right side, marked "Host" | c111 HIM 5.2 | [DOC] |
| Cable | Standard null-modem, or 3-wire cable (TxD/RxD crossed, GND) for software handshake or none | c111 HIM 5.2, Fig. 1–2 | [DOC] |
| Max cable length | 15 m | c111 HIM 5.2.1, 6.3.1 | [DOC] |
| Speed | 1200 to 115200 bps; default 9600 | c111 HIM 6.3.1 | [DOC] |
| Line mode | N81 (default), E81, O81, N82, E71, O71, E72, O72 | c111 HIM 6.3.1 | [DOC] |
| Handshake | OFF, HW (RTS/CTS), **SW (XON/XOFF, default)** | c111 HIM 6.3.1 | [DOC] |
| Checksum validation on receive | ON (default) or OFF; the analyzer always sends a valid checksum | c111 HIM 5.1 | [DOC]. Keep ON. |
| Frames | Max 240 text characters, 247 per frame; FN modulo 8 from 1 | c111 HIM 7.1.3, 7.1.5 | [DOC] |
| Checksum | The text says "modulus 8 of the sum", but the worked example and every trace use the low 8 bits (mod 256), identical to the e 411 | c111 HIM 7.1.5, 9.x | [DOC], **text inconsistent**: follow the example; confirm in testing |
| Records per frame | "Different records must be sent in different frames"; the receiver concatenates all frames until EOT, then splits on CR. In the traces the analyzer ends each record's frame with ETB and only the last with ETX; the host example uses ETX per record. | c111 HIM 7.1.4.4, 7.1.5, 9.1–9.6 | [DOC] |
| Encoding | Printable ASCII | c111 HIM 6.2.1, 11 | [DOC] |

**XON/XOFF.** With the default software handshake, DC1/DC3 bytes may appear
on the line. The device server (or the local serial port) must handle
XON/XOFF itself, or the analyzer must be set to handshake OFF. The
middleware's serial config therefore has a `flowControl` setting, and the ASTM
decoder reports stray DC1/DC3 outside frames as noise instead of failing.
Which option to use is decided with the Roche engineer (B-9).

### 4.2 Workflows and messages

| Flow | Direction | Header comment | Source |
|---|---|---|---|
| Test order inquiry (query) | c 111 → host | `TSREQ^REAL`, `Q|1|^<SampleID>||ALL||||||||O` | c111 HIM 6.4, 7.2.2.9, 9.1 |
| Rerun test order inquiry | c 111 → host | as above, when "Send Order Query = ALWAYS" and the sample is seen again | c111 HIM 5.1, 6.1.1.4 |
| Test orders (reply / batch) | host → c 111 | `TSDWN^REPLY` / `TSDWN^BATCH` | c111 HIM 6.4.1, 9.2 |
| Patient / control results | c 111 → host | `RSUPL^REAL`, `RSUPL^BATCH`, `RSUPL^REPLY` | c111 HIM 6.4 |
| **Result request** | host → c 111 | `RSREQ^REAL`, `Q|1|^<SampleID>||ALL||||||||F` | c111 HIM 6.4.1, 9.5–9.6 |
| Photometric / ISE calibration | c 111 → host | `PCUPL^REAL` (M.CR), `ICUPL^REAL` (M.ICR) | c111 HIM 6.4, 7.2.2.10 |
| Raw absorbance data | c 111 → host | M.RR records after results, if Raw-Data = ON | c111 HIM 5.1, 7.2.2.11 |
| Reagent disk loading, database reset | both | MSR INR/INU, EAC/EAR | c111 HIM 7.3; **factory use only, never sent by the middleware** |

Configuration items on the analyzer (Utilities – Configuration – Host
Settings) [DOC c111 HIM 5.1]:

* Communication: OFF / BATCH / REALTIME. Automatic result upload only in REALTIME.
* Send Order Query: OFF / ONCE / **ALWAYS** (default). ALWAYS asks again every
  time a sample is seen, to pick up rerun orders.
* Query Timeout: 10 to 300 s, default **10 s**, cannot be disabled.
* Send Result Mode: OFF / COMPLETE (default) / IMMEDIATE. QC results are sent
  immediately, not grouped.
* Raw-Data, Trace, System ID (default `c111`), Host ID (default `host`).

### 4.3 Record content

| Record | Content | Source |
|---|---|---|
| H | H-5 sender is `<name>^Roche^c111^<SW version>^<protocol version>^<serial number>`, so **every message carries the instrument's software version and serial number**. H-11 meaning^cause, H-14 timestamp. | c111 HIM 7.2.2.2 |
| P | Ignored on receive; on transmit P-4 carries the un-extended sample ID only in "Grouped Sample ID" (NPT) mode | c111 HIM 7.2.2.4 |
| O (host → c 111) | O-3 sample ID (max 23); O-5 `^^^<HostCode>^<Treatment>` repeated, max 60; O-6 R/S; O-12 action `A` add (creates sample if new), `C` cancel, `Q` QC; O-26 report type, `O\Q` for a query reply, `Z` for "no tests" | c111 HIM 7.2.2.5, 9.2 |
| O (c 111 → host) | O-3 **empty**; O-4 `<SampleID>^^<Position 1-8>`; controls use `1000 + control code` as the ID with action code `Q`; O-23 report time; O-26 `F`, `O\Q`, `F\Q` | c111 HIM 7.2.2.5, 9.4, 9.6 |
| R | R-3 `^^^<HostCode>^<Treatment D/C/empty>`; R-4 value with `<`/`>` prefix outside measuring range; **qualitative results not available**; R-5 units; R-6 reference range lower/upper (QC: target range); R-7 `L H < > N A`; R-9 **`F` first result, `C` rerun result, `X` cannot be completed, `R` re-transmission of a result already sent, `I` QC result ignored**; R-11 operator who released, or `$SYS$` if accepted automatically | c111 HIM 7.2.2.7 |
| C after R | `C|1|I|<flag>^<comment>\…|I`: all active flags, repeated; flag catalogue in Appendix A (data, calibration, QC, derived, treatment flags, priority list) | c111 HIM 7.2.2.8, 8 |
| C after O (host → c 111) | `C|1|L|<comment ≤30>|G` replaces the sample comment | c111 HIM 7.2.2.6 |

### 4.4 Behaviour that shapes the design

* **No automatic re-send.** If the host does not confirm a communication in
  time, "the unconfirmed communication records are not re-sent". After 3
  failed attempts on content errors the block is aborted; results must then
  be sent manually [DOC c111 HIM 6.5]. The middleware therefore uses the
  documented **result request** (`RSREQ`) as an automatic recovery path: a
  reconciliation job asks the c 111 for results of samples that were queried
  but have no results after the expected time. Re-sent results arrive with
  R-9 = `R`, which the deduplication rules treat as a re-transmission, not a
  repeat ([08](08-durable-processing.md) §5).
* **Query timeout defaults to 10 s** (shorter than the e 411's 15 s). The
  query reply budget for the c 111 is 3 s.
* **Database limit of 300 samples**; orders beyond the limit are not stored
  [DOC c111 HIM 6.1.2.2]. Batch download is off by default; real-time query
  is used.
* **Sample ID handling modes** [DOC c111 HIM 4.4.5]: "Order ID = Sample ID",
  "Independent ID", and "Grouped Sample ID", which **appends a 3-character
  extension** to the ID. The middleware requires "Order ID = Sample ID" so
  the barcode it printed is the ID it receives. Grouped mode would need a
  separate matching rule and is not supported in the MVP.
* **Samples are never identified by position**; a sample must be identified
  before it is placed [DOC c111 HIM 4.4.2, 6.1.1.2]. No rack read-error
  placeholder exists, unlike the e 411.
* **Calibration and raw data** (M.CR, M.ICR, M.RR) go to a calibration /
  raw-data store, never to patient results.
* **Test codes**: the analyzer maps its ACN (Roche test number) to a
  lab-defined Host Application Code through a table exported and imported as
  a text file [DOC c111 HIM 6.1.2.4]. That table is part of the mapping set
  under change control.
* **Reruns**: manual only (no automatic rerun); the host may place rerun
  orders when the sample is seen again with "Send Order Query = ALWAYS"
  [DOC c111 HIM 4.4.4, 6.1.1.4].

### 4.5 Open items specific to c 111

* Installed software version and serial number (B-9). The H record will
  report both once the link is up; record them in the verification file.
* Current Host Settings and RS-232 settings, including handshake (B-9).
* Sample ID handling mode in use (B-9).
* Which tests are installed, and the current ACN to Host Code table (B-9).
* Whether ISE is fitted.
* Behaviour on `RSREQ` for a sample no longer on board **[UNVERIFIED]**.
* How the analyzer behaves if our reply arrives after its query timeout
  **[UNVERIFIED]**.

## 5. Capability-driven workflow per instrument

| Capability | e 411 (doc) | c 111 (doc) | Mindray (doc) | Middleware behaviour |
|---|---|---|---|---|
| Host query for orders | Yes (timeout 15 s) | Yes (timeout 10 s default, once or always) | Yes (ORM/ORR) | Answer from local DB within the instrument timeout |
| Unsolicited order download | Yes (batch, max 2000 tests, overwrite risk) | Yes (batch, max 300 samples) | Not described | Off by default; real-time query instead |
| Results upload | Yes | Yes (complete or immediate) | Yes | Persist raw, then ACK |
| Host requests results | No | **Yes** (`RSREQ`) | Not described | c 111: automatic recovery job. Others: operator re-sends from analyzer. |
| Automatic re-send after a failed transfer | Retries a frame up to 6 times | **No** | Not described | c 111 relies on the recovery job |
| QC upload | Yes | Yes (action code `Q`) | Yes (`MSH-11 = Q`) | Routed to the QC store, never to patient results |
| Calibration upload | No | Yes (M.CR, M.ICR) | Not described | Calibration store only |
| Qualitative results | Yes (`1/0/-1` with COI) | **Not available** | `IS` values | Per mapping |
| Rerun indication | `R-9 = C` | `R-9 = C`; `R` = re-transmission | Recheck flag `01006` | New version for a rerun; no new version for a re-transmission |
| Automatically accepted result | Not described | Operator `$SYS$` | Not described | Shown in review |
| Operator-edited result | Not described | Not described | OBX-13 `E` / `e` | Highlighted in review; cannot be autoverified |

When an instrument cannot receive orders (query disabled, licence missing, or
link down), the lab uses the **manual loading workflow**: the middleware
prints a load list per instrument (accession, barcode, tests, priority); the
operator programs tests on the analyzer; results are matched by barcode on
arrival. See [06](06-database-and-state-machines.md) §5 and
[09](09-ui-wireframes.md) screen W-5.
