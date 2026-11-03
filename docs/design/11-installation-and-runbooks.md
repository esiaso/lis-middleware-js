# 11. Offline Installation and Operational Runbooks

## 1. Server sizing (assumes A-7: < 2,000 samples/day, ≤ 4 instruments)

| Resource | Middleware only (external PostgreSQL) | Middleware + PostgreSQL on same VM |
|---|---|---|
| vCPU | 2 | 4 |
| RAM | 4 GB | 8 GB |
| System disk | 40 GB | 40 GB |
| Data disk | 20 GB (logs, archive staging) | 200 GB (DB, WAL, archive staging), SSD |
| OS | Windows Server 2019/2022/2025 or a supported Linux LTS (D-17) | same |

Estimate behind the data disk: e 411 messages are a few KB; Mindray messages
with histograms and BMP scattergrams can be tens to hundreds of KB
**[UNVERIFIED: measure during testing]**. At 600 haematology samples/day ×
200 KB ≈ 120 MB/day ≈ 44 GB/year of raw data, which is why blobs have a
shorter retention ([06](06-database-and-state-machines.md) §3.4). Re-size
once real message sizes are measured.

## 2. Release bundle contents

Built in CI on a clean builder per target (`win-x64`, `linux-x64`):

```
lims-middleware-<version>-<platform>/
  runtime/node/                 # official Node.js binary for the pinned LTS version
  app/dist/                     # compiled JS (tsc), no TypeScript on site
  app/node_modules/             # production deps only: npm ci --omit=dev
  app/prisma/                   # schema + migrations (+ engine binary if the Prisma version needs one)
  app/public/                   # Bootstrap, CSS, JS, fonts (no CDN)
  app/views/                    # Handlebars templates
  config/                       # example config with comments, JSON schema for editors
  service/                      # WinSW XMLs + exe (Windows) or systemd units (Linux)
  scripts/                      # install, upgrade, verify, backup, restore, diag
  sbom.cdx.json                 # CycloneDX SBOM
  licenses/                     # third-party licence texts
  SHA256SUMS + SHA256SUMS.sig
```

Build rules:

* `npm ci` from the committed lockfile on the builder; `--omit=dev` for the
  shipped `node_modules`.
* Native modules: only prebuilt binaries for the exact target are included;
  the builder fails if `@serialport/bindings-cpp` has no prebuild for the
  target, rather than compiling.
* Reproducible: pinned Node and npm versions, `SOURCE_DATE_EPOCH`, sorted
  archive entries; two builds of the same commit must produce identical
  checksums (checked in CI).
* Windows: an MSI (WiX Toolset) wrapping the bundle, Authenticode-signed.
  Linux: a signed tarball (optionally RPM/DEB later).

## 3. Installation (Windows)

1. Verify the installer signature and `SHA256SUMS`.
2. Run the MSI as administrator. It:
   * installs to `C:\Program Files\LIMS Middleware\<version>\` and points
     `C:\Program Files\LIMS Middleware\current` to it;
   * creates data dirs `C:\ProgramData\LIMS Middleware\{config,logs,archive,secrets}`
     with ACLs for the service accounts only;
   * registers WinSW services `lims-web`, `lims-jobs`, and one
     `lims-analyzer-<id>` per instrument in config (each as a virtual service
     account), startup type Automatic (Delayed Start), recovery "restart
     after 5 s, 10 s, 30 s";
   * does **not** start services yet.
3. PostgreSQL: either (a) run the bundled PostgreSQL vendor installer
   (signed, offline) or (b) provide connection details for an existing
   instance. Run `scripts\db-bootstrap.ps1` to create roles and the database
   (needs a DBA credential once).
4. Store secrets: `lims secrets set DATABASE_URL_APP`, `HMIS_CLIENT_SECRET`, …
5. Edit `config\lims.yaml`; run `lims config validate` (exits non-zero with
   paths of invalid keys).
6. `lims db migrate` (uses `lims_owner` once, then the credential is removed).
7. Install the HTTPS certificate (PFX from the hospital CA) and set its path
   or thumbprint in config.
8. `lims verify` (see §4), then start services.

## 4. Installation (Linux)

1. Verify signature and checksums; extract to `/opt/lims/<version>`, symlink
   `/opt/lims/current`.
2. `scripts/install.sh` creates user `lims-svc` (no shell), dirs
   `/etc/lims`, `/var/lib/lims`, `/var/log/lims`, and installs units:

```ini
# /etc/systemd/system/lims-analyzer@.service
[Unit]
Description=LIMS analyzer link %i
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=lims-svc
Group=lims-svc
SupplementaryGroups=dialout
WorkingDirectory=/opt/lims/current/app
ExecStart=/opt/lims/current/runtime/node/bin/node dist/apps/analyzer-worker/main.js --instrument %i
LoadCredential=database_url:/etc/lims/secrets/database_url_link
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/lims /var/log/lims
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

   `lims-web.service` and `lims-jobs.service` are similar. Enable instances
   with `systemctl enable --now lims-analyzer@e411-01`.
3. Steps 3 to 8 as for Windows (shell equivalents).

### 4.1 Verifying the native serial module on the target

`lims verify` runs, on the target server itself:

* Node version and architecture match the bundle manifest;
* `require('@serialport/bindings-cpp')` loads and `SerialPort.list()` returns
  without error (lists COM ports or `/dev/tty*`);
* if a loopback plug or device server test port is available, opens it and
  writes/reads a test pattern;
* Prisma client connects and `SELECT 1` works with each DB role;
* certificate files are readable, not expired, and match the key;
* config validates; required secrets are present (names only printed).

Output is saved to `/var/log/lims/verify-<timestamp>.txt` for the
validation file.

## 5. Ports

| Port | Direction | Purpose |
|---|---|---|
| 443/tcp (configurable) | lab PCs → middleware | UI, API |
| 443/tcp | HMIS → middleware (only if webhooks) | Webhooks |
| HMIS port | middleware → HMIS | API calls |
| 5432/tcp | middleware → PostgreSQL | if remote |
| Device server ports (e.g. 4001, 4002) | middleware → device server | e 411 and c 111 via RS-232 bridges |
| Mindray port (B-4) | per discovery | HL7 MLLP |
| 636/tcp or 443/tcp | middleware → IdP | LDAPS / OIDC |
| 6514/tcp | middleware → SIEM | audit/syslog over TLS |
| 123/udp | middleware → NTP | time sync (essential for audit) |

## 6. Firewall request template

| Source | Destination | Port | Reason |
|---|---|---|---|
| Lab workstation VLAN | Middleware | 443 | UI |
| Middleware | Device server e411-01 | 4001 (TBC) | e 411 link |
| Middleware | Device server c111-01 | 4002 (TBC) | c 111 link |
| Middleware ↔ Mindray | Mindray IP | TBC (B-4) | HL7 |
| Middleware | HMIS API | TBC (B-6) | orders/results |
| HMIS | Middleware | 443 | webhooks (if used) |
| Middleware | IdP, NTP, SIEM, backup | as above | infra |
| *anything* | Instrument VLAN | * | **deny** |

## 7. Health and diagnostics

* `GET /api/v1/health/live`: process is up.
* `GET /api/v1/health/ready`: DB reachable, migrations at expected version,
  config valid; web only.
* Workers expose readiness to the health table (`health_snapshot`) every
  10 s; the web health page and `lims status` read it.
* `lims diag bundle` collects logs (redacted), config (secrets removed),
  versions, health snapshot, last 1,000 link events, and `verify` output into
  a zip for support. It never includes raw messages unless `--with-raw` is
  given by an admin (audited).

## 8. Backup and restore

* PostgreSQL: nightly `pg_basebackup` + continuous WAL archiving (point-in-time
  recovery), or the hospital's backup agent if it supports PostgreSQL
  consistently. Encrypted. Retain per D-21.
* Also back up: `config/`, `secrets/` (encrypted, separate key custody),
  installer version in use, and audit export files.
* **Restore test monthly** to a separate VM: restore, start services with
  analyzer links **disabled** (config flag) and HMIS delivery **disabled**,
  run `lims verify` and the audit chain check, record the result.
* Restore to production (runbook):
  1. Stop all services. Disable analyzer links and HMIS delivery in config.
  2. Restore DB to the chosen point in time.
  3. Run audit chain verification; record the head hash.
  4. Start web and jobs; check reconciliation screens: results approved
     after the restore point are lost from the DB but may exist in the HMIS
     and on the analyzers; outbox rows may be re-sent (idempotency keys
     protect the HMIS where supported).
  5. Ask the lab to re-send results from analyzers for the gap window.
  6. Re-enable links, then HMIS delivery.

## 9. Upgrade and rollback

1. Read release notes, especially migration notes.
2. Take a backup and verify it (`lims backup verify`).
3. Install the new version side by side (`<new-version>` dir).
4. Stop jobs, web, then analyzer workers (analyzers retry; schedule in a
   quiet period and tell the lab).
5. `lims db migrate` (expand-only migrations, see 06 §3.3).
6. Switch `current` to the new version, start analyzer workers first, then
   jobs, then web. Run `lims verify` and smoke tests.
7. Rollback: because migrations are expand-only, the previous version runs
   against the new schema; switch `current` back and restart. If a release
   is marked "contract migration", rollback means restoring the backup
   (follow §8).

## 10. Patching

* Monthly review of Node.js security releases for the pinned LTS line and of
  `npm audit`/OSV results. A patch release is a full new bundle built in CI;
  no `npm install` on site.
* OS and PostgreSQL patching follow hospital process; the middleware
  tolerates DB restarts (workers reconnect).
* Device server firmware is patched with biomedical engineering, and each
  update is followed by a link test.

## 11. Runbooks (summary)

| Situation | First steps |
|---|---|
| Analyzer link down | Health screen → link status and last error. Check device server reachability (`lims diag tcp <host> <port>`), cable, analyzer "Host Communication" on/off. Check lease conflicts. Restart only that analyzer service. |
| Analyzer shows host communication error | Check the middleware link log for NAK/timeouts and DB health. After fixing, ask the operator to re-send results for the affected period from the analyzer. |
| Results not appearing for review | Inbox age, unmatched results (barcode/mapping), jobs service status. |
| HMIS delivery failing | Failed transmissions screen; classify error; fix credentials/mapping; replay with reason. |
| Ambiguous delivery | Check the HMIS for the result; mark delivered / not delivered (audited). |
| Disk alarm | Identify volume; archive raw messages; extend disk. Never delete DB files manually. |
| Lease conflict | Another copy is running: find it (`lims status` shows owner host:pid), stop it, then the lease expires within 30 s. |
| Wrong mapping discovered | Suspend mapping set (stops new matches → quarantine), create corrected draft, approve, re-process quarantined items, review released results that used the bad mapping and issue corrections. |
