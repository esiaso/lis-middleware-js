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
| Register instruments, edit instrument config, mappings (draft) | ✔ | ✔ | | | |
| Record interface test, suspend instrument | ✔ | | ✔ | | |
| Record lab acceptance, enable for clinical use | | | ✔ (lab director) | | |
| Approve mappings | | | ✔ (lab director) | | |
| Manage users and roles | ✔ | | | | |
| Read raw messages | ✔ | ✔ | ✔ | | ✔ |
| Search and export audit | | | | | ✔ |

* An administrator cannot approve results unless separately given the
  approver role, and granting oneself a role is blocked: an administrator
  cannot change their own roles or state; another administrator must.
* Every account change (create, roles, disable, enable, unlock, temporary
  password) needs the administrator's own password again and is audited
  (`user.*`). Disabling or resetting a password ends that person's sessions
  at once. A temporary password must be replaced before any other page opens.
  The last active administrator cannot lose the role or be disabled.
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
* **Built (OIDC):** code flow with PKCE against the IdP's discovery
  document, settings in [11](11-installation-and-runbooks.md) §11. The
  account is created at the first sign-in and found afterwards by issuer and
  subject, never by username, so a directory entry cannot take over a local
  account with the same name (that sign-in is refused). Roles follow the
  directory groups at every sign-in (changes audited as `system:oidc`);
  an administrator can still disable the account here, but cannot set its
  roles or a password. Step-up for these accounts is a fresh sign-in at the
  IdP (`prompt=login`, `max_age=0`, checked against `auth_time`) by the same
  subject; it allows one approval-type action within 5 minutes (A-17).
  Signing out ends the middleware session only, not the IdP session.
  LDAPS is not built.

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
* **Built:** `lims secrets set database_url | oidc_client_secret` writes the
  file atomically from standard input. Linux: root-owned, mode 0600, handed
  to the unit with `LoadCredential=`. Windows: the value is encrypted with
  **DPAPI in machine scope** (with the secret's name as extra entropy) and
  written to the secrets folder, whose ACL the installer limits to the
  service accounts, SYSTEM and administrators. Windows PowerShell 5.1 makes
  the DPAPI call, with the value on its standard input, so no native module
  ships. What this protects: a copy of the file taken off the server (a
  backup, a disk image) cannot be decrypted elsewhere. What it does not: an
  administrator on the server, or any process the ACL lets read the file,
  can still decrypt it, because machine scope is not tied to one account
  (the services run as separate virtual accounts, which user-scope DPAPI
  would need one blob each for). The ACL remains the control on the server.
  Files written before DPAPI are still read, and `lims config validate`
  warns about them.
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
| Configuration | instrument registered, instrument config change (with reset or re-test reasons), verification evidence recorded, instrument enabled/disabled, mapping draft/approve/activate, HMIS code map change, autoverification enable/disable |
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
  **Built:** CI's `audit` job runs `node scripts/audit-check.mjs`, which
  audits what ships (`npm audit --omit=dev`). It fails on any **high or
  critical** advisory that `security/audit-exceptions.json` does not
  explain, and on any explanation past its review date (three months).
  Moderate and low findings are printed only. Development tools (vitest)
  are not in the server bundle; they are kept current anyway. Reviewed on
  2026-11-04:
  * vitest 3.2.4 (two critical: its UI server and worker pool): upgraded to
    4.1.12. Development only.
  * `effect` and `deepmerge-ts` (high), pulled in by the Prisma **CLI**'s
    configuration loader for `migrate deploy`; the Prisma client the
    services run does not load them. The flaws need an Effect RPC server,
    or self-referencing objects, neither of which occurs. The fix is the
    Prisma 7 major upgrade, a planned change of its own.
  * `zod` (high, unreviewed advisory, about zod 4 internals; the code here
    uses the zod 3 API). Browser input is capped by the 100 kB body limit,
    instrument messages (ASTM and HL7) by the connection's `maxMessageBytes`.
    The HMIS connector must cap response sizes when it is built.
  * `hbs` (moderate, no fix exists): template data and engine options share
    one object in Express `render`, so a page that passed request data as the
    whole render object could override engine options and read files. Every
    page here renders an object whose top-level keys are fixed in code
    (`page()` in `controllers.ts`); request values only ever appear nested
    under them.
* Release artefacts are checksummed (SHA-256) and code-signed (Windows
  installer and executables with Authenticode; Linux tarball with a detached
  signature).
