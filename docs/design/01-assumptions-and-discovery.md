# 01. Assumptions and Critical Discovery Questions

This document lists what we do not yet know, what we have assumed so design
can proceed, and the documents we need before any real analyzer driver is
written. Labels follow [docs/README.md](../README.md).

## 1. Blocking documentation before driver implementation

No production driver work starts until the row's "Needed" column is satisfied.
Parsers and simulators may be written earlier against the documents we hold,
but they stay behind a feature flag and are labelled unverified.

| ID | Needed | Why | Status |
|---|---|---|---|
| B-1 | Installed cobas e 411 **software version**, serial number, and confirmation from Roche that Host Interface Manual v2.2 (Nov 2013) applies to that version | The manual we hold predates current software. One behaviour (no duplicate test orders per sample) is only stated as valid "from software version 02-04". | Open |
| B-2 | Photo or export of the e 411 **[Utility] > [System] > [Host Communication Setting]** screen as configured today: protocol type (Elecsys® or cobas®), speed, frame, automatic upload, STAT upload mode, automatic session recovery, QC additional information, send-result-only mode, and the full **Host Test Code** table | Determines which of the two record formats and which flows we implement, and the test-code map. | Open |
| B-3 | Exact **Mindray model(s)**, firmware/software version, and the interface manual Mindray confirms for that version | The HL7 document we hold does not name a model in its body, and parts of it read as written for a veterinary variant (see 04 §3.4). | Open |
| B-4 | Mindray **transport details**: TCP vs serial, which side listens, port number, single or multiple connections, keep-alive, and behaviour when the LIS does not acknowledge or replies `AE`/`AR` | Not stated in the document we hold. Required for the connection state machine. | Open |
| B-5 | Mindray **worklist (ORM/ORR) behaviour**: is bidirectional mode licensed and enabled, how the analyzer encodes "no order found", timeout, and whether the host can select CBC vs CBC+5DIFF | The document shows a successful response only. | Open |
| B-6 | **HMIS vendor, product, version**, API documentation, authentication method, test environment URL and credentials | We will not invent HMIS endpoints. The connector cannot be built without this. | Open |
| B-7 | HMIS **code systems**: test catalogue, specimen types, units, order statuses, result statuses, and how corrections and cancellations are represented | Required for mapping tables and the outbox payloads. | Open |
| B-9 | Installed cobas c 111 **software version** and serial number, confirmation from Roche that Host Interface Manual v2.2 (for SW ≥ 3.0) applies, and photos of **Utilities – Configuration – Host Settings** (communication type, checksum, Send Order Query, Query Timeout, Send Result Mode, Raw-Data, System ID, Host ID), the **RS-232 settings including handshake**, the **Sample ID handling mode**, and an export of the **ACN to Host Code table** | Determines link settings, matching rules (the Grouped Sample ID mode alters IDs), and the test-code map. See [04](04-analyzer-compatibility-matrix.md) §4. | Open |
| B-8 | The hospital's **barcode label specification** (symbology, length, check digit, printer model, label stock) | Sample ID limits: e 411 accepts up to 22 characters [DOC e411 HIM E-8]; Mindray OBR-3 recommends 22 [DOC Mindray 4.3.5]. | Open |

## 2. Discovery questions

### 2.1 HMIS

| ID | Question | Owner |
|---|---|---|
| D-1 | Who is the HMIS vendor and which product/version is live? Is there a non-production environment we may connect to? | Hospital IT |
| D-2 | Does the HMIS offer a REST API, HL7 v2, or FHIR? If FHIR, which version (R4/R4B/R5) and which profiles (e.g. a national IG)? We will use FHIR only if the live HMIS supports it. | HMIS vendor |
| D-3 | How are new lab orders exposed: webhook/push, polling with a change cursor, or HL7 ORM over MLLP? | HMIS vendor |
| D-4 | Authentication: OAuth 2.0 client credentials, mutual TLS, API key, or basic? How are credentials rotated and who rotates them? | Hospital IT |
| D-5 | Rate limits, pagination model, maximum payload size, idempotency-key support on result submission | HMIS vendor |
| D-6 | Identifiers: what uniquely identifies a patient (MRN, national ID), an encounter/visit, an order, and an order line? Can an MRN be merged or changed? | HMIS vendor, Medical records |
| D-7 | Does the HMIS accept preliminary results, corrected results, and result cancellations? How does it signal acceptance of a result (synchronous 2xx, later status, query)? | HMIS vendor |
| D-8 | Who is allowed to cancel an order after the specimen is collected, and how is that communicated? | Lab manager |
| D-9 | What is the expected order volume (orders/day, tests/order, peak hour)? | Lab manager |

### 2.2 Instruments

| ID | Question | Owner |
|---|---|---|
| D-10 | e 411: disk or rack version? (The manual describes both; the query timeout differs: 15 s for a single inquiry, about 40 s for rack-type communication [DOC e411 HIM F-2, F-5].) | Lab / Roche FSE |
| D-11 | e 411: is real-time inquiry (host query) wanted, or batch download? Batch download stores up to 2000 tests and **overwrites the oldest** when full [DOC e411 HIM F-9], so we propose real-time query. | Lab manager |
| D-12 | ~~Is a cobas c 111 installed and in scope?~~ **Answered 2026-11-03: yes**, a c 111 is in the lab and is in scope. Other, not yet listed instruments are also present (D-26). | Lab manager |
| D-26 | **Full instrument inventory.** For every analyzer in the lab (including ones not planned for the first release): manufacturer and exact model, serial number, software/firmware version, discipline, daily sample volume, physical location, available host ports (RS-232, Ethernet, USB), whether a host-interface licence or option is installed, whether it is connected to any LIS/middleware today, the vendor's host-interface manual for that version, and the service contact. | Lab manager, Biomedical engineering |
| D-13 | Where will each analyzer physically sit relative to the middleware server? The e 411 RS-232 cable limit is 15 m [DOC e411 HIM B-2]. | Hospital IT, Biomedical engineering |
| D-14 | Are the Mindray analyzers connected via their own PC/workstation software (the document refers to "the PC connecting the analyzer" [DOC Mindray 4.1.1])? Which network segment is that PC on, and who patches it? | Biomedical engineering |
| D-15 | Which service contracts allow us to request host-interface configuration changes and a vendor-assisted interface test? | Lab manager |
| D-16 | Which QC material is used on each instrument, and should QC results be stored in the middleware only, or also forwarded somewhere? | Lab QA |

### 2.3 Hospital environment

| ID | Question | Owner |
|---|---|---|
| D-17 | Target OS: Windows Server (2019/2022/2025) or Linux (RHEL/Rocky/Ubuntu LTS)? CPU architecture (x86-64 assumed)? Virtual or physical? | Hospital IT |
| D-18 | Existing PostgreSQL service we should use, or install our own? Supported major version? | Hospital IT / DBA |
| D-19 | Identity provider: Active Directory (LDAP/Kerberos), Entra ID, Keycloak, other? Can we use OIDC or SAML from the intranet? | Hospital IT |
| D-20 | Certificate authority for intranet HTTPS, and the renewal process. | Hospital IT |
| D-21 | Backup system, schedule, retention, and whether restore tests are performed. | Hospital IT |
| D-22 | Legal retention for lab records, raw instrument messages, and audit trails. Data protection law in force. | Hospital compliance |
| D-23 | Network segmentation: VLANs, firewall owner, change process; is there an existing serial-to-Ethernet device server standard (vendor/model)? | Hospital IT |
| D-24 | Hospital time zone and NTP source. | Hospital IT |
| D-25 | Who signs off validation and authorises clinical go-live? | Lab director, Quality |

## 3. Working assumptions

Each assumption is a placeholder. When a discovery answer arrives, update the
assumption and every document that cites it.

| ID | Assumption | Consequence if wrong | Closes with |
|---|---|---|---|
| A-1 | The middleware runs on a hospital-managed **virtual machine** with no physical COM port. RS-232 instruments are reached through a **serial device server** (RS-232 to TCP, raw socket mode) placed within 15 m of the analyzer. | If a physical server with COM ports is used, the serial transport is configured instead. Both transports are designed. | D-13, D-17, D-23 |
| A-2 | Target CPU architecture is **x86-64**. | Native serial module prebuilds and the bundled Node.js must be rebuilt for ARM64. | D-17 |
| A-3 | The e 411 will run in **cobas® protocol type** with **real-time** inquiry and automatic upload enabled. cobas® type sends calculated tests and distinguishes rerun results (status `C`) [DOC e411 HIM E-15, E-16]. | If Elecsys® type is kept, the alternate record layout is used; both are parsed. | B-2 |
| A-4 | The middleware is the **source of truth for analyzer orders**. Analyzer queries are answered from the local database only, never by a synchronous HMIS call, so a reply always meets the analyzer's timeout. | None expected. | n/a |
| A-5 | The HMIS is the **source of truth for patients, encounters, and orders**. Manual registrations during downtime are provisional until reconciled. | If the hospital wants the middleware to be the master for some data, reconciliation rules change. | D-6 |
| A-6 | Results are released to the HMIS **only after human approval**. Autoverification is off and can only be enabled per test after documented laboratory validation. | n/a (policy) | Lab director |
| A-7 | Expected peak load is below **2,000 samples/day** and **20 result messages/minute** per instrument. Sizing in [11](11-installation-and-runbooks.md) uses this. | Re-size. | D-9 |
| A-8 | The HMIS supports some idempotency mechanism (idempotency key, or a stable external result ID we can query). | Without it, "request succeeded but response lost" can only be resolved by human reconciliation. See [08](08-durable-processing.md) §7. | D-5, D-7 |
| A-9 | Browser users are on the hospital intranet; no internet exposure. | Internet exposure would need a separate threat model. | D-23 |
| A-11 | The c 111 will run in **REALTIME** communication with "Send Order Query = ALWAYS", "Send Result Mode = COMPLETE", checksum ON, and Sample ID handling **"Order ID = Sample ID"**. Handshake (XON/XOFF or OFF) is set to match the device server. | If Grouped Sample ID mode is required, matching must strip the 3-character extension; not in the MVP. | B-9 |
| A-12 | Instruments beyond the e 411, c 111 and Mindray get no model-specific driver in the first release. An administrator can register them with a generic result-only profile ([14](14-adding-instruments.md)), but they stay out of clinical use until each has its own manual, an interface test and lab acceptance. | Re-plan if the lab needs host query on another instrument first. | D-26 |
| A-13 | Local accounts hash passwords with **scrypt** (N=2^15, r=8, p=1) from the Node.js standard library, not the argon2id named in [10](10-security-and-audit.md) §3, so the offline install needs no native module. Both are memory-hard. Hospital SSO (OIDC or LDAPS) is not built yet; until it is, every user is a local account. | Switch to argon2id if the hospital's policy names it: the hash format carries its algorithm, so old hashes keep working during the change. | D-17, hospital IT security |
| A-14 | Specimen labels carry a **Code 128** barcode of the accession number (`L` + YYMMDD + 5 digits, 12 characters, within the 22-character limits above) on a **50 x 25 mm** label printed from the browser, with name, MRN, birth date, sex, specimen type and tests. Specimen types come from the HMIS order line as given. | Change symbology, size or fields to the hospital's label specification; a thermal-printer language (ZPL or EPL) would replace browser printing. | B-8 |
| A-15 | During HMIS downtime the lab registers a **provisional patient** (`PROV-000001`) and a **downtime order** (`DT-000001`) by hand, choosing tests from the local codes already known (HMIS code map and active instrument mappings). Results on a downtime order are **held**: they can be reviewed and approved but not released. Sending with downtime identifiers is not built. One technologist or approver reconciles each order to the HMIS order, re-entering their password; specimens and results move to the HMIS order's matching tests, and the provisional patient is marked merged, never deleted. | If the HMIS accepts results against downtime identifiers, add that as a configurable option. If policy wants two people for reconciliation, add the same check as for unmatched results. | D-6, D-7 |
| A-10 | Mindray data arrives over TCP with MLLP framing [DOC Mindray §1]. Which side listens is configurable in the adapter until confirmed. | n/a | B-4 |

## 4. Unresolved dependencies (summary)

1. HMIS API and its test environment (B-6, B-7). Without these, the HMIS
   connector is built against a mock only.
2. Installed instrument versions and current interface configuration
   (B-1, B-2, B-3, B-9), and the full instrument inventory (D-26).
3. Mindray transport and worklist behaviour (B-4, B-5).
4. Barcode specification and printer (B-8).
5. Network placement, device servers, and firewall change approvals
   (D-13, D-23).
6. Identity provider integration (D-19).
7. Retention and legal requirements (D-22).
8. A vendor-assisted interface test slot for each instrument (D-15).
