# AP JSON → Vendor Bill Integration (NetSuite RESTlet)

Inbound integration: an external AP system sends JSON to NetSuite to create Vendor Bill records.

## Architecture decisions (confirmed 2026-07-16)
- Transport: **RESTlet** (chosen over SuiteTalk REST Record API and Map/Reduce staging) — allows custom mapping/validation logic before bill creation.
- Auth: OAuth2 already configured and confirmed working via Postman.
- Idempotency: a custom UUID field on the NetSuite Vendor Bill record, matched against a `resourceId` field in the incoming JSON (e.g. `"resourceId": "c0b6ba79-aab6-4880-a052-b950a0a38ebe"`) — used to detect/reject duplicate submissions on retry.
- Response: RESTlet must return a status response to the external AP system (success/failure + created bill internal ID).
- Approval routing: NetSuite already has vendor bill approval workflows in place — new externally-created bills should flow through existing routing, not bypass it.
- Field/line mapping (PO-matched vs expense-coded, tax code mapping) is still pending — to be defined once a test JSON payload is received from the AP system.
- Rollout process: build and test in Sandbox first; move to Production only after sign-off.

Note: this is the reverse direction from the existing NetSuite → Basware outbound UBL XML webhook integration — unless confirmed otherwise, this may be a different external AP system entirely.

## Proposed RESTlet flow (drafted 2026-07-16, not yet implemented)
1. Parse incoming JSON body.
2. Validate required fields (vendor ref, resourceId, lines, amounts) — return error status immediately if missing.
3. Idempotency check: search a custom field (e.g. `custrecord_ap_resource_id`) on vendorbill for a match on `resourceId` — if found, return existing internal ID without creating a new record.
4. Resolve vendor by externalId or a code-to-internal-ID mapping — error status if not found.
5. Build the vendorbill record: entity, subsidiary, tranDate, currency, custom UUID field = resourceId, line sublist (item or expense — mapping pending), tax codes (mapping pending).
6. Save inside try/catch.
7. Return status response: `{ success, internalId, resourceId, message }`.

## Test JSON payload received (2026-07-17)

**Source confirmed: this is Basware**, not a separate AP system — the payload references `test-api.basware.com/v2/files/...`, and the shape is Basware's "BUM" JSON model (UBL-derived field names: `accountingSupplierParty`, `legalMonetaryTotal`, `orderReference`, etc.). Same vendor as the outbound UBL XML webhook, opposite direction.

Top-level shape:

- `bumId` (UUID) — **this is the idempotency key**, not a generic `resourceId` field as originally assumed. Update the custom UUID field match to use `bumId`.
- `fileRefs` / `links` — pointer back to the original source file (image/PDF) on Basware's file API, likely just for reference/audit, not needed for bill creation.
- `origin` — provenance metadata (source system, channel, validation applied) — probably logged, not mapped to a field.
- `data` — the actual document content (invoice/UBL-style fields), see below.

### Draft field mapping (from this sample)

| JSON path | Sample value | Likely NetSuite target | Notes |
| --- | --- | --- | --- |
| `data.externalDocumentIdentifier.id` | `PRETRECEIVINGTEST` | vendorbill `tranId`/external doc ref | vendor's invoice number |
| `data.issueDate` | `2026-02-01` | `trandate` | |
| `data.documentCurrencyCode` | `EUR` | `currency` | |
| `data.accountingSupplierParty.partyIdentifications[].id` (schemeId `FR:SIRET`) | `10291445400001` | vendor lookup key | **no NetSuite internal ID sent** — vendor must be resolved via SIRET (or VAT, `partyTaxScheme.company.id`) lookup table |
| `data.accountingCustomerParty.endpoint.id` | `533214003` | subsidiary/entity resolution? | Pret's own buyer ID as Basware sees it — may need a mapping to NetSuite subsidiary if Pret has more than one FR entity |
| `data.orderReference.id` / `customFields["Po-Number"]` | `PO00000001` | PO match | see contradiction below |
| `data.taxTotal.taxSubtotals[].taxCategory.id` | `Z` (zero-rated) | tax code | reuses the same S/Z/E/AE mapping table still pending for the outbound project |
| `data.legalMonetaryTotal.payableAmount.amount` | `10000.00` | bill total | |
| `data.invoiceLines[].item.sellersItem.id` | `0987` | line item code | vendor's own item code, not a NetSuite item ID |
| `data.invoiceLines[].quantity.unitCode` | `ZZ` (UN/ECE "mutually defined") | UOM | ambiguous — needs a fallback/default |
| `data.paymentMeans` (IBAN, BIC, due date) | — | ? | vendor banking should already live on the vendor record — confirm whether this is stored or ignored |
| `data.customFields[]` (10 entries) | — | ? | need per-field disposition: keep, map, or ignore |

### Contradictions / things to flag back to Basware or Pret before finalizing mapping

1. `isIssuedAgainstOrder: false` **but** `orderReference.id` is populated (and repeated in `customFields["Po-Number"]` and the line's `orderLineReference`). Need to confirm what `isIssuedAgainstOrder` actually gates — is PO info here just informational, or should PO-matched vs. expense-coded logic key off something else?
2. `documentTypeCode` custom field = `380` (commercial invoice per UNTDID 1001), but several fields read like delivery-note data, not invoice data: `note: "AVISLIVRAISON_001"` (French for delivery note), `PL-WZNumber`, `transDocNo: "BON_RECEPT_001"` (receipt note), `BW-0000160: "PRIVATE_ID_DELIVERY"`. Worth confirming this test payload is genuinely meant to create a Vendor Bill, since the content looks like it may be goods-receipt/delivery metadata attached to an invoice header.
3. `customFields["exchangeRate"]` is empty in this sample — confirm if/when it's populated, and whether NetSuite needs it (multi-currency bill vs. subsidiary base currency).

## Open questions (updated 2026-07-17)

1. ~~Vendor resolution~~ — partially answered: no internal ID sent, must resolve via SIRET or VAT lookup table. Still need: is SIRET guaranteed 1:1 with a NetSuite vendor record, and which field should the lookup key on?
2. PO vs expense-coded — payload includes PO fields even with `isIssuedAgainstOrder: false` (see contradiction #1 above) — needs clarification from Basware/Pret on what this flag actually means for matching logic.
3. Status response contract — still not defined by this payload (it's the inbound request only) — still ours to define unless Basware has a contract already.
4. New: subsidiary/entity resolution — does `accountingCustomerParty.endpoint.id` reliably map to a specific NetSuite subsidiary, or is Pret single-subsidiary for this flow?
5. New: which of the 10 `customFields` entries are required on the Vendor Bill vs. safe to ignore?

## Decisions (confirmed 2026-07-17)

1. **Standalone (non-PO) bills are valid.** `isIssuedAgainstOrder: false` with no PO is an expected, supported case — not an error. Create the vendorbill with **status = Pending Approval** and let it flow through NetSuite's existing approval workflows/scripts as normal (i.e. don't set/force an approved status, don't bypass routing).
2. **Idempotency key = `bumId`** (confirmed UUID) — match this against the custom UUID field on vendorbill, per the earlier idempotency design.
3. **Vendor resolution key = SIRET.** Match `data.accountingSupplierParty.partyIdentifications[]` where `schemeId = "FR:SIRET"` against the vendor record. The outbound UBL mapping uses `custentity_pret_siret` for this SIRET on **Customer** records ([UBL-NetSuite-Field-Mapping.csv:45](UBL-NetSuite-Field-Mapping.csv#L45)) — needs confirming whether the same field is also enabled on **Vendor** records, or if vendors use a different/separate SIRET field.

## Values needed to build a Postman test payload (standalone, non-PO scenario)

1. ~~SIRET of an existing Sandbox test vendor~~ — **resolved (2026-07-17)**: vendor "Pret Dummy Supplier" (internal ID 108053, entity `V00008530`), `custentity_pret_siret = 78451296875008`, confirmed present and populated on the Vendor record (so vendors do carry this same custom field as Customers). Subsidiary = 16 (Pret FR), currency = EUR — matches the outbound project's FR subsidiary.
2. ~~GL account or item for the line item~~ — **resolved (2026-07-17)**: no GL account is set at all — lines use the `item` sublist, and account + tax code default from the resolved Item's own settings.
3. **Item resolution key = `itemid`.** `data.invoiceLines[].item.sellersItem.id` (e.g. `"0987"`) is matched against the Item record's own `itemid` field — same lookup pattern as the vendor SIRET match. Still needed: an actual Item in Sandbox with `itemid = "Uniforms"` for this test payload to resolve successfully.
4. ~~Subsidiary~~ — resolved: derived from the resolved vendor's `subsidiary` field (16), no explicit subsidiary field needed in the JSON.

## Test payload

[AP-JSON-Test-Payload-Standalone.json](AP-JSON-Test-Payload-Standalone.json) — standalone/non-PO scenario. Kept as close as possible to the originally-provided sample values rather than inventing new test data; only what's structurally necessary was changed:

- `bumId` regenerated per test run (currently `8b7d89cd-b1bb-4f5c-90f0-ca2682405f1f`) — needs to be unique per idempotency design; regenerate again before each fresh POST.
- `accountingSupplierParty` replaced with the real Sandbox vendor's data (SIRET `78451296875008`, VAT `FR11223344556`, address, contact) — everything else (amounts, dates, note, customFields, delivery block, `accountingCustomerParty`) restored to the original sample's values, including the 10000.00 EUR total and the `PL-WZNumber`/`transDocNo`/`BW-0000160` fields flagged earlier as delivery-note-flavoured (kept per the original sample rather than trimmed).
- Removed only `orderReference`, `contractDocumentReferences`, `customFields["Po-Number"]`, and the line's `orderLineReference` — these are PO-specific and would contradict the standalone/non-PO scenario this payload is meant to exercise (decision #1).
- `invoiceLines[].item.sellersItem.id` set to `"Uniforms"` (with matching `item.name`/`description`) — needs an Item in Sandbox with `itemid = "Uniforms"` for the RESTlet to resolve it (see #3 above).

Expected result once the RESTlet exists: vendor resolves via SIRET to internal ID 108053, subsidiary 16, and the created vendorbill should land in **Pending Approval** status per decision #1.

## RESTlet drafted (2026-07-17)

[pret_fr_ap_vendorbill_rl.js](pret_fr_ap_vendorbill_rl.js) — implements the standalone/non-PO path only (PO-matched bills return a "not yet supported" response). Matches this project's existing SuiteScript conventions (see `pret_fr_evendorcredit_ue.js`): step-numbered `log.audit`, try/catch around the whole `post`.

**Before this can be deployed and tested against the real endpoint, still need:**

1. ~~Create custom body field for the idempotency key~~ — **resolved (2026-07-17)**: already exists as `custbody_pret_uuid` (same field `pret_fr_evendorcredit_ue.js` uses for its own UUID). Script updated to reference it.
2. ~~Confirm the "Pending Approval" approvalstatus ID~~ — **resolved (2026-07-17)**: not needed. New vendor bills fall to Pending Approval by default under this account's approval routing, so the script no longer sets `approvalstatus` explicitly.
3. ~~GL account / tax code script parameters~~ — **resolved (2026-07-17)**: not needed. Lines use the `item` sublist (not `expense`), so account and tax code default from the resolved Item's own settings — no explicit `account`/`taxcode` set, no script parameters. `taxitem` (a Vendor-level field) is a possible manual-override fallback if this ever proves insufficient, but not implemented now.
4. **An Item in Sandbox with `itemid = "Uniforms"`** (or whatever code the real test payload uses) — the script resolves `invoiceLines[].item.sellersItem.id` against the Item record's `itemid` field; without a match, bill creation fails.
5. Deploy the script as a RESTlet (script + deployment record) — no parameters to configure.
6. Once deployed, Postman needs to hit the RESTlet URL (`https://<account>.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=<id>&deploy=<id>`), not the native `record/v1/vendorBill` endpoint used in the failed test.
