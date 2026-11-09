# Demo environment (Docker)

For trying the middleware on one computer. **Not for production and not for
patient data.** Production installs from the offline bundle with no Docker
(design 11 and 13). Every account, password, patient, test code and limit
here is made up.

## What runs

| Service | What it is | Address |
|---|---|---|
| `web` | The middleware's screens | http://localhost:3000 |
| `hmis` | A stand-in HMIS: a page to place orders and see the results sent back, and the FHIR R4 interface the lab proposed (07 §6.6) over https inside Docker | http://localhost:3100 |
| `jobs` | Pulls orders from the stand-in HMIS every 10 seconds and sends released results back | (no page) |
| `db` | PostgreSQL 16 | (inside Docker only) |
| `setup` | One-shot: certificate for the stand-in HMIS, database migrations, demo accounts and tests | (exits when done) |

Both addresses listen on this computer only (127.0.0.1). The stand-in HMIS
follows the lab's proposal, not the hospital's HMIS, which has no test
environment yet. No instrument is connected; tests are entered on the manual
worksheet.

## Start, stop, reset

From the repository root, with Docker Desktop (or Docker Engine with Compose) running:

```sh
docker compose -f demo/compose.yaml up -d --build   # first start takes a few minutes
docker compose -f demo/compose.yaml ps              # setup shows "exited (0)", the rest "running"
docker compose -f demo/compose.yaml logs -f jobs    # watch orders arrive and results go out
docker compose -f demo/compose.yaml down            # stop, keeping the data
docker compose -f demo/compose.yaml down -v         # stop and delete all demo data
```

Ports 3000 and 3100 must be free.

## Accounts

All use the password `demo-password-1` (set `DEMO_PASSWORD` before the first
start to change it).

| User | Role |
|---|---|
| `admin` | administrator |
| `tech` | technologist |
| `approver1`, `approver2` | approver (two, for the two-person steps) |
| `auditor` | auditor |

## Demo tests

| HMIS code | Lab test | Result |
|---|---|---|
| `32700-7` | MAL-RDT malaria rapid test | Negative, P. falciparum positive (**critical**, to show the call), Invalid |
| `MAL-DENS` | malaria parasite density | number, /uL |
| `U-PROT` | urine protein, dipstick | Negative, Trace, 1+, 2+, 3+ (1+ and above abnormal) |

The call target for critical results is 30 minutes. None of this is the lab's
policy.

## A walk-through

1. Open http://localhost:3100, tick a test or two and place an order.
2. Sign in to http://localhost:3000 as `tech`. Within about 10 seconds the
   order is under **Orders**. Collect the specimen (print the label if you
   like), then receive it in the lab.
3. **Worksheet**: enter the result. A positive malaria test is critical: it
   shows on the dashboard and the **Critical** page; record the call on the
   result page.
4. Review as `tech`, then sign in as `approver1` to approve and release
   (the approver must be a different person, and re-enters their password).
5. Back on http://localhost:3100 the result appears under **Results received
   from the LIMS** within about 10 seconds.

Cancelling an order on the stand-in HMIS sends the cancellation in the feed.
