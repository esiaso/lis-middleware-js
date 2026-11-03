# 02. Architecture and Hospital Network

## 1. Logical architecture

The system is a **modular monolith**: one codebase, one database, several
independently supervised operating-system processes that share TypeScript
packages. Module boundaries are enforced in code (see
[05](05-modules-and-contracts.md)), not by network calls.

```mermaid
flowchart LR
  subgraph HMIS["Hospital HMIS (external)"]
    HAPI[HMIS API]
  end

  subgraph MW["LIMS middleware server"]
    direction TB
    WEB["lims-web<br/>NestJS HTTP: intranet UI, REST API, OpenAPI, webhooks"]
    JOBS["lims-jobs<br/>NestJS app context: inbox processing,<br/>HMIS outbox, reconciliation, retention"]
    AW1["lims-analyzer@e411-01<br/>connection owner"]
    AW2["lims-analyzer@mindray-01<br/>connection owner"]
    DB[("PostgreSQL<br/>clinical data, inbox/outbox,<br/>raw messages, audit")]
    WEB <--> DB
    JOBS <--> DB
    AW1 <--> DB
    AW2 <--> DB
  end

  subgraph LAB["Laboratory network segment"]
    DS["Serial device server<br/>RS-232 to TCP"]
    E411["cobas e 411<br/>RS-232 DB-9"]
    MRPC["Mindray analyzer<br/>(or its workstation PC)"]
  end

  HAPI -- "orders: webhook or polling" --> WEB
  JOBS -- "orders: polling" --> HAPI
  JOBS -- "results: HTTPS" --> HAPI
  AW1 -- "TCP raw socket" --> DS
  DS -- "RS-232, ≤15 m" --> E411
  AW2 <-- "TCP + MLLP (HL7 v2.3.1)" --> MRPC
  USERS["Lab staff browsers"] -- HTTPS --> WEB
```

Key points:

* **Analyzer workers never call the HMIS.** They only write to the database
  (raw messages, inbox rows) and answer instrument queries from the database.
  An HMIS outage therefore never blocks an analyzer link.
* **The web process never owns an analyzer connection.** Restarting or
  upgrading the web process does not interrupt analyzer communication.
* **The jobs process** moves data between bounded contexts through the
  durable inbox/outbox tables (see [08](08-durable-processing.md)).
* Each process can be restarted on its own. The database is the only shared
  state.

## 2. Data flow, end to end

```mermaid
sequenceDiagram
  autonumber
  participant H as HMIS
  participant J as lims-jobs
  participant W as lims-web
  participant DB as PostgreSQL
  participant A as Analyzer worker
  participant I as Instrument

  H->>W: Order webhook (or J polls H)
  W->>DB: Store raw payload in inbox (tx)
  J->>DB: Claim inbox row, validate, register order (tx)
  Note over W,DB: Collection and accessioning in UI:<br/>specimen + barcode label printed
  I->>A: Query for sample ID (where supported)
  A->>DB: Persist raw query, look up ordered tests
  A->>I: Order response (within instrument timeout)
  I->>A: Result message (frames)
  A->>DB: Persist raw bytes, then transport ACK
  J->>DB: Parse, normalise, match to ordered test, create result version
  Note over W,DB: Technologist reviews, approver approves<br/>(release creates outbox row in same tx)
  J->>DB: Claim outbox row
  J->>H: Submit result (idempotency key)
  H-->>J: Accepted / identifier
  J->>DB: Mark delivered, later confirm via HMIS query
```

## 3. Hospital network topology

```mermaid
flowchart TB
  subgraph CORE["Data centre / server VLAN"]
    MWS["Middleware VM<br/>lims-web :443<br/>workers (no inbound ports by default)"]
    PG[("PostgreSQL :5432<br/>local or existing cluster")]
    HM["HMIS servers"]
    IDP["Identity provider<br/>(AD / OIDC)"]
    BK["Backup system"]
    SYSLOG["Protected log / audit sink<br/>(syslog or SIEM)"]
  end

  subgraph LABVLAN["Laboratory instrument VLAN (isolated)"]
    DS1["Device server<br/>raw TCP :4001 (example)"]
    E411["cobas e 411"]
    MR["Mindray analyzer / workstation PC"]
  end

  subgraph CLIN["Lab workstation VLAN"]
    PCS["Lab PCs and label printers"]
  end

  FW{{"Firewall"}}

  PCS -- "HTTPS 443" --> FW --> MWS
  MWS -- "TCP to device server port" --> FW --> DS1
  DS1 -. "RS-232 ≤ 15 m" .- E411
  MR -- "TCP to middleware listener port, or middleware to MR (B-4)" --> FW
  FW --> MWS
  MWS -- "5432" --> PG
  MWS -- "HTTPS" --> HM
  MWS -- "LDAPS 636 / HTTPS" --> IDP
  MWS -- "syslog over TLS 6514" --> SYSLOG
  PG -- "backup agent" --> BK
```

Port numbers shown are examples. Real values come from discovery (D-23, B-4)
and are recorded in the firewall request in
[11](11-installation-and-runbooks.md) §6.

### 3.1 Why a serial device server

The e 411 host port is RS-232 on a D-SUB 9 connector at the left side of the
analyzer, with a 15 m maximum cable length, one port, half duplex
[DOC e411 HIM B-2, B-7]. Hospital VMs normally have no COM port, and USB
pass-through to a VM is fragile. A serial device server in **raw TCP server
mode** next to the analyzer converts the link to TCP, so:

* the middleware VM can be anywhere on the network;
* the ASTM state machine still runs entirely in the middleware (the device
  server must not add its own protocol handling);
* the device server's serial settings must exactly match the analyzer
  (speed, data bits, parity, stop bits; [DOC e411 HIM B-2, B-6]);
* **[UNVERIFIED]** the device server must not buffer or coalesce data in a
  way that delays single-byte ACK/NAK/ENQ/EOT beyond the 15 s ASTM timeout.
  Configure "packing" or "delimiter" options off or to a short interval
  (milliseconds) and confirm during interface testing.

If the hospital prefers a physical server near the lab, the same adapter uses
a local serial port instead (see transport options in
[07](07-adapters-and-hmis-contracts.md)).

### 3.2 Cable

The e 411 manual's connection diagram shows a three-wire link: analyzer pin 2
(RXD) to host TXD, analyzer pin 3 (TXD) to host RXD, pin 5 signal ground to
host ground, with pins 7 and 8 bridged on the analyzer side
[DOC e411 HIM B-7, Fig. B-2]. The exact cable for a given device server
depends on its DB-9 pinout (DTE vs DCE) and must be confirmed with the device
server's documentation and the Roche engineer.

## 4. Trust boundaries

| Boundary | Traffic | Protection |
|---|---|---|
| Browser to middleware | UI and API | HTTPS with the hospital CA certificate, session cookie, CSRF tokens |
| HMIS to middleware | Webhooks (if used) | HTTPS, HMAC signature or mutual TLS (per HMIS capability), IP allow-list |
| Middleware to HMIS | Orders, results | HTTPS, credentials from the secret store |
| Middleware to analyzers | ASTM / HL7 | **Cleartext**. The instrument protocols in the documents we hold define no encryption. Mitigated by VLAN isolation and firewall allow-lists, see [10](10-security-and-audit.md) §6. |
| Middleware to database | SQL | Local socket or TLS; separate DB roles per process |
