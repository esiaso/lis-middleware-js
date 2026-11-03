# 10. Security and Audit Design

## 1. Principles

* Runs entirely inside the hospital network. **No cloud service, telemetry,
  update check, or CDN** is required or contacted.
* Least privilege for people, services, and database roles.
* Patient data is minimised in logs; raw instrument messages are treated as
  sensitive records.
* Clinical audit is separate from operational logging and is independently
  exportable.

## 2. Roles and permissions

| Permission | Admin | Technologist | Approver | Operator | Auditor |
|---|:-:|:-:|:-:|:-:|:-:|
| View orders, specimens | ✔ | ✔ | ✔ | ✔ | ✔ (read) |
| Register downtime order | | ✔ | ✔ | ✔ | |
| Collect, receive, print labels | | ✔ | ✔ | ✔ | |
| Reject specimen / request recollection | | ✔ | ✔ | | |
| Review results | | ✔ | ✔ | | |
| Approve and release results | | | ✔ | | |
| Correct released results | | | ✔ | | |
| Resolve unmatched results | | ✔ (with 2nd-person check) | ✔ | | |
| Replay failed messages | ✔ | | ✔ (result topics) | | |
| Edit instrument config, mappings (draft) | ✔ | ✔ | | | |
| Approve mappings | | | ✔ (lab director) | | |
| Manage users and roles | ✔ | | | | |
| Read raw messages | ✔ | ✔ | ✔ | | ✔ |
| Search and export audit | | | | | ✔ |

* An administrator cannot approve results unless separately given the
  approver role, and granting oneself a role is blocked.
* Optional two-person rule: reviewer and approver must differ.

## 3. Identity

* Preferred: **OIDC** against the hospital IdP (Keycloak, AD FS, Entra ID)
  using authorization code + PKCE. Group claims map to roles via a
  configurable table.
* Alternative: **LDAPS** bind against Active Directory with group mapping.
* Fallback: local accounts (argon2id hashes, lockout after 5 failures,
  15 min), used for break-glass admin only and audited prominently.
* Re-authentication (or SSO step-up) for approve, correct, replay, and
  mapping approval when the IdP supports it; otherwise password re-entry.

## 4. Browser sessions and web security

* HTTPS only; HSTS; hospital CA certificate. HTTP port redirects or is closed.
* Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, server-side session
  store in PostgreSQL, idle timeout 15 min (configurable), absolute 12 h.
* CSRF: synchronizer token on every form and state-changing request
  (`csrf-csrf` double-submit or a session-bound token).
* `helmet` headers; strict Content-Security-Policy (`default-src 'self'`; no
  inline script; Bootstrap served locally).
* Handlebars auto-escaping on; `{{{triple}}}` is banned by lint.
* All input validated with Zod; all SQL through Prisma or tagged `$queryRaw`
  (parameterised). `$queryRawUnsafe` is banned by lint.
* Rate limiting on login and webhook endpoints.

## 5. Service and database accounts

| Account | Used by | Rights |
|---|---|---|
| OS `lims-svc` (Linux) / virtual service account `NT SERVICE\lims-*` (Windows) | All Node processes | Read install dir, write data/log dirs, no interactive login, no admin |
| DB `lims_owner` | Migrations only (installer) | Owns schema; credentials only present during upgrade |
| DB `lims_app` | web, jobs | DML on application tables; no DDL; no UPDATE/DELETE on `audit_event` |
| DB `lims_link` | analyzer workers | INSERT on `raw_message`, `raw_frame`, `inbox_message`, `link_session`; SELECT on instrument config, barcodes, ordered tests; UPDATE on own lease row |
| DB `lims_audit_reader` | Auditor exports | SELECT on audit tables |
| DB `lims_backup` | Backup agent | Replication / `pg_dump` rights only |

Serial port access on Linux: `lims-svc` in the `dialout` group (or a udev
rule for the specific adapter).

## 6. Network

* Firewall allow-list only (see [11](11-installation-and-runbooks.md) §6).
* Analyzer links are cleartext ASTM / HL7 (no encryption in the protocols as
  documented). Mitigations:
  * dedicated instrument VLAN; only the middleware IP may reach device
    servers / analyzer ports, and only from the specific port;
  * device servers: change default passwords, disable unused services
    (web UI over HTTP, telnet, SNMP v1/v2), firmware patched, configuration
    backed up;
  * TCP listeners for instruments accept only the configured peer IPs;
  * no instrument VLAN route to the internet.
* HMIS calls: HTTPS with certificate validation against the hospital CA
  bundle; optional mutual TLS.
* PostgreSQL: listen on localhost if co-located; otherwise TLS with
  `hostssl` rules for the middleware IP only.

## 7. Secrets

* No secret in config files or source control. Config refers to secrets by
  name.
* Windows: secrets stored with **DPAPI** (machine scope, readable only by the
  service account) via a small CLI (`lims secrets set NAME`).
* Linux: files under `/etc/lims/secrets/` owned by root, group `lims-svc`,
  mode `0640`, or systemd `LoadCredential=` (credentials exposed only to the
  unit); optionally `systemd-creds` encryption bound to the TPM.
* Rotation: HMIS credentials are read at use time; DB passwords rotate with a
  two-step procedure (add new password, restart services, remove old);
  webhook secrets support two active values during rotation.
* Disk and backup encryption: BitLocker (Windows) or LUKS (Linux) for data
  volumes, and encrypted backups (hospital backup system or `pg_basebackup`
  + `age`/GPG encryption) with keys held by hospital IT, not the vendor.

## 8. Clinical audit trail

### 8.1 Events recorded

| Area | Events |
|---|---|
| Registration | order received, patient created/merged, downtime registration, reconciliation link |
| Specimens | collect, label print/reprint, receive, reject, recollect, cancel, barcode retire |
| Results | received (with raw message ID), version created, reviewed, approved, released, corrected, cancelled, delivered, HMIS-confirmed, delivery failed, retransmitted |
| Quarantine | unmatched result linked, discarded, test added |
| Configuration | instrument config change, mapping draft/approve/activate, HMIS code map change, autoverification enable/disable |
| Access | login, logout, failed login, role grant/revoke, user create/disable, raw message viewed, audit exported |
| Operations | message replay, link pause/resume, lease takeover, retention purge |

Each event stores: actor (user ID or `system:<process>`), timestamp (UTC),
action, entity type and ID, **reason** (mandatory for corrections, rejects,
discards, replays, overrides), correlation ID (propagated from HTTP request,
inbox, or raw message through all downstream work), and **before/after**
values for changed fields. Patient identifiers in before/after are limited to
what is needed to understand the change.

### 8.2 Tamper evidence and its limits

* Each row stores `prev_hash` and `hash = SHA-256(prev_hash ∥ canonical JSON of the event)`.
  Inserts are serialised through a single-row lock on `audit_head` so the
  chain is linear.
* The application role cannot UPDATE/DELETE audit rows.
* Nightly job verifies the full chain and writes the head hash to the
  operational log **and** to the external sink.
* **Limits (stated plainly):** a database superuser or OS administrator can
  rewrite the table and recompute the chain. The hash chain detects
  accidental change and changes by the application account, but not by a
  privileged insider acting alone. Protection against that requires copies
  outside their control:
  1. **Streaming export**: each audit event is also sent (from the outbox,
     at-least-once) to a protected external destination: syslog over TLS to
     the hospital SIEM, or a write-once (WORM) share.
  2. **Signed periodic exports**: daily JSON-lines file + manifest with the
     chain head, signed with a key held by the auditor role; stored on media
     the DB admins cannot modify.
* Audit records are excluded from retention purges.

### 8.3 Operational logs (Pino)

* JSON lines, fields: `time`, `level`, `process`, `instrumentId`,
  `correlationId`, `msg`, `err`.
* Redaction (`pino` `redact` paths): `password`, `authorization`, `cookie`,
  `token`, `secret`, `*.patient.*`, `*.name`, `*.birthDate`, `rawBytes`.
* Raw frames are **never** logged; logs refer to `rawMessageId` instead.
* Sample IDs/barcodes may be logged (needed for troubleshooting); names and
  dates of birth may not.

## 9. Raw message access

Raw messages contain patient data (Mindray PID carries name and date of
birth [DOC Mindray 4.3.3]). Viewing requires `raw_message.read`, is audited,
and the UI shows a masked view by default with an explicit "reveal" action.

## 10. Supply chain

* `package-lock.json` committed; builds use `npm ci` with `--ignore-scripts`
  except an allow-list of packages that need install scripts (e.g. Prisma
  generate, serialport prebuild selection), reviewed per upgrade.
* SBOM (CycloneDX) generated at build; licence inventory checked against an
  allow-list.
* `npm audit` / OSV scan in CI; critical findings block a release.
* Release artefacts are checksummed (SHA-256) and code-signed (Windows
  installer and executables with Authenticode; Linux tarball with a detached
  signature).
