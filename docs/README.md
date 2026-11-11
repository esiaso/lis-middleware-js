# LIMS Middleware: Design Package

> Looking for how to use the screens? See the [user manual](user-manual/README.md),
> with a chapter for each role.

This folder holds the design for an on-premises laboratory middleware that
connects the hospital HMIS API to laboratory analyzers: initially a Roche cobas
e 411, a Roche cobas c 111, and Mindray haematology analyzers, with further
instruments to follow once the lab's inventory is collected (D-26).
Protocol cores and adapters exist in `packages/` (phase 1), written only from
the vendor manuals. **No instrument is claimed as compatible** until the
installed instrument has passed interface testing with the vendor's engineer
present.

## How to read the evidence labels

Every technical statement about an instrument or external system carries one
of these labels.

| Label | Meaning |
|---|---|
| **[DOC]** | Stated in a vendor document we hold. The document and section are cited. Still not proof that the *installed* instrument behaves this way. |
| **[UNVERIFIED]** | Plausible or industry-typical, but not stated in any document we hold. Must be confirmed before a driver depends on it. |
| **[ASSUMPTION]** | A design assumption we chose so work can proceed. Listed in [01](design/01-assumptions-and-discovery.md) with an owner and a closing action. |
| **[VERIFIED-ONSITE]** | Observed on the installed instrument during a recorded interface test. Nothing has this label yet. |

## Source documents received

| File received | What it actually is | Notes |
|---|---|---|
| `…0000000000001013003023194…Native.pdf` (61 pp.) | **Roche cobas e 411 analyzer Host Interface Manual, Version 2.2, November 2013** | Matches the requested instrument. Does not state a minimum analyzer software version, except one note valid "from software version 02-04". |
| `…0000000000001013001005761…Native.pdf` (91 pp.) | **Roche cobas c 111 Host Interface Manual, Version 2.2, June 2021, for instrument software 3.0 and higher** | The PDF's embedded title says "Cedex Bio Installation Manual", but the content is the cobas c 111 manual. The lab confirmed on 2026-11-03 that a c 111 is installed, so it is **in scope**. |
| `BC-5000BC-5150_HL7_Communication_Protocol_V2.0_EN.pdf` (28 pp.) | **Mindray "3107 HL7 Communication Protocol", document Z-110-002557-002-2.0** | The file name says BC-5000/BC-5150, but the document body never names a model or firmware. It is marked "Security Classification: Secret". See [04](design/04-analyzer-compatibility-matrix.md). |

The vendor manuals are copyrighted or marked confidential. They are **not**
committed to this repository (`*.pdf` is ignored). The design paraphrases and
cites them by section; it does not reproduce them. Store the originals in the
hospital's controlled document system and record their checksums in the
validation file.

## Deliverables

| # | Deliverable | Document |
|---|---|---|
| 1 | Assumptions and critical discovery questions | [01-assumptions-and-discovery.md](design/01-assumptions-and-discovery.md) |
| 2 | Architecture and hospital network diagrams | [02-architecture-and-network.md](design/02-architecture-and-network.md) |
| 3 | Stack rationale and process deployment topology | [03-stack-and-process-topology.md](design/03-stack-and-process-topology.md) |
| 4 | Analyzer compatibility matrix with verification status | [04-analyzer-compatibility-matrix.md](design/04-analyzer-compatibility-matrix.md) |
| 5 | NestJS module structure and shared TypeScript contracts | [05-modules-and-contracts.md](design/05-modules-and-contracts.md) |
| 6 | Database schema and workflow state machines | [06-database-and-state-machines.md](design/06-database-and-state-machines.md) |
| 7 | Analyzer adapter interfaces and HMIS API contracts | [07-adapters-and-hmis-contracts.md](design/07-adapters-and-hmis-contracts.md) |
| 8 | Durable processing and reconciliation design | [08-durable-processing.md](design/08-durable-processing.md) |
| 9 | UI wireframes | [09-ui-wireframes.md](design/09-ui-wireframes.md) |
| 10 | Security and audit design | [10-security-and-audit.md](design/10-security-and-audit.md) |
| 11 | Offline installation and operational runbooks | [11-installation-and-runbooks.md](design/11-installation-and-runbooks.md) |
| 12 | Validation plan and measurable acceptance criteria | [12-validation-and-acceptance.md](design/12-validation-and-acceptance.md) |
| 13 | Phased implementation plan with MVP scope | [13-implementation-plan.md](design/13-implementation-plan.md) |
| 14 | Adding new instruments (registration, generic profiles, verification gate) | [14-adding-instruments.md](design/14-adding-instruments.md) |

Diagrams are written in Mermaid so they render on GitHub and stay
reviewable as text.
