# 14. Adding New Instruments

The lab has instruments beyond the e 411, c 111 and Mindray analyzers
(D-26). This document describes how an administrator adds one without a
code release, and what stops a newly added instrument from sending results
to patients' records before it has been checked.

## 1. Two kinds of driver

| | Model-specific driver | Generic profile |
|---|---|---|
| Examples | `cobas-e411-astm`, `cobas-c111-astm`, `mindray-hl7-mllp` | `generic-astm`, `generic-hl7-mllp` |
| Written by | Developers, from the vendor manual, reviewed and released in a signed bundle | Filled in by an administrator on the registration screen, from the vendor manual |
| Results from the instrument | Yes | Yes |
| QC results | Yes | Yes, if the profile has a QC rule |
| Answers host queries or downloads orders | Where the manual describes it | **Never** |
| Instrument-specific behaviour (reruns, re-send requests, alarms, dilutions) | Yes | No: shown as raw flags and comments only |
| Clinical use | After vendor interface test + lab acceptance | Same, no shortcut |

Generic profiles only receive results. Answering an order query wrongly can
make the analyzer run the wrong tests on a patient sample, so that needs a
model-specific driver that has been reviewed against the manual. An
instrument on a generic profile is run in **load-list** mode
([09](09-ui-wireframes.md) W-5): the operator enters tests on the analyzer,
and the middleware matches results by sample barcode.

When an instrument needs host query, or its results need more than field
positions to read correctly, it moves to a model-specific driver, following
the onboarding steps in [13](13-implementation-plan.md) phase 5.

## 2. What the administrator fills in

Registration (`InstrumentRegistration` in `@lis/contracts`):

* **Identity:** display name, manufacturer, model, serial number, software
  version, discipline, location. These are the D-26 inventory fields.
* **Interface manual reference:** title, document number and revision. This is
  required for a generic profile, because the profile is only as good as the
  manual it was copied from.
* **Connection:** transport (serial with flow control, TCP client to a device
  server, or TCP listener with a peer allow-list) and message size limit, as
  for any instrument ([05](05-modules-and-contracts.md) §2.5).
* **Driver:** a model-specific driver, or a generic profile.

Generic ASTM profile (`GenericAstmProfile`), standard ASTM E1381 link and
E1394 records:

| Setting | Default | Notes |
|---|---|---|
| Sample ID location | **required** | Record P or O, field, component. There is no default because instruments differ (the e 411 uses O-3, the c 111 uses O-4). |
| Test code | R-3 component 4 | E1394 universal test ID `^^^code` |
| Value, units, reference range, flags, status, completion time | R-4, R-5, R-6, R-7, R-9, R-13 | E1394 positions |
| Status map | `F` → final | Codes that are not mapped become "unknown" and are shown for review, never guessed |
| QC rule | O-12 equals `Q` | E1394 action code. Must be on P or O, never on R. |
| Character set | latin1 | Lossless byte mapping. UTF-8 only if the manual says so. |

Generic HL7 profile (`GenericHl7Profile`), HL7 v2 over MLLP:

| Setting | Default | Notes |
|---|---|---|
| Result message types | `ORU^R01` | Other types are stored and acknowledged, never acted on |
| Sample ID location | **required** | Segment, field, component (often OBR-2, OBR-3 or SPM-2) |
| Test code, coding system | OBX-3.1, optional OBX-3.3 | |
| Value type, value, units, reference range, flags, status, time | OBX-2, -5, -6, -7, -8, -11, -14 | HL7 v2 positions |
| Binary value types | `ED` | Kept with the raw message, not parsed |
| QC rule | none | With no rule, every message is treated as a patient result and a warning is shown. The screen asks for one before saving. |
| ACK | Original mode, `MSA-1 = AA` after durable storage | MSH-11 and MSH-12 echo the received message |

The defaults are the positions defined by the standards. They are **not**
claims about any instrument. Every setting is checked against the manual
during the interface test (§4).

## 3. Safety rules (enforced in code)

These live in `@lis/domain` (`instrument-lifecycle.ts`, `test-mappings.ts`)
and are covered by tests.

1. A new instrument starts **UNVERIFIED and disabled** (`registerInstrument`).
2. Results from an instrument are released to the HMIS only if it is
   enabled, `LAB_ACCEPTED`, and its software version equals the version that
   was verified (`clinicalGate`). Results from other instruments are still
   received, stored and shown, so verification work can happen, with a "not
   for clinical use" banner.
3. Status moves only with recorded evidence (`applyEvidence`):
   * `UNVERIFIED → VENDOR_TESTED` needs an interface test record (who tested,
     organisation, date, record reference). The tested software version must
     equal the registered version.
   * `VENDOR_TESTED → LAB_ACCEPTED` needs lab acceptance, signed by the
     signed-in person themselves, with the parallel-run report reference.
   * Any status → `SUSPENDED` needs a reason. A suspended instrument goes back
     through `UNVERIFIED`.
   * No step can be skipped.
4. Changing the manufacturer, model, serial number, software version, driver,
   driver options or generic profile **resets the instrument to UNVERIFIED**
   (`changeRegistration`). Changing only the transport (for example a new IP
   address) keeps the status but asks for a link re-test.
5. The software version and serial number the instrument reports (ASTM H-5
   or the HL7 MSH header, where the driver reads them) are compared with the
   registration, and an alert is raised on a mismatch (`identityMismatches`).
6. Test mappings are versioned. A draft is approved by a **different person**
   from its author, then activated, and the previous set is retired. Only the
   active set is used. An observation with no mapping is quarantined, and
   research-use-only parameters are never reported. Results record the
   mapping version they were mapped with.
7. Every message decoded by a generic profile carries `driver: generic` and
   the profile version in its instrument context, so reviewers and auditors
   can see how it was read.

## 4. Steps for each new instrument

1. Get the vendor's host interface manual for the installed software version
   (D-26), and record its checksum in the validation file.
2. Add a row to the compatibility matrix ([04](04-analyzer-compatibility-matrix.md))
   with the evidence labels.
3. Register the instrument (W-11). Choose a model-specific driver if one
   exists; otherwise fill in a generic profile from the manual.
4. Add the firewall rule and device server port ([11](11-installation-and-runbooks.md) §5, §6).
5. Build a draft mapping set, and have the lab director approve it (W-9).
6. Run the interface verification with the vendor's engineer
   ([12](12-validation-and-acceptance.md) §4), and record the evidence.
   Status becomes `VENDOR_TESTED`.
7. Parallel run, then laboratory acceptance, recorded by the signer. Status
   becomes `LAB_ACCEPTED`. Enable the instrument.

## 5. Who does what on the screens

| Step | Screen | Role (10 §2) |
|---|---|---|
| Register, change registration, save a mapping draft | Instruments → Register / Change registration / Load mapping file | admin, technologist |
| Record interface test, suspend, start verification again, turn off | Instrument page | admin, approver |
| Sign lab acceptance, turn on, approve and activate a mapping draft | Instrument page (password asked again) | approver |

The person who last saved a mapping draft is its author and cannot approve
it, even if they also hold the approver role.

## 6. Audit

Registration, every registration change (before and after, plus the reset
or re-test reasons), each evidence record, enable and disable, and every
mapping draft, approval and activation are audit events
([10](10-security-and-audit.md) §8.1).
