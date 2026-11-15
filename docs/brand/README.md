# LabTrack brand in the app

The screens follow the **SynergyOne Brand Framework** (Synergy Informatics
Limited, November 2026, "working brand standard"). This product is
**SynergyOne LabTrack — Laboratory Information Management System**, endorsed
as "Part of the SynergyOne Suite", tagline "Precision in Every Result."

## What the app uses

| Brand element | Value | Where |
|---|---|---|
| Corporate Navy | `#16345B` | sidebar, headings, report rule and lab name |
| LabTrack Purple | `#7C3AED` | primary buttons, focus ring, current menu item, the "Track" in the wordmark |
| Suite Blue | `#0B65B9` | info badges, the sign-in background glow |
| Off-white | `#F7F9FC` | page background |
| Montserrat (SemiBold/Bold) | `public/fonts/montserrat` | wordmark, page titles, dashboard numbers, sign-in |
| Inter | `public/fonts/inter` | the interface, forms and tables |
| Open Sans | `public/fonts/open-sans` | the printed result report |

All fonts are served from the app (SIL Open Font License, `OFL.txt` beside each),
so the sign-in page and reports work with no internet access. Colours are
defined once as CSS variables at the top of `packages/web/public/theme.css`.

Following section 8 of the framework, the purple accent is kept for actions and
"where you are"; content-heavy screens stay white and navy. Status still never
relies on colour alone (badges carry words).

## Assets

* `public/brand/labtrack-mark.svg`: the LabTrack mark (white flask on a purple
  tile), also the browser tab icon. **Drawn for the app from the framework's
  infographic.** The framework supplies no LabTrack vector file, and it says final
  vector logos are still to be approved (section 10). Swap this file when the
  approved mark exists; nothing else needs to change.
* `public/brand/synergy-informatics.jpg`: the Synergy Informatics corporate
  logo, taken from the approved image in the framework PDF at its original
  proportions and colours. It is a raster copy; replace it with the vector
  original when one is available.
* The wordmark is live text ("Lab" in navy, "Track" in LabTrack Purple; white
  and light purple on navy for the reversed version), so it stays sharp at any size.

## What did not change

* The printed report keeps the **lab's own** letterhead (logo, name, address set
  under Settings, Report header). The product shows only as a small line in the
  footer: "SynergyOne LabTrack · Laboratory Information Management System".
* Technical names (packages `@lis/*`, services `lims-web`, `lims-jobs`,
  `LIMS_*` settings) are unchanged, so existing installs keep working
  (framework section 10, backward-compatible technical references).
* Specimen labels are unchanged: they carry patient and specimen details only.
