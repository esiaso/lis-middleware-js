# Reference

[← User manual](README.md)

## Result states

| State shown | Meaning | Next step, by whom |
|---|---|---|
| **To review** | A value has arrived (instrument, worksheet, typed in) | Mark reviewed: technologist or approver |
| **To approve** | Reviewed, waiting for an approver | Approve: approver (not the reviewer, with the two-person rule) |
| **Approved, not released** | Approved by a person or by an autoverification rule | Release to HMIS: approver |
| **Waiting to send** | Released, in the queue for the HMIS | None; the middleware sends it |
| **Sent, awaiting HMIS** | Delivered, waiting for the HMIS to confirm | None |
| **Confirmed by HMIS** | The HMIS has accepted it | Correct, if it was wrong: approver |
| **Delivery failed** | The HMIS refused it, or every try failed | Send again: approver or admin |

A result can also be **held** from the HMIS even when approved:

| Held because | How it is cleared |
|---|---|
| The instrument is **not for clinical use** | Interface test, lab acceptance and turning on (approver) |
| It is on a **downtime order** | Reconcile the order to the HMIS order (technologist or approver) |
| It is a **test added by the lab** | Match it to the clinician's HMIS order line (technologist or approver) |
| It is **critical** and not yet called | Record the call (technologist or approver) |

## Badges and marks

| Badge | Meaning |
|---|---|
| **STAT** (red) | Urgent order or specimen; shown first in work lists |
| **critical** (red) | Crosses a critical limit, or a critical answer; must be phoned before approval |
| **called** | The critical call for that version is recorded |
| **delta** (amber) | Changed more than the lab's delta rule allows since the last approved result |
| **delta not checked** | No earlier result to compare, or units differ |
| **limit not checked: units differ** | The instrument's units differ from the limit's units; compare by hand |
| **needs attention** | Something about the result needs a person, such as a new value after approval |
| **autoverified** (green) | Approved by the lab's rule; still released by a person |
| **typed in from the printout** | Entered on the Instrument down page |
| **typed in from their report** | Entered from a referral lab's report |
| **QC missing for the lot** / **QC failed for the lot** / **QC lot past expiry** | A manual result saved without a passing, in-date control on its lot |
| **not mapped** | The test has no instrument mapping yet |
| **provisional** | A patient or order registered by hand during HMIS downtime |
| **downtime** | An order registered by hand during HMIS downtime |
| **reconciled** | A downtime record joined to the HMIS order or patient |
| **link proposed** | An unmatched result waiting for a second person |
| **not for clinical use** | The instrument is not cleared; its results cannot be released |
| **overdue** | Past its turnaround target (result) or its referral lab's turnaround (send-out) |

On the patient's cumulative results, values in *italics* are not yet
approved. On the printed report, only approved results carry a value.

## Steps that need a second person

The middleware refuses these if the same person tries both halves. The
first person can withdraw a proposal before it is confirmed.

| First person | Second person (must be different) |
|---|---|
| Reviews a result | Approves it (when the two-person rule is on, the usual setting) |
| Performs a manual worksheet test | Approves the result |
| Types in results from an instrument printout | Approves them, checking against the printout |
| Types in results from a referral lab's report | Approves them, checking against the report |
| Proposes a link for an unmatched result | Confirms the link |
| Proposes adding a test to an order | Confirms the added test |
| Proposes a catalogue change | Approves it |
| Saves a draft of instrument test mappings | Approves and makes it active |
| Proposes a patient merge, or its undoing | Confirms it |
| (Admin) changes an account | Another admin changes the first admin's own account |

## Common messages

| Message | What to do |
|---|---|
| *Your session has ended. Sign in again.* | You were idle for 15 minutes or signed in for 12 hours. Sign in again. |
| *Choose your own password before doing anything else.* | Replace the temporary password on the Change password page. |
| *The form has expired. Go back, reload the page and try again.* | The page was open from an earlier session. Reload it. |
| *Your account does not have permission for this.* | The step belongs to another role. Ask a colleague who has it. |
| *Someone else changed this result while you were looking at it.* | Reload and check the result before trying again. |
| *Not saved: …* | The form had a problem, listed after the colon. Fix it and save again. |
| *… does not approve it; another person checks it …* | You entered or reviewed this result; another person must approve it. |
| *this is a critical result …; record who was told, with read-back …* | Record the critical call first. |
| *tests needing different specimen types go in separate containers* | Collect each specimen type separately. |
| *Lab acceptance is signed by an approver (lab director).* | Ask the lab director to sign. |

## Glossary

| Term | Meaning |
|---|---|
| **Accession number** | The lab's number for one specimen container, printed as a barcode on its label |
| **MRN** | The patient's medical record number in the HMIS |
| **HMIS** | The hospital's information system, which sends orders and receives results |
| **HMIS order** | The order as placed by the clinician in the HMIS |
| **Downtime order** | An order registered by hand in the middleware while the HMIS was down |
| **Unmatched result** | An instrument result that could not be attached to an order |
| **Mapping** | The link between an instrument's test code and a test in the lab's catalogue |
| **Lab acceptance** | The lab director's signed decision, after a parallel run, that an instrument may be used clinically |
| **Autoverification** | Approval of a result by a validated lab rule instead of a person |
| **Delta check** | Comparison of a new value with the patient's previous approved result |
| **Send-out** | A specimen package sent to a referral lab for one or more tests |
| **Turnaround (TAT)** | The time a stage takes, for example from receipt in the lab to release |
| **Step-up** | Re-confirming who you are (password or hospital sign-in) before an important action |
