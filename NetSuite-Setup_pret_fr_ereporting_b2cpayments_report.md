# NetSuite Setup — pret_fr_ereporting_b2cpayments_report

**Script file:** `pret_fr_ereporting_b2cpayments_report.js`
**Script type:** Scheduled Script (`@NScriptType ScheduledScript`, `@NApiVersion 2.1`)
**Entry point function:** `execute`

---

## 1. Script Record

| Setting | Value |
| --- | --- |
| Name | Pret FR e-Reporting — B2C Payments Report |
| ID | `customscript_pret_fr_ereporting_b2c` (suggested — confirm/adjust to your naming convention) |
| Script File | `pret_fr_ereporting_b2cpayments_report.js` |
| API Version | 2.1 |
| Script Type | Scheduled Script |

---

## 2. Deployment Record

NetSuite's scheduled-script recurrence UI has no "1st/11th/21st of the month" option, so the
deployment must run **Daily**, and the script itself decides whether today is a reporting day
(1st, 11th or 21st) — any other day it logs `PAYMENTS REPORT SKIPPED` and exits immediately
with negligible governance usage.

| Setting | Value |
| --- | --- |
| Deployment ID | `customdeploy_pret_fr_ereporting_b2c` (suggested) |
| Status | Scheduled |
| Log Level | Audit (set to Debug temporarily for detailed tracing — see §5) |
| Recurrence | Daily |
| Start Date/Time | Any time after your NetSuite nightly processes have settled — e.g. 03:00 |
| Repeat | Every 1 day |

---

## 3. Script Parameters (custscript)

Create these on the Script record (Parameters subtab), then set values on the Deployment record.

| Parameter ID | Label (suggested) | Type | Notes |
| --- | --- | --- | --- |
| `custscript_pret_api_url_pr` | Payments Report API URL | Free-Form Text | API endpoint URL the XML is POSTed to |
| `custscript_pret_api_function_key_pr` | Payments Report API Function Key | Free-Form Text | Sent as the `X-Function-Key` header |
| `custscript_pret_api_doc_type_pr` | Payments Report API Doc Type | Free-Form Text | Sent as the `x-pret-document-type` header |
| `custscript_pret_ubl_folder_pr` | Payments Report File Cabinet Folder | Integer | Internal ID of the File Cabinet folder the XML archive is saved to |
| `custscript_pret_today_pr` | Payments Report Test "Today" Override | Free-Form Text | **Test only** — leave blank in production (see §6) |

If `custscript_pret_api_url_pr` / `_function_key_pr` / `_doc_type_pr` are not all set, the script
still saves the XML to the File Cabinet but logs `PAYMENTS REPORT API SKIPPED` instead of sending it.

---

## 4. Saved Search Requirement

| Setting | Value |
| --- | --- |
| Saved Search ID | `customsearch_pret_france_payments_report` |
| Date filter | **None** — the script applies its own `trandate` "within" filter at runtime based on the reporting window (see §6). Do not add a fixed date filter to the saved search itself, or it will silently narrow/exclude rows. |

The script matches columns **by their custom label**, not by internal field ID, so the saved
search's column labels must exactly match these (case-sensitive):

| Custom Label | Underlying Field | Summary | Used for |
| --- | --- | --- | --- |
| `StartDate` | Accounting Period : Start Date | Group | `ReportPeriod/StartDate` (from first result row) |
| `EndDate` | Accounting Period : End Date | Group | `ReportPeriod/EndDate` (from first result row) |
| `PaymentDate` | Date | Group | `Transactions/Payment/Date` |
| `TaxItem` | Tax Item | Group | Not output — read only for grouping |
| `TaxRate` | Tax Item : Rate | Group | `SubTotals/TaxPercent` |
| `CurrencyCode` | Currency | Group | `SubTotals/CurrencyCode` |
| `Amount` | Amount | Sum | `SubTotals/Amount` |

If any of `StartDate`, `EndDate`, `PaymentDate`, `TaxRate`, `CurrencyCode`, `Amount` is missing or
renamed, the script throws `Saved search customsearch_pret_france_payments_report is missing a
column labeled "..."` and logs `PAYMENTS REPORT FAILED` rather than silently producing bad output.

---

## 5. Logging

The script logs at two levels:

- **Audit** (always visible): start/params, resolved window, search start/result count, subsidiary
  loaded, RPT ID, file saved, API call outcome, completion summary.
- **Debug** (only visible when the deployment's Log Level — or the execution log filter — is set
  to Debug): resolved "today", per-page search fetch counts, matched column labels, one line per
  payment row, XML length.

For normal production monitoring, Audit is sufficient. Switch to Debug only while diagnosing a
specific run.

---

## 6. Testing with `custscript_pret_today_pr`

To simulate a 1st/11th/21st run without waiting for the calendar date, set
`custscript_pret_today_pr` on the deployment (or via a manual "Execute Script" test) to any date
in your NetSuite date format, e.g. `11/07/2026`.

- The script computes the reporting window and the `RPT-YYYY-DDMM` report ID **as if** that were
  today's date.
- `IssueDateTime/DateTimeString` in the output XML always uses the real current timestamp
  (it records when the file was actually generated, not the simulated day).
- Leave this parameter **blank** on the production deployment — a non-empty value that isn't a
  valid date logs `PAYMENTS REPORT TODAY PARAM INVALID` and falls back to the real system date.

Reporting windows recap:

| `today` (real or overridden) | Window applied to `trandate` |
| --- | --- |
| 11 | 1st → 10th of the current month (inclusive) |
| 21 | 11th → 20th of the current month (inclusive) |
| 1 | 21st of the previous month → last day of the previous month (i.e. up to but excluding today) |
| any other day | script exits, no report generated |

---
Last updated by Claude — 2026-07-07
