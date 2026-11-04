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

### 2.1 What is built today

`node scripts/build-bundle.mjs --node-dist <extracted official Node.js>`
builds the bundle for the platform it runs on. CI (`bundle` job) downloads
the Node.js release, checks it against nodejs.org `SHASUMS256.txt`, builds
the bundle twice and requires identical checksums, then installs it from
the archive and runs `lims db migrate`, `lims-web create-user`, `lims verify`
and the web readiness check against PostgreSQL.

| Item | Status |
|---|---|
| `runtime/node`, production `node_modules` (no symlinks), Prisma client and engines, migrations, views, Bootstrap | built |
| `service/` systemd units, `scripts/install.sh`, `bin/lims`, `bin/lims-web` | built, installed in CI |
| `service/` WinSW XMLs, `scripts/install.ps1`, `bin\lims.cmd` | written, **not yet run on Windows** |
| `sbom.cdx.json` (from the lockfile), `licenses/`, `manifest.json`, `SHA256SUMS` | built |
| Linux `.tar.gz` with sorted entries and fixed times | built, reproducible |
| `SHA256SUMS.sig` | manual step with the release key (not held by CI) |
| WinSW executable | not built here: pass `--winsw` with a copy whose checksum was checked against its release page |
| MSI (WiX), Authenticode signing | not built yet |
| Bundled PostgreSQL installer | not included; use the vendor's signed installer or an existing instance |

Paths inside the bundle: entry points are
`app/node_modules/@lis/<package>/dist/main.js`; the database credential is
read from the systemd credential `database_url` (Linux), from the file in
`DATABASE_URL_FILE` (Windows: `C:\ProgramData\LIMS Middleware\secrets\database_url`),
or from `DATABASE_URL` (development only; `lims verify` warns).

`lims` commands built: `verify [--out <dir>]`, `status`, `db migrate`,
`config validate`, `secrets set <name>`, `diag tcp <host> <port>`,
`diag bundle`, `backup create`, `backup verify`, `version`. Settings are
environment variables (`/etc/lims/lims.env`, or the `<env>` entries of each
WinSW XML), not `lims.yaml`.

* `lims config validate [--env-file <file> | --service-dir <dir>]` reads the
  settings each service will start with (by default `/etc/lims/lims.env`, or
  every `service\lims-*.xml` of the installed version on Windows). It fails
  on unknown `LIMS_` keys (with the likely intended name), on values the
  services would misread (`True` instead of `true`, a bad port), on
  `LIMS_INSECURE_COOKIES=true` with a non-loopback address, on a missing
  credential or CA file, and runs the web service's own hospital sign-in
  check. It warns on secrets kept in the settings, `NODE_ENV` not
  `production`, a non-loopback `BIND_HOST`, and `LIMS_TWO_PERSON_RULE=false`.
  Secret values are never printed. `lims verify` includes its summary.
* `lims secrets set <name>` stores `database_url` or `oidc_client_secret` in
  the secrets folder the installer made (`/etc/lims/secrets`, root only,
  mode 0600; `C:\ProgramData\LIMS Middleware\secrets`, readable by the
  services and administrators). The value is piped in or typed without
  being shown, never given on the command line; the file is replaced whole.
  Restart the services that read it afterwards.

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
4. Store secrets: `lims secrets set database_url` (and
   `oidc_client_secret` if hospital sign-in uses a confidential client).
5. Edit the `<env>` entries in `service\lims-*.xml`; run
   `lims config validate` (exits non-zero and names each problem).
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
ExecStart=/opt/lims/current/runtime/node/bin/node node_modules/@lis/analyzer-worker/dist/main.js --instrument %i
LoadCredential=database_url:/etc/lims/secrets/database_url
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
* `GET /api/v1/health/ready`: DB reachable and every migration this build
  ships is applied (built; settings are checked by `lims config validate`
  and `lims verify`, not by this endpoint).
* `GET /health`: database answers (built, for simple monitors).
* Workers expose readiness to the health table (`health_snapshot`) every
  10 s; the web health page and `lims status` read it.
* `lims diag bundle [--out <dir>] [--log-dir <dir>]` (built) writes one
  `.tar.gz` (Windows 10 and later open it with `tar -xzf`) holding the
  `verify` and `status` reports, the settings with secret values removed,
  and recent logs (the last 48 h of the `lims-*` units from journald on
  Linux; the newest 20 log files in `C:\ProgramData\LIMS Middleware\logs`,
  last 5 MB each, on Windows), with URL passwords, bearer tokens and
  secret-named JSON fields removed. A README inside lists what was included
  and what could not be collected. It never includes raw instrument
  messages. Logs can still hold specimen or patient identifiers from error
  messages, so the file is mode 0600 and goes only to support under the
  hospital's data agreement. Not built: health snapshot and link-event
  extracts, `--with-raw`.

## 8. Backup and restore

* PostgreSQL: nightly `pg_basebackup` + continuous WAL archiving (point-in-time
  recovery), or the hospital's backup agent if it supports PostgreSQL
  consistently. Encrypted. Retain per D-21.
* Also back up: `config/`, `secrets/` (encrypted, separate key custody),
  installer version in use, and audit export files.
* **The middleware's own backup (built):** `lims backup create --out <dir>`
  writes `lims-backup-<time>.dump` (PostgreSQL custom format, no owners or
  grants) and a `.json` manifest: the SHA-256 of the dump, row counts of the
  main tables, the audit chain head, the applied migrations and the bundle
  version. The dump and the manifest come from one database snapshot, so
  they agree even while the services run, and the backup itself is recorded
  in the audit trail (`backup.create`) before the snapshot. It needs the
  PostgreSQL client tools of the server's major version (`pg_dump`,
  `pg_restore`; found on `PATH`, under `C:\Program Files\PostgreSQL\<n>\bin`,
  or given with `--pg-bin`). The dump holds patient data: keep it with the
  same protection as the database. It is for upgrades and hand-offs, and
  does not replace the hospital's nightly backup and WAL archiving (D-21).
* `lims backup verify <dump>` checks the file against its manifest and that
  `pg_restore` can read it. With `--scratch-url-file <file>` (a file holding
  the address of an **empty** scratch database, so its password is not on
  the command line) it restores there, then checks the migrations, the
  audit chain, its head against the manifest, and the row counts. It refuses
  any database that already has tables, so a live database is never written
  to. Afterwards it empties the scratch database again (`--keep` leaves the
  data, which includes patient data). `--out <dir>` saves the report.
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
2. Take a backup and verify it: `lims backup create --out <dir>`, then
   `lims backup verify <dump> --scratch-url-file <file>` against an empty
   scratch database (§8).
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

Web service (`lims-web`):

| Setting | Default | Notes |
|---|---|---|
| `DATABASE_URL` or `$CREDENTIALS_DIRECTORY/database_url` | required | same as the other services |
| `BIND_HOST`, `PORT` | `127.0.0.1`, `3000` | the reverse proxy (§4) terminates TLS and forwards here |
| `LIMS_TWO_PERSON_RULE` | `true` | reviewer and approver must differ (10 §2) |
| `LIMS_INSECURE_COOKIES` | `false` | `true` drops the cookie `Secure` flag and HSTS; only for a loopback-only test setup |

Hospital sign-in (OIDC, 10 §3). Leave `LIMS_OIDC_ISSUER` unset for local
accounts only. Once it is set, the service refuses to start until the other
required settings are valid.

| Setting | Default | Notes |
|---|---|---|
| `LIMS_OIDC_ISSUER` | unset | the IdP's issuer address, `https://` only; everything else about the IdP is read from its discovery document |
| `LIMS_OIDC_CLIENT_ID` | required | the client registered at the IdP for the middleware |
| client secret | none (public client, PKCE only) | systemd credential `oidc_client_secret` (Linux), the file in `LIMS_OIDC_CLIENT_SECRET_FILE` (Windows), or `LIMS_OIDC_CLIENT_SECRET` (development) |
| `LIMS_OIDC_REDIRECT_URI` | required | `https://<middleware address>/login/oidc/callback`, exactly as registered at the IdP |
| `LIMS_OIDC_ROLE_MAP` | required | `Group=role[,role];Group=role`. Groups are as the IdP sends them (names, paths such as `/LIMS-Admins`, or object IDs). Someone with no mapped group cannot sign in |
| `LIMS_OIDC_GROUPS_CLAIM` | `groups` | ID-token claim holding the groups |
| `LIMS_OIDC_USERNAME_CLAIM` | `preferred_username` | lower-cased; e-mail style names are allowed |
| `LIMS_OIDC_DISPLAY_NAME_CLAIM` | `name` | |
| `LIMS_OIDC_SCOPES` | `openid profile` | add whatever scope the IdP needs to put groups in the ID token |
| `LIMS_OIDC_PROMPT_LOGIN` | `true` | ask for the password at every sign-in, because lab workstations are shared; `false` allows silent SSO |
| `LIMS_OIDC_LABEL` | `hospital account` | text on the sign-in button |

What to ask hospital IT for when registering the client (D-19): the
authorization code flow with PKCE (S256); the redirect URI above; the groups
in the **ID token** (the middleware does not call the userinfo endpoint);
`auth_time` in the ID token and support for `prompt=login` with `max_age=0`,
because approve, release, correct and account changes are confirmed by a
fresh sign-in at the IdP. Where the IdP's certificate is from the hospital
CA, set `NODE_EXTRA_CA_CERTS` to that CA's PEM file for `lims-web`. On Linux,
add the secret with `systemctl edit lims-web` and a line
`LoadCredential=oidc_client_secret:/etc/lims/secrets/oidc_client_secret`
(the shipped unit does not name it, because systemd refuses to start a unit
whose credential file is missing). Keep at least one local administrator
for break-glass use when the IdP is down.

First administrator, before the hospital IdP is connected (password on
standard input, at least 12 characters, never on the command line):
`lims-web create-user <username> "<display name>" admin < password-file`.
An account cannot create itself or grant itself roles, and every account
change is in the audit trail. `GET /health` answers `{"status":"ok"}` when
the database answers, and nothing more, so the service monitor can poll it
without a session.


Analyzer worker exit codes (`lims-analyzer-worker --instrument <id>`):

| Code | Meaning | Action |
|---|---|---|
| 0 | Stopped by the service manager | none |
| 2 | Not configured: unknown instrument, no active connection, or invalid config | fix the registration (W-11); the service restarts and fails again until fixed |
| 3 | Lease held by another worker | find the other copy (`lims status`), stop it |
| 4 | Lease lost while running (taken over, or database unreachable) | check the database; the service restarts and takes the lease back |
| 5 | Instrument disabled and the worker was told to refuse | enable it, or leave it stopped |


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
