# Auditor

[← User manual](README.md)

Auditors (the quality manager, internal and external auditors) can open
every working page to read it, search and export the audit trail, check
that the trail is intact, and download report data. They cannot change
anything else: no results, specimens, settings or accounts.

## What you can read

Everything in the menu is open to you: orders, patients and their
cumulative results, specimens and their history, results with every
version, decision, critical call and comment, QC logs and charts, the
catalogue and its versions, instruments with their verification history,
send-outs with their papers, and the settings pages (QC ranges, critical
limits, reference ranges, delta checks, autoverification, turnaround
targets) with their sources and retired entries. Retired settings stay
listed with who retired them, when and why.

## Download report data

Approvers and auditors can **Download CSV** from:

* **Quality → Turnaround** (the figures for the chosen days and filters);
* **Quality → Workload**;
* **Quality → QC → QC summary**.

Each download is itself recorded in the audit trail.

## The audit trail

**Administration → Audit** (auditors only).

Every action that changes data is recorded: who did it, when, what it was
before and after, and the reason when one was given. Sign-ins, step-up
confirmations, report views and exports are recorded too. Events are
chained by hashes, so an event changed, removed or inserted outside the
application breaks the chain.

### Search

Narrow the events by:

* **Entity** (for example `result`, `specimen`, `app_user`, `instrument`) and
  its **ID**;
* **Actor** (the username, or `system:…` for automatic steps);
* **Action**: a full name such as `result.release`, or a group ending with a
  dot, such as `result.` for every result action or `user.` for every
  account change;
* **From** and **To** days, in the lab's time zone.

Events are listed newest first, with **Older events →** at the bottom. Some
useful actions:

| Action | What it records |
|---|---|
| `result.enter`, `result.transcribe`, `result.referral-entry` | A value entered by hand, typed from a printout, or from a referral lab's report |
| `result.critical-call` | A critical result phoned and read back |
| `result.release`, `result.autoverify` | Release to the HMIS; approval by a rule |
| `specimen.rejected` | A specimen rejected, with the reason |
| `unmatched.link-proposed`, `unmatched.link-confirmed` | The two halves of a two-person link |
| `catalogue.propose`, `catalogue.approve` | A catalogue change and its approval |
| `mapping.draft`, `mapping.approve-activate` | Instrument test mappings |
| `patient.merged`, `patient.unmerged` | Patient merges and their undoing |
| `report-header.update`, `report-header.logo` | Changes to the printed letterhead |
| `user.create`, `user.roles`, `user.password-reset`, `user.unlock` | Account administration |
| `auth.login`, `auth.step-up` | Sign-ins and password re-confirmations |
| `order.report-viewed` | Someone opened an order's printable report |
| `report.turnaround-export` and similar | A CSV download |

The result page's **History** and the user page's **Account history** show
the same events for one item.

### Export

**Export events** downloads the events matching your search as a JSON lines
file, oldest first, each with its hashes, followed by a manifest. One export
holds at most 50,000 events; narrow the dates or filters for more.

If the hospital has set an audit signing key, the page says *Exports are
signed with key …*. Download the **public key** and give it with the export
to whoever checks it; the command `lims audit verify-export` checks the file
with it. If the page says *Exports are refused*, hospital IT must fix the
signing key. If no key is set, exports still carry hashes and a manifest
but no signature.

### Verify the chain

**Verify the whole chain now** reads every event and checks the hashes. On a
large trail it can take a while. The result is shown at the top of the page
(*Chain last verified … all intact*) and recorded as an event itself.

If the page shows **Audit chain verification failed**, an event was changed,
removed or inserted outside the application. Report it to the lab director
and hospital IT security at once.
