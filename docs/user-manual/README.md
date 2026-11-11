# User manual

This manual is for the people who use the lab middleware's screens every day:
reception and phlebotomy staff, bench technologists, approvers (senior staff
and the lab director), system administrators and auditors. It describes the
screens as they are built today. It is not a design document; for how the
system works inside, see the [design package](../README.md).

> **Before clinical use.** No instrument is cleared for clinical use until it
> has passed its interface test and the lab director has signed lab
> acceptance (see [Approver: instruments](approver.md#clear-an-instrument-for-clinical-use)).
> Until then its results can be seen and worked on, but not released to the HMIS.

## Which chapter is mine?

Every account has one or more **roles**. Your roles are shown under your name
at the top right of every page. Read [Getting started](getting-started.md)
first, then the chapter for each role you hold.

| Role | Who usually has it | Chapter |
|---|---|---|
| **Operator** | Reception, phlebotomy, specimen collection | [Operator](operator.md) |
| **Technologist** | Bench technologists who run tests and check results | [Technologist](technologist.md) |
| **Approver** | Senior technologists, section heads, the lab director | [Approver](approver.md) |
| **Admin** | The system administrator (often hospital IT or the lab's LIS officer) | [Admin](admin.md) |
| **Auditor** | Quality manager, internal or external auditors | [Auditor](auditor.md) |

An approver can do everything a technologist can, and a technologist can do
everything an operator can on the specimen pages, so an approver should read
the operator and technologist chapters as well. Admin and auditor are
separate: an admin cannot review or approve results unless also given the
approver role, and an auditor sees everything but changes nothing.

[Reference](reference.md) lists the result states, the badges you will see,
the steps that need a second person, and common messages.

## What each role can do

Everyone who is signed in can **open and read** the working pages: dashboard,
orders, patients, specimens, results, critical list, QC, catalogue,
instruments, send-outs, turnaround and workload. The table shows who can
**change** things.

| Task | Operator | Technologist | Approver | Admin | Auditor |
|---|:-:|:-:|:-:|:-:|:-:|
| Collect specimens, print and reprint labels, receive specimens | ✔ | ✔ | ✔ | | |
| Register a downtime order (HMIS down) | ✔ | ✔ | ✔ | | |
| Reject a specimen, ask for recollection | | ✔ | ✔ | | |
| Enter manual worksheet results and manual QC | | ✔ | ✔ | | |
| Type in results when an instrument link is down | | ✔ | ✔ | | |
| Review results, add lab comments, record critical calls | | ✔ | ✔ | | |
| Resolve unmatched results (with a second person) | | ✔ | ✔ | | |
| Send tests to referral labs and type in their results | | ✔ | ✔ | | |
| Reconcile downtime orders, match tests added by the lab | | ✔ | ✔ | | |
| Approve, release and correct results | | | ✔ | | |
| Add comments to the printed report | | | ✔ | | |
| Send a failed result to the HMIS again | | | ✔ | ✔ | |
| Set QC ranges, critical limits, reference ranges, delta checks | | | ✔ | | |
| Autoverification rules, standard comments, turnaround targets | | | ✔ | | |
| Propose and approve catalogue changes (different people) | | | ✔ | ✔ | |
| Keep the referral lab list | | | ✔ | ✔ | |
| Record and undo patient merges (with a second person) | | | ✔ | ✔ | |
| Register instruments, edit their settings, draft test mappings | | ✔ | | ✔ | |
| Approve test mappings | | | ✔ | | |
| Record an interface test, suspend or turn off an instrument | | | ✔ | ✔ | |
| Sign lab acceptance, turn an instrument on | | | ✔ | | |
| Download turnaround, workload and QC summary CSV files | | | ✔ | | ✔ |
| Report header (logo, lab details, footer) | | | | ✔ | |
| Manage user accounts and roles | | | | ✔ | |
| Search, export and verify the audit trail | | | | | ✔ |

A person can hold several roles. Give each person only the roles their job
needs.

## Screenshots

The screenshots come from the demo environment ([`demo/`](../../demo/README.md)).
Every patient, account and value in them is made up. Report header, Users
and Audit appear in the menu only for the roles that use them, so your menu
may differ slightly from the pictures.
