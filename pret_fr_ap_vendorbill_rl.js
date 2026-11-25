/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 *
 * Version history (date = commit date):
 *   v1.0.0  (2026-07-17) - Initial release: inbound Basware BUM JSON -> Vendor Bill, vendor
 *                          resolved by FR:SIRET, bumId idempotency on custbody_pret_uuid.
 *   v1.0.1  (2026-08-25) - Supplier PDF download (links[] rel='file', HTTP Basic auth), filed in
 *                          the File Cabinet and attached to the bill; host allowlist parameter.
 *   v1.0.2  (2026-08-26) - PO-matched bills: record.transform() from the PO, PO lines edited in
 *                          place to keep line-level PO linkage.
 *   v1.0.3  (2026-09-29) - Missing item code no longer fatal; default item changed to 49662;
 *                          supplier invoice number also set as externalid.
 *   v1.0.4  (2026-09-29) - Item resolved by sellersItem / buyersItem / standardItem / name /
 *                          description[0] before falling back to the default item.
 *   v1.0.5  (2026-10-01) - Duplicate check: same vendor + same reference number refused;
 *                          externalid no longer set here (owned by pret_fr_ebilling_ue.js).
 *   v1.0.6  (2026-10-14) - PDF downloaded from attachments[].url with an OAuth2
 *                          client-credentials bearer token (replaces Basic auth / links[]).
 *   v1.0.7  (2026-10-14) - Vendor resolved by FR:SIREN / FR:SIRENE when no SIRET is sent.
 *   v1.0.8  (2026-10-21) - No bearer token on Azure SAS urls (sig=); trandate off-by-one fixed.
 *   v1.0.9  (2026-10-22) - Every attachments[].url downloaded and attached, not just the first.
 *   v1.0.10 (2026-10-23) - PO resolved from free-text orderReference (PO-shaped tokens).
 *   v1.0.11 (2026-11-12) - Added field 'custbody_bill_document' ('_a' file preferred over '_i');
 *                          PDF names suffixed _a / _i by attachments[].type; non-PO
 *                          orderReference copied to the body memo.
 *   v1.0.12 (2026-11-13) - Attachment type resolved from fileRefs[] (refId -> fileType) via the
 *                          url's id, since live attachments[] entries carry no type.
 *   v1.0.13 (2026-11-13) - Item resolved ONLY from item.sellersItem.id against the bill vendor's
 *                          own item list (Item > Vendors > Vendor Code). No match -> Basware
 *                          generic item + code kept on custcol_pret_vendor_code_basware; no
 *                          sellersItem -> generic item. Replaces the itemid lookup chain.
 *   v1.0.14 (2026-11-15) - Trace logging on the vendor-code item search (inputs, filters, raw
 *                          rows, rejected rows) plus diagnostic searches when nothing matches.
 *                          Vendor-code lookup now tries item.sellersItem.id, then item.name,
 *                          then item.id (first match wins); item.description still ignored.
 *   v1.0.15 (2026-11-18) - Each code is also looked up in the Vendor Supplier Code custom record
 *                          (customrecord_pret_vendor_suppler_code: Item / Vendor / Supplier Code)
 *                          after the item's native Vendor Code — so one vendor can map several
 *                          codes to the same item. Records are written by
 *                          pret_fr_ap_bill_vendorcode_learn_ue.js or by hand on the item.
 *
 * Inbound AP JSON -> Vendor Bill RESTlet. Accepts Basware "BUM" JSON (same vendor as the
 * outbound NetSuite -> Basware UBL webhook, opposite direction) and creates a Vendor Bill.
 *
 * - Vendor resolution: FR:SIRET (custentity_pret_siret), or FR:SIREN / FR:SIRENE
 *   (custentity_pret_siren) when no SIRET is sent — the payload carries no NetSuite ID.
 * - Idempotency: bumId matched against BUM_ID_FIELD on the Vendor Bill; a repeat returns the
 *   existing internal ID instead of duplicating.
 * - Duplicate protection: a DIFFERENT bumId whose supplier invoice number already exists as a
 *   bill for the same vendor (created via UI, RESTlet or anything else) is refused with
 *   { success: false, existingInternalId, message }. The same rule is enforced again at save
 *   time by pret_fr_ebilling_ue.js beforeSubmit (PRET_DUPLICATE_BILL), which also owns the
 *   vendor-scoped externalid backstop — this script no longer sets externalid itself.
 * - PO-matched (isIssuedAgainstOrder = true): resolves orderReference.id against a PO's tranid
 *   — "contains", not exact: the reference may be free text around the PO number (e.g.
 *   "BON POUR ACCORD - CDE POFR00022225"), so the whole value is tried first, then each
 *   PO-shaped token inside it — and builds the bill via record.transform() from that PO, then edits the PO's own lines in
 *   place (quantity/rate/description from invoiceLines[], matched by orderLineReference or the
 *   line's own `id`) rather than deleting/recreating them — this is what preserves NetSuite's
 *   line-level PO linkage (Related Records, poid/podate/poamount). Item is never overridden on a
 *   matched line — NetSuite rejects an (item, PO) combination that isn't already on the PO — a
 *   mismatch is logged for manual review instead. If the PO doesn't resolve, this falls back to
 *   the standalone path rather than failing.
 * - Standalone (isIssuedAgainstOrder = false): builds the bill with record.create(), one line on
 *   the 'item' sublist per invoiceLines[] entry. Account/tax code are left to the item's own
 *   defaults; subsidiary/currency default from the resolved vendor.
 * - Item resolution (both paths): the line's codes — item.sellersItem.id, then item.name, then
 *   item.id — are tried in that order, for the bill vendor only. Each code is looked up first
 *   in the item's native Vendors sublist (Vendor Code, what the Vendor's Financial > Items
 *   subtab shows), then in the Vendor Supplier Code custom record (Vendor + Supplier Code ->
 *   Item; several codes per vendor per item allowed). Active records / items only:
 *     1. a code matches a vendor item -> that item; VENDOR_CODE_COL left empty.
 *     2. no code matches              -> DEFAULT_ITEM_ID (Basware generic); the highest-priority
 *                                        code is written to VENDOR_CODE_COL for later mapping.
 *     3. line has none of the three   -> DEFAULT_ITEM_ID; VENDOR_CODE_COL left empty.
 *   buyersItem / standardItem / description are not used to find the item.
 * - Both paths: an orderReference.id that contains no 'PO' (so no 'POFR' either) is copied to
 *   the body memo — it is the supplier's own reference, not a Pret PO number.
 * - Both paths leave approval status to NetSuite's own routing default.
 * - Supplier PDFs: EVERY `attachments[].url` entry is downloaded after save, filed and attached
 *   to the bill — one File Cabinet file per url (a payload often carries several). Authenticated
 *   with an OAuth2 client-credentials bearer token fetched once from the configured token
 *   endpoint and shared across the downloads — unless the url is an Azure SAS link (has a
 *   `sig=` query parameter), which is fetched with no Authorization header since Azure rejects
 *   two schemes. Best-effort and per-url — a failure on one attachment is reported but never
 *   stops the others, and never fails the bill. A bearer-token url is checked against an
 *   allowlist (custscript_pret_ap_api_hosts) before the token is sent.
 * - The attachment type names the file: 'attachmentFile' -> '..._a.pdf', 'imageFile' ->
 *   '..._i.pdf' (e.g. Invoice_0158087400_1011260127_a.pdf). Any other/missing type gets no suffix.
 *   Type comes from the attachments[] entry if it has one, else from fileRefs[].fileType whose
 *   refId matches the url's id (?id=<refId> or trailing /<refId>).
 * - Once the attachments are filed, ONE saved file is also set on custbody_bill_document (a
 *   'Document' field: holds a single file ID, so the rest are on Files only). Priority: the
 *   '_a' (attachmentFile) file, else the '_i' (imageFile) file, else the first saved file.
 * - Response is always HTTP 200 with a body-level { success, internalId, bumId, message,
 *   pdfFileId (first file), pdfFileIds (all files), pdfFiles (per-url detail), pdfMessage,
 *   documentFileId (the file set on custbody_bill_document, or null) }.
 *
 * Script parameters (set on the Script record, valued per deployment):
 *   custscript_pret_ap_pdf_folder          Integer  — File Cabinet folder internal ID
 *   custscript_pret_ap_oauth_token_url_vb_in     Free-Form Text — OAuth2 token endpoint URL
 *   custscript_pret_ap_oauth_client_id_vb_in     Free-Form Text — OAuth2 client_id
 *   custscript_pret_ap_oauth_client_secret_v Password — OAuth2 client_secret
 *   custscript_pret_ap_oauth_scope_vb_in         Free-Form Text — OAuth2 scope (optional)
 *   custscript_pret_ap_api_hosts           Free-Form Text — comma-separated allowed hosts for the
 *                                          attachment url. Blank = no restriction (logged as a warning).
 *
 * Full history/rationale: AP-JSON-to-VendorBill-Integration.md.
 */
define(['N/record', 'N/search', 'N/log', 'N/https', 'N/file', 'N/runtime'],
(record, search, log, https, file, runtime) => {

    const BUM_ID_FIELD        = 'custbody_pret_uuid';        // existing field, also used by pret_fr_evendorcredit_ue.js
    const VENDOR_SIRET_FIELD  = 'custentity_pret_siret';
    const VENDOR_SIREN_FIELD  = 'custentity_pret_siren';
    const BILL_DOCUMENT_FIELD = 'custbody_bill_document';    // 'Document' type — one File Cabinet file ID
    const APPROVAL_STATUS_FIELD = 'approvalstatus';
    const PENDING_APPROVAL_VALUE = '1';

    // Basware generic item: used when the line's sellersItem.id is not a Vendor Code on any of
    // the vendor's items (or the line carries no sellersItem.id), so an unmapped item never
    // blocks bill creation.
    const DEFAULT_ITEM_ID = '49662';

    // Line field holding the supplier's item code when it did NOT resolve to a vendor item —
    // i.e. only ever filled on lines that fell back to DEFAULT_ITEM_ID.
    const VENDOR_CODE_COL = 'custcol_pret_vendor_code_basware';

    // Vendor Supplier Code custom record: Vendor + Supplier Code -> Item, any number of codes
    // per vendor per item (the native Vendors sublist allows only one). IDs as created in the
    // account (note 'suppler'). Filled by pret_fr_ap_bill_vendorcode_learn_ue.js or by hand.
    const VSC_RECORD = 'customrecord_pret_vendor_suppler_code';
    const VSC_ITEM   = 'custrecord_pret_vc_item';
    const VSC_VENDOR = 'custrecord_pret_vc_vendor';
    const VSC_CODE   = 'custrecord_pret_vc_supplier_code';

    // attachments[].type -> file-name suffix. Keys are lower-cased; lookup is case-insensitive.
    // The '_a' file also wins over '_i' for custbody_bill_document.
    const ATTACHMENT_TYPE_SUFFIX = { attachmentfile: '_a', imagefile: '_i' };

    const PARAM_PDF_FOLDER    = 'custscript_pret_ap_pdf_folder';
    const PARAM_OAUTH_TOKEN_URL     = 'custscript_pret_ap_oauth_token_url_vb_in';
    const PARAM_OAUTH_CLIENT_ID     = 'custscript_pret_ap_oauth_client_id_vb_in';
    const PARAM_OAUTH_CLIENT_SECRET = 'custscript_pret_ap_oauth_client_secret_v';
    const PARAM_OAUTH_SCOPE         = 'custscript_pret_ap_oauth_scope_vb_in';
    const PARAM_API_HOSTS     = 'custscript_pret_ap_api_hosts';

    function post(requestBody) {
        const bumId = requestBody && requestBody.bumId;
        log.audit('AP BILL STEP 1 - RECEIVED', `bumId: ${bumId}`);

        try {
            const validationError = validate(requestBody);
            if (validationError) {
                log.error('AP BILL VALIDATION FAILED', `bumId: ${bumId} | ${validationError}`);
                return { success: false, bumId, message: validationError };
            }

            const data = requestBody.data;

            const existingId = findExistingBill(bumId);
            if (existingId) {
                log.audit('AP BILL DUPLICATE', `bumId: ${bumId} | existing internalId: ${existingId}`);
                return { success: true, internalId: existingId, bumId, message: 'Already processed (idempotent match)' };
            }
            log.audit('AP BILL STEP 2 - NOT A DUPLICATE', `bumId: ${bumId}`);

            const isPoBill = !!data.isIssuedAgainstOrder;
            let bill, vendorId, subsidiaryId, poId = null;

            if (isPoBill) {
                const poReference = data.orderReference && data.orderReference.id;
                const poMatch = poReference ? findPurchaseOrderByReference(poReference) : null;
                poId = poMatch ? poMatch.poId : null;

                if (!poId) {
                    log.error('AP BILL PO NOT MATCHING', `bumId: ${bumId} | orderReference: ${poReference || '(missing)'} | PO reference is not matching. Please check with the supplier!`);
                } else {
                    log.audit('AP BILL STEP 3 - PO RESOLVED', `bumId: ${bumId} | orderReference: ${poReference} | matched PO tranid: ${poMatch.matchedOn} | poId: ${poId}`);
                }
            }

            if (poId) {
                bill = record.transform({
                    fromType: record.Type.PURCHASE_ORDER,
                    fromId: poId,
                    toType: record.Type.VENDOR_BILL,
                    isDynamic: true
                });
                vendorId = bill.getValue('entity');
                subsidiaryId = bill.getValue('subsidiary');

                // Expense lines (if any) aren't matched against invoiceLines[] below, so they'd
                // otherwise survive untouched from the PO — drop them. Item lines are handled by
                // applyInvoiceLinesToPoBill() below, which edits them in place instead of
                // deleting them outright, to keep their line-level PO linkage intact.
                removeAllLines(bill, 'expense');
            } else {
                const supplierId = getSupplierIdentifier(data);
                if (!supplierId) {
                    return { success: false, bumId, message: 'No FR:SIRET or FR:SIREN identification found in accountingSupplierParty.partyIdentifications' };
                }

                vendorId = findVendorByIdentifier(supplierId);
                if (!vendorId) {
                    log.error('AP BILL VENDOR NOT FOUND', `bumId: ${bumId} | ${supplierId.label}: ${supplierId.id}`);
                    return { success: false, bumId, message: `No vendor found for ${supplierId.label} ${supplierId.id}` };
                }
                log.audit('AP BILL STEP 3 - VENDOR RESOLVED', `bumId: ${bumId} | ${supplierId.label}: ${supplierId.id} | vendorId: ${vendorId}`);

                const vendor = record.load({ type: record.Type.VENDOR, id: vendorId });
                subsidiaryId = vendor.getValue('subsidiary');

                bill = record.create({ type: record.Type.VENDOR_BILL, isDynamic: true });
                bill.setValue('entity', vendorId);
                if (subsidiaryId) bill.setValue('subsidiary', subsidiaryId);
            }

            // Supplier's own invoice number becomes the NetSuite reference number (tranid).
            // Duplicate check BEFORE any further work: same vendor + same number = refuse.
            // (A repeat of the same bumId was already handled above as an idempotent match.)
            const supplierInvoiceNumber = String((data.externalDocumentIdentifier && data.externalDocumentIdentifier.id) || '').trim();
            if (supplierInvoiceNumber) {
                const existingBillId = findBillByVendorAndNumber(vendorId, supplierInvoiceNumber);
                if (existingBillId) {
                    log.error('AP BILL DUPLICATE NUMBER',
                        `bumId: ${bumId} | vendorId: ${vendorId} | invoice number: ${supplierInvoiceNumber}` +
                        ` | existing bill internalId: ${existingBillId} — refused`);
                    return {
                        success: false,
                        bumId,
                        existingInternalId: existingBillId,
                        message: `Duplicate: a vendor bill with reference number "${supplierInvoiceNumber}" already exists` +
                                 ` for this vendor (internal ID ${existingBillId})`
                    };
                }
            }

            const tranDate = parseIssueDate(data.issueDate);
            if (tranDate) bill.setValue('trandate', tranDate);
            bill.setValue('tranid', supplierInvoiceNumber);
            bill.setValue(BUM_ID_FIELD, bumId);

            // An orderReference that isn't a PO number (no 'PO' / 'POFR' in it) is the supplier's
            // own reference, e.g. "00430624" (2026-10-27) — it can never resolve to a PO, so keep
            // it on the body memo instead of losing it. Applies to both PO and standalone paths.
            const orderReference = String((data.orderReference && data.orderReference.id) || '').trim();
            if (orderReference && !/PO/i.test(orderReference)) {
                bill.setValue('memo', orderReference.substring(0, 999));
                log.audit('AP BILL ORDER REFERENCE TO MEMO', `bumId: ${bumId} | orderReference: ${orderReference}`);
            }

            log.audit('AP BILL STEP 4 - HEADER SET', `bumId: ${bumId} | vendorId: ${vendorId} | subsidiary: ${subsidiaryId} | poMatched: ${!!poId}`);

            const lines = data.invoiceLines || [];
            if (!lines.length) {
                return { success: false, bumId, message: 'No invoiceLines in payload' };
            }

            if (poId) {
                applyInvoiceLinesToPoBill(bill, lines, vendorId, bumId);
            } else {
                for (const line of lines) {
                    const { itemId, vendorCode, qty, price, itemDesc } = resolveInvoiceLine(line, vendorId, bumId);
                    bill.selectNewLine({ sublistId: 'item' });
                    bill.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item',        value: itemId });
                    bill.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity',    value: qty });
                    bill.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate',        value: price });
                    if (itemDesc) bill.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: itemDesc });
                    bill.setCurrentSublistValue({ sublistId: 'item', fieldId: VENDOR_CODE_COL, value: vendorCode });
                    bill.commitLine({ sublistId: 'item' });
                }
            }
            log.audit('AP BILL STEP 5 - LINES SET', `bumId: ${bumId} | lineCount: ${lines.length}`);

            try {
                bill.setValue({
                    fieldId: APPROVAL_STATUS_FIELD,
                    value: PENDING_APPROVAL_VALUE
                });
                log.audit('AP BILL APPROVAL STATUS SET', `bumId: ${bumId} | approvalStatus: ${PENDING_APPROVAL_VALUE}`);
            } catch (approvalErr) {
                log.audit('AP BILL APPROVAL STATUS NOT SET', `bumId: ${bumId} | ${approvalErr.message}`);
            }

            const internalId = bill.save();
            log.audit('AP BILL STEP 6 - SAVED', `bumId: ${bumId} | internalId: ${internalId}`);

            // Post-submit: the tranid only exists once the record is saved.
            const pdf = attachSupplierPdf(requestBody, internalId, bumId);
            const documentFileId = setBillDocumentField(internalId, pdf.files, bumId);

            log.audit('AP BILL COMPLETE', `bumId: ${bumId} | internalId: ${internalId} | pdfFileIds: [${pdf.fileIds.join(', ')}] | documentFileId: ${documentFileId} | ${pdf.message}`);
            return {
                success: true,
                internalId,
                bumId,
                pdfFileId: pdf.fileId,          // first saved file — kept for existing consumers
                pdfFileIds: pdf.fileIds,        // every saved file, one per attachments[].url
                pdfFiles: pdf.files,            // per-url { url, type, fileId, message }
                pdfMessage: pdf.message,
                documentFileId,                 // file set on custbody_bill_document ('_a' > '_i'), or null
                message: 'Vendor bill created and marked Pending Approval'
            };

        } catch (e) {
            log.error('AP BILL FAILED', `bumId: ${bumId} | ${e.name}: ${e.message}\n${e.stack}`);
            return { success: false, bumId, message: `${e.name}: ${e.message}` };
        }
    }

    // ── Issue date ───────────────────────────────────────────────────────────
    // new Date('2026-10-13') is midnight UTC, which on NetSuite's Pacific-time server is still
    // the 12th — so trandate landed a day early. Build the date from its parts in server-local
    // time instead. Any time/zone suffix on issueDate is ignored: only the calendar date counts.
    function parseIssueDate(value) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || '').trim());
        return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
    }

    // ── Validation ───────────────────────────────────────────────────────────
    function validate(body) {
        if (!body) return 'Empty request body';
        if (!body.bumId) return 'Missing bumId';
        if (!body.data) return 'Missing data';
        if (!body.data.accountingSupplierParty) return 'Missing data.accountingSupplierParty';
        if (!body.data.invoiceLines || !body.data.invoiceLines.length) return 'Missing data.invoiceLines';
        return null;
    }

    // ── Idempotency lookup ───────────────────────────────────────────────────
    function findExistingBill(bumId) {
        const results = search.create({
            type: record.Type.VENDOR_BILL,
            filters: [[BUM_ID_FIELD, 'is', bumId]],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });
        return results.length ? results[0].getValue('internalid') : null;
    }

    // ── Duplicate lookup: same vendor + same reference number ────────────────
    function findBillByVendorAndNumber(vendorId, tranId) {
        const filters = [
            ['mainline', 'is', 'T'], 'and',
            ['tranid', 'is', tranId]
        ];
        if (vendorId) filters.push('and', ['entity', 'anyof', vendorId]);

        const results = search.create({
            type: search.Type.VENDOR_BILL,
            filters,
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });
        return results.length ? results[0].getValue('internalid') : null;
    }

    // ── Vendor resolution ────────────────────────────────────────────────────
    // SIRET first (establishment-level, most specific); SIREN only when no SIRET is sent —
    // e.g. Uber Eats (2026-09-22) sends a bare SIREN. Basware labels it 'FR:SIRENE', so both
    // spellings are accepted. Returns { label, id, field } or null.
    function getSupplierIdentifier(data) {
        const ids = (data.accountingSupplierParty && data.accountingSupplierParty.partyIdentifications) || [];
        const idFor = schemes => {
            const match = ids.find(pid => pid && schemes.indexOf(pid.schemeId) !== -1 && String(pid.id || '').trim());
            return match ? String(match.id).trim() : null;
        };

        const siret = idFor(['FR:SIRET']);
        if (siret) return { label: 'SIRET', id: siret, field: VENDOR_SIRET_FIELD };

        const siren = idFor(['FR:SIREN', 'FR:SIRENE']);
        if (siren) return { label: 'SIREN', id: siren, field: VENDOR_SIREN_FIELD };

        return null;
    }

    function findVendorByIdentifier(supplierId) {
        const results = search.create({
            type: record.Type.VENDOR,
            filters: [[supplierId.field, 'is', supplierId.id]],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });
        return results.length ? results[0].getValue('internalid') : null;
    }

    // ── PO resolution (isIssuedAgainstOrder = true) ─────────────────────────
    // orderReference.id is NOT always a bare PO number — suppliers key free text into it, e.g.
    // "BON POUR ACCORD - CDE POFR00022225" (2026-10-23), where only POFR00022225 is the PO.
    // So the lookup is "contains" rather than exact: the reference is broken into candidate
    // tokens and each is exact-matched against a PO tranid, first hit wins. Order tried:
    //   1. the whole trimmed reference (the normal, clean case — one search, no change);
    //   2. every PO-shaped token in it ("PO" + optional letters + digits, any case), upper-
    //      cased and longest first — so "Ref POFR00022225/2026" and "pofr00022225" both
    //      yield POFR00022225. Nothing else is tried: a bare number like "2026" is never
    //      used as a candidate, so it can't link the bill to an unrelated PO.
    // Returns { poId, matchedOn } or null.
    function findPurchaseOrderByReference(reference) {
        const candidates = getPoNumberCandidates(reference);
        for (const candidate of candidates) {
            const poId = findPurchaseOrderByTranId(candidate);
            if (poId) return { poId, matchedOn: candidate };
        }
        return null;
    }

    function getPoNumberCandidates(reference) {
        const full = String(reference || '').trim();
        if (!full) return [];

        const tokens = full.split(/[\s,;:/()\[\]"']+/).map(t => t.trim()).filter(Boolean);
        const poShaped = tokens
            .filter(t => /^PO[A-Z]*\d+$/i.test(t))
            .map(t => t.toUpperCase())
            .sort((a, b) => b.length - a.length);

        return [full].concat(poShaped)
            .filter((v, i, arr) => arr.indexOf(v) === i);   // de-duplicate, keep order
    }

    function findPurchaseOrderByTranId(tranId) {
        const results = search.create({
            type: search.Type.PURCHASE_ORDER,
            filters: [['tranid', 'is', tranId]],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });
        return results.length ? results[0].getValue('internalid') : null;
    }

    // Strips every line from a sublist that record.transform() populated from the source PO —
    // used only for 'expense' (item lines are handled by applyInvoiceLinesToPoBill instead,
    // which edits them in place to preserve their line-level PO linkage).
    function removeAllLines(rec, sublistId) {
        for (let i = rec.getLineCount({ sublistId }) - 1; i >= 0; i--) {
            rec.removeLine({ sublistId, line: i });
        }
    }

    // Basware's orderLineReference is the UBL-derived equivalent of cac:OrderLineReference/
    // cbc:LineID — a 1-based line number into the PO this invoice line bills against. Not every
    // payload includes it though: the live PO-matched test payload (2026-08-26) has no
    // orderLineReference at all, just a top-level invoiceLines[].id ("1", "2", ...) that plays
    // the same role — so fall back to that when orderLineReference is absent.
    function getOrderLineNumber(line) {
        const ref = line.orderLineReference;
        const raw = ref ? (ref.lineId != null ? ref.lineId : ref.id) : line.id;
        const n = parseInt(raw, 10);
        return Number.isInteger(n) && n > 0 ? n : null;
    }

    // Resolves the NetSuite item + line values for one invoiceLines[] entry. Shared by both
    // the standalone (fresh lines) and PO-matched (in-place edit) paths.
    // Item rule (each candidate code: native Vendor Code first, then Vendor Supplier Code record):
    //   match     -> that item,       vendorCode ''
    //   no match  -> DEFAULT_ITEM_ID, vendorCode = sellersItem.id (kept on VENDOR_CODE_COL)
    //   no code   -> DEFAULT_ITEM_ID, vendorCode ''
    function resolveInvoiceLine(line, vendorId, bumId) {
        const qty   = (line.quantity && line.quantity.amount) || 1;
        const price = (line.price && line.price.amount) || 0;
        const item  = line.item || {};

        const itemDesc = (Array.isArray(item.description) && item.description.join(' '))
                      || item.name
                      || '';

        log.audit('AP BILL ITEM RESOLVE - LINE INPUT',
            `bumId: ${bumId} | line ${line.id || ''} | vendorId: ${vendorId}`
            + ` | item.sellersItem: ${JSON.stringify(item.sellersItem)}`
            + ` | item.name: ${JSON.stringify(item.name)} | item.id: ${JSON.stringify(item.id)}`);

        const candidates = getItemCodeCandidates(item);
        log.audit('AP BILL ITEM RESOLVE - CANDIDATES',
            `bumId: ${bumId} | line ${line.id || ''} | `
            + (candidates.length ? candidates.map(c => `${c.source}='${c.code}'`).join(', ') : '(none)'));

        // A line with no code at all is normal (free-text suppliers) — generic item.
        if (!candidates.length) {
            log.audit('AP BILL ITEM GENERIC',
                `bumId: ${bumId} | line ${line.id || ''}: no item.sellersItem.id / item.name / item.id`
                + ` — using Basware generic item ${DEFAULT_ITEM_ID}`);
            return { itemId: DEFAULT_ITEM_ID, vendorCode: '', qty, price, itemDesc };
        }

        for (const c of candidates) {
            const itemId = findItemByVendorCode(vendorId, c.code, bumId);
            if (itemId) {
                log.audit('AP BILL ITEM BY VENDOR CODE',
                    `bumId: ${bumId} | line ${line.id || ''}: vendor code ${c.code} (from item.${c.source}) -> item ${itemId}`);
                return { itemId, vendorCode: '', qty, price, itemDesc };
            }
            const mappedItemId = findItemBySupplierCodeRecord(vendorId, c.code, bumId);
            if (mappedItemId) {
                log.audit('AP BILL ITEM BY SUPPLIER CODE RECORD',
                    `bumId: ${bumId} | line ${line.id || ''}: supplier code ${c.code} (from item.${c.source})`
                    + ` -> item ${mappedItemId} (Vendor Supplier Code record)`);
                return { itemId: mappedItemId, vendorCode: '', qty, price, itemDesc };
            }
        }

        // Nothing matched: one diagnostic pass for the whole line, then generic item. The code
        // kept on VENDOR_CODE_COL is the highest-priority candidate (sellersItem.id > name > id).
        logItemSearchDiagnostics(vendorId, candidates.map(c => c.code),
            `bumId: ${bumId} | line ${line.id || ''} | vendorId: ${vendorId}`);

        const keptCode = candidates[0].code;
        log.audit('AP BILL ITEM GENERIC',
            `bumId: ${bumId} | line ${line.id || ''}: none of [${candidates.map(c => c.code).join(', ')}] is on vendor`
            + ` ${vendorId}'s item list — using Basware generic item ${DEFAULT_ITEM_ID},`
            + ` code ${keptCode} (from item.${candidates[0].source}) kept on ${VENDOR_CODE_COL}`);
        return { itemId: DEFAULT_ITEM_ID, vendorCode: keptCode, qty, price, itemDesc };
    }

    // Codes to try against the vendor's Vendor Codes, in priority order:
    // item.sellersItem.id, item.name, item.id. Only plain string/number values count; blanks
    // and repeats are dropped. item.description is deliberately NOT a candidate.
    function getItemCodeCandidates(item) {
        const raw = [
            ['sellersItem.id', item.sellersItem && item.sellersItem.id],
            ['name',           item.name],
            ['id',             item.id]
        ];
        const seen = new Set();
        const out = [];
        for (const [source, v] of raw) {
            if (typeof v !== 'string' && typeof v !== 'number') continue;
            const code = String(v).trim();
            if (!code || seen.has(code.toLowerCase())) continue;
            seen.add(code.toLowerCase());
            out.push({ source, code });
        }
        return out;
    }

    // Overwrites the PO's own item lines IN PLACE by matching orderLineReference to the PO's
    // line number — this is what keeps the line-level PO linkage intact (Related Records /
    // poid-podate-poamount on the printed bill depend on it). Quantity, rate, description and
    // VENDOR_CODE_COL are set from Basware; the PO line's ITEM is kept (NetSuite rejects an
    // item that isn't on the PO — see below). An invoice line with no matching/in-range
    // orderLineReference is appended as a new, unlinked line with the resolved item. Any PO
    // line Basware never billed against is removed.
    function applyInvoiceLinesToPoBill(bill, lines, vendorId, bumId) {
        const poLineCount = bill.getLineCount({ sublistId: 'item' });
        const matchedIndices = new Set();

        for (const line of lines) {
            const { itemId, vendorCode, qty, price, itemDesc } = resolveInvoiceLine(line, vendorId, bumId);
            const lineNumber = getOrderLineNumber(line);
            const targetIndex = (lineNumber && lineNumber <= poLineCount) ? lineNumber - 1 : null;

            if (targetIndex !== null) {
                bill.selectLine({ sublistId: 'item', line: targetIndex });
                matchedIndices.add(targetIndex);

                // NetSuite rejects this outright (YOU_CANNOT_ADD_AN_ITEM_AND_PURCHASE_ORDER_
                // COMBINATION_THAT_DOES_NOT_EXIST_TO_A_VENDOR_BILL, confirmed 2026-08-26): the
                // (item, PO) combination on an order-linked line must already exist on the PO
                // itself, so Basware's item can NOT be forced onto a matched PO line. Leave the
                // PO's own item as-is here; only quantity/rate/description are overridden. A
                // mismatch is logged for manual review rather than silently ignored.
                const poItemId = bill.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' });
                if (String(poItemId) !== String(itemId)) {
                    log.audit('AP BILL PO LINE ITEM MISMATCH',
                        `bumId: ${bumId} | invoice line ${line.id || ''} resolved to item ${itemId}, but PO line`
                        + ` ${lineNumber} has item ${poItemId} — keeping the PO's item (NetSuite does not allow`
                        + ' changing it on an order-linked line); please review manually');
                }
            } else {
                log.audit('AP BILL PO LINE NOT MATCHED',
                    `bumId: ${bumId} | invoice line ${line.id || ''} has no usable orderLineReference against PO`
                    + ` (PO has ${poLineCount} line(s)) — adding as a new unlinked line`);
                bill.selectNewLine({ sublistId: 'item' });
                bill.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: itemId });
            }

            bill.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity',    value: qty });
            bill.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate',        value: price });
            if (itemDesc) bill.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: itemDesc });
            bill.setCurrentSublistValue({ sublistId: 'item', fieldId: VENDOR_CODE_COL, value: vendorCode });
            bill.commitLine({ sublistId: 'item' });
        }

        // Anything left over on the PO that Basware didn't bill against — drop it.
        for (let i = poLineCount - 1; i >= 0; i--) {
            if (!matchedIndices.has(i)) bill.removeLine({ sublistId: 'item', line: i });
        }
    }

    // ── Supplier PDFs: download every attachment and file in the File Cabinet ─
    // Runs after bill.save() so the NetSuite tranid is available for the filename.
    // One file per attachments[].url entry — a payload often carries several (invoice PDF plus
    // supporting documents). Each url is handled independently: a failure on one is logged and
    // reported but never stops the others, and never fails the bill.
    // Returns { fileId, fileIds, message, files } — fileId is the first saved file (kept for
    // backwards compatibility of the response), fileIds every saved file, files one entry per url.
    function attachSupplierPdf(requestBody, internalId, bumId) {
        const summary = (files) => {
            const fileIds = files.map(f => f.fileId).filter(Boolean);
            const failed  = files.length - fileIds.length;
            return {
                fileId:  fileIds.length ? fileIds[0] : null,
                fileIds,
                files,
                message: files.length
                    ? `${fileIds.length} of ${files.length} attachment(s) saved` + (failed ? ` (${failed} failed)` : '')
                    : 'No attachment url in payload'
            };
        };

        try {
            const links = getFileLinks(requestBody);
            if (!links.length) {
                log.audit('AP BILL PDF - NO FILE LINK', `bumId: ${bumId} | no attachments entry with a url`);
                return summary([]);
            }
            log.audit('AP BILL PDF - ATTACHMENTS FOUND',
                `bumId: ${bumId} | ${links.length} url(s) to download | types: [${links.map(l => l.type || '(none)').join(', ')}]`);

            const script       = runtime.getCurrentScript();
            const folderId     = script.getParameter({ name: PARAM_PDF_FOLDER });
            const tokenUrl     = script.getParameter({ name: PARAM_OAUTH_TOKEN_URL });
            const clientId     = script.getParameter({ name: PARAM_OAUTH_CLIENT_ID });
            const clientSecret = script.getParameter({ name: PARAM_OAUTH_CLIENT_SECRET });
            const scope        = script.getParameter({ name: PARAM_OAUTH_SCOPE });
            const allowedHosts = script.getParameter({ name: PARAM_API_HOSTS });

            if (!folderId) {
                const msg = failPdf(bumId, `Script parameter ${PARAM_PDF_FOLDER} is not set`).message;
                return summary(links.map(l => ({ url: l.url, type: l.type || null, fileId: null, message: msg })));
            }

            const tranId = search.lookupFields({
                type: search.Type.VENDOR_BILL,
                id: internalId,
                columns: ['tranid']
            }).tranid;

            // The OAuth token is fetched once, lazily, and shared by every non-SAS url.
            let bearerToken = null;
            const getBearerToken = () => {
                if (bearerToken) return bearerToken;
                if (!tokenUrl || !clientId || !clientSecret) {
                    bearerToken = { error: `Script parameters ${PARAM_OAUTH_TOKEN_URL} / ${PARAM_OAUTH_CLIENT_ID} / ${PARAM_OAUTH_CLIENT_SECRET} are not set` };
                } else {
                    bearerToken = getOAuthToken(tokenUrl, clientId, clientSecret, scope, bumId);
                }
                return bearerToken;
            };

            // Per-suffix counter: the 1st '_a' file is plain '_a', a 2nd one in the same payload
            // becomes '_2_a', so two files of the same type never share a name.
            const occurrences = {};
            const files = links.map((link, index) => {
                const seq = index + 1;
                const type = link.type || null;
                const typeSuffix = getTypeSuffix(link.type);
                occurrences[typeSuffix] = (occurrences[typeSuffix] || 0) + 1;
                try {
                    const result = downloadAndAttachOne(link.url, {
                        internalId, bumId, tranId, folderId, allowedHosts, getBearerToken,
                        seq, total: links.length, typeSuffix, occurrence: occurrences[typeSuffix]
                    });
                    return { url: link.url, type, fileId: result.fileId, message: result.message };
                } catch (e) {
                    return { url: link.url, type, fileId: null, message: failPdf(bumId, `[${seq}/${links.length}] ${e.name}: ${e.message}`).message };
                }
            });

            return summary(files);

        } catch (e) {
            const msg = failPdf(bumId, `${e.name}: ${e.message}`).message;
            return { fileId: null, fileIds: [], files: [], message: msg };
        }
    }

    // Downloads ONE attachment url, saves it to the File Cabinet and attaches it to the bill.
    // Returns { fileId, message }; fileId is null when the download or save failed.
    function downloadAndAttachOne(href, ctx) {
        const { internalId, bumId, tranId, folderId, allowedHosts, getBearerToken, seq, total, typeSuffix, occurrence } = ctx;
        const tag = `[${seq}/${total}]`;

        // A SAS link (Azure Blob, '?...&sig=...') carries its own authorization in the query
        // string. Azure refuses a second scheme alongside it
        // (DirectApiRequestHasMoreThanOneAuthorization), so no bearer token is fetched or
        // sent — and with no token going out, the host allowlist has nothing to protect.
        const isSasUrl = /[?&]sig=/i.test(href);
        const requestHeaders = { 'Content-Type': 'application/json', Accept: '*/*' };

        if (isSasUrl) {
            log.audit('AP BILL PDF - SAS URL', `bumId: ${bumId} | ${tag} url carries a SAS signature; downloading without a bearer token`);
        } else {
            const hostError = checkHostAllowed(href, allowedHosts, bumId);
            if (hostError) return failPdf(bumId, `${tag} ${hostError}`);

            const token = getBearerToken();
            if (token.error) return failPdf(bumId, `${tag} ${token.error}`);
            requestHeaders.Authorization = `Bearer ${token.accessToken}`;
        }

        log.audit('AP BILL PDF - DOWNLOADING', `bumId: ${bumId} | ${tag} tranid: ${tranId} | url: ${href}`);

        // Content-Type/Accept kept as on the original Basware request that is known to
        // return a valid PDF — narrowing Accept to application/pdf changed what came back.
        const response = https.get({ url: href, headers: requestHeaders });

        if (response.code !== 200) {
            return failPdf(bumId, `${tag} Attachment endpoint returned HTTP ${response.code}: ${String(response.body || '').substring(0, 300)}`);
        }

        const rawBody = String(response.body || '');
        const headers = response.headers || {};
        const contentType = headers['Content-Type'] || headers['content-type'] || '(none)';

        // Diagnostic: the shape of this body decides how it must be encoded. Keep this —
        // a blank PDF is almost always visible here as a length or prefix mismatch.
        log.audit('AP BILL PDF - RESPONSE',
            `bumId: ${bumId} | ${tag} code: ${response.code} | contentType: ${contentType}`
            + ` | bodyLength: ${rawBody.length} | first64: ${rawBody.substring(0, 64)}`);

        if (!rawBody.length) {
            return failPdf(bumId, `${tag} Attachment endpoint returned HTTP 200 with an empty body — nothing to save`);
        }

        const contents = toBase64(rawBody, bumId);
        if (!contents) {
            return failPdf(bumId, `${tag} Could not derive base64 PDF content from the response body`);
        }

        const fileName = buildPdfName(tranId, typeSuffix, occurrence);
        const pdfFile = file.create({
            name: fileName,
            fileType: file.Type.PDF,
            contents,                            // binary file types expect base64 contents
            folder: Number(folderId),
            isOnline: false
        });
        const fileId = pdfFile.save();
        log.audit('AP BILL PDF - SAVED', `bumId: ${bumId} | ${tag} fileId: ${fileId} | name: ${fileName} | folder: ${folderId}`);

        // Attach separately: the file is already safely in the cabinet at this point, so an
        // attach failure must still report the fileId rather than collapse into failPdf().
        try {
            record.attach({
                record: { type: 'file', id: fileId },
                to:     { type: record.Type.VENDOR_BILL, id: internalId }
            });
            log.audit('AP BILL PDF - ATTACHED', `bumId: ${bumId} | ${tag} fileId: ${fileId} attached to vendor bill ${internalId} (Communication > Files)`);
            return { fileId, message: `Saved as ${fileName} and attached to the bill` };
        } catch (attachErr) {
            log.error('AP BILL PDF ATTACH FAILED', `bumId: ${bumId} | ${tag} fileId: ${fileId} | internalId: ${internalId} | ${attachErr.name}: ${attachErr.message}`);
            return { fileId, message: `Saved as ${fileName} but not attached: ${attachErr.message}` };
        }
    }

    // Fills the 'Document' body field once every url has been filed under Communication > Files.
    // A Document field holds ONE File Cabinet file ID — not a url, and never a list — so one
    // saved file is chosen: the '_a' (attachmentFile) one first, else the '_i' (imageFile) one,
    // else the first saved file of any other type. Only successfully saved files qualify, so a
    // failed '_a' download falls through to '_i'. Best-effort: a failure is logged and never
    // fails the bill, which is already saved at this point.
    // Returns the file ID that was set, or null.
    function setBillDocumentField(internalId, files, bumId) {
        const saved = (files || []).filter(f => f && f.fileId);
        if (!saved.length) {
            log.audit('AP BILL DOCUMENT FIELD SKIPPED', `bumId: ${bumId} | no attachment was saved — ${BILL_DOCUMENT_FIELD} left blank`);
            return null;
        }

        const ofSuffix = suffix => saved.find(f => getTypeSuffix(f.type) === suffix);
        const chosen = ofSuffix('_a') || ofSuffix('_i') || saved[0];
        const others = saved.filter(f => f !== chosen).map(f => f.fileId);

        try {
            record.submitFields({
                type: record.Type.VENDOR_BILL,
                id: internalId,
                values: { [BILL_DOCUMENT_FIELD]: chosen.fileId },
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });
            log.audit('AP BILL DOCUMENT FIELD SET',
                `bumId: ${bumId} | internalId: ${internalId} | ${BILL_DOCUMENT_FIELD}: ${chosen.fileId} (type: ${chosen.type || '(none)'})`
                + (others.length ? ` | ${others.length} further file(s) [${others.join(', ')}] on Files subtab only` : ''));
            return chosen.fileId;
        } catch (e) {
            log.error('AP BILL DOCUMENT FIELD FAILED', `bumId: ${bumId} | internalId: ${internalId} | fileId: ${chosen.fileId} | ${e.name}: ${e.message}`);
            return null;
        }
    }

    // 'attachmentFile' -> '_a', 'imageFile' -> '_i', anything else (or missing) -> ''.
    function getTypeSuffix(type) {
        return ATTACHMENT_TYPE_SUFFIX[String(type || '').trim().toLowerCase()] || '';
    }

    function failPdf(bumId, message) {
        log.error('AP BILL PDF FAILED', `bumId: ${bumId} | ${message}`);
        return { fileId: null, message };
    }

    // attachments[] may sit at the top level of the payload or under data — accept either.
    // Returns EVERY entry as { url, type } (url trimmed, blanks and exact url repeats dropped —
    // first occurrence wins), in payload order. type is 'attachmentFile' / 'imageFile' / ''.
    // links[] (rel='file', the direct Basware href) is deliberately no longer used.
    //
    // The live payload (2026-11-12) carries NO type on the attachments[] entry itself — the
    // type lives in fileRefs[] as { refId, fileType }, and the attachment url carries that
    // refId (…/BaswareAttachment?id=<refId>, or a trailing /<refId> path segment). So the type
    // is taken from the entry if present (type / fileType / attachmentType), else by joining
    // the url's id to fileRefs[].refId.
    function getFileLinks(requestBody) {
        const pick = key => (requestBody && requestBody[key])
            || (requestBody && requestBody.data && requestBody.data[key]);
        const attachments = pick('attachments') || [];
        if (!Array.isArray(attachments)) return [];

        const typeByRefId = {};
        const fileRefs = pick('fileRefs');
        if (Array.isArray(fileRefs)) {
            for (const ref of fileRefs) {
                const refId = ref && ref.refId != null ? String(ref.refId).trim().toLowerCase() : '';
                const fileType = ref && ref.fileType != null ? String(ref.fileType).trim() : '';
                if (refId && fileType) typeByRefId[refId] = fileType;
            }
        }

        const seen = new Set();
        const links = [];
        for (const a of attachments) {
            const url = a && a.url != null ? String(a.url).trim() : '';
            if (!url || seen.has(url)) continue;
            seen.add(url);

            const ownType = [a.type, a.fileType, a.attachmentType]
                .map(v => (v == null ? '' : String(v).trim()))
                .find(Boolean) || '';
            const refId = getUrlRefId(url);
            const type = ownType || (refId && typeByRefId[refId]) || '';
            links.push({ url, type });
        }
        return links;
    }

    // The Basware file id a url points at: the 'id' query parameter
    // (…/BaswareAttachment?id=1f25932ddee111f1be365f5e), else the last path segment
    // (…/v2/files/1f25932ddee111f1be365f5e). Lower-cased for the fileRefs join; '' if none.
    function getUrlRefId(url) {
        const q = /[?&]id=([^&#]+)/i.exec(url);
        if (q) return decodeURIComponent(q[1]).trim().toLowerCase();
        const p = /\/([^\/?#]+)\/?(?:[?#]|$)/.exec(url);
        return p ? p[1].trim().toLowerCase() : '';
    }

    // OAuth2 client-credentials grant. Returns { accessToken } or { error }.
    // Credentials go in the form body (client_secret_post), which Azure AD / APIM accept.
    function getOAuthToken(tokenUrl, clientId, clientSecret, scope, bumId) {
        const form = {
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret
        };
        if (scope) form.scope = scope;
        const body = Object.keys(form)
            .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(form[k])}`)
            .join('&');

        const response = https.post({
            url: tokenUrl,
            body,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            }
        });

        if (response.code !== 200) {
            return { error: `OAuth token endpoint returned HTTP ${response.code}: ${String(response.body || '').substring(0, 300)}` };
        }

        let parsed;
        try { parsed = JSON.parse(response.body); } catch (e) {
            return { error: `OAuth token response is not JSON: ${String(response.body || '').substring(0, 300)}` };
        }
        if (!parsed.access_token) {
            return { error: `OAuth token response has no access_token: ${String(response.body || '').substring(0, 300)}` };
        }

        log.audit('AP BILL PDF - TOKEN OBTAINED', `bumId: ${bumId} | token_type: ${parsed.token_type || '(none)'} | expires_in: ${parsed.expires_in || '(none)'}`);
        return { accessToken: parsed.access_token };
    }

    // The url is attacker-controllable input as far as this script is concerned: it decides
    // where the bearer token is sent. Only talk to hosts we expect. Returns an error
    // string when the link should be refused, or null when it is safe to proceed.
    function checkHostAllowed(href, allowedParam, bumId) {
        const match = /^https:\/\/([^\/:?#]+)/i.exec(String(href || ''));
        if (!match) return `File link is not an absolute https URL: ${href}`;
        const host = match[1].toLowerCase();

        const allowed = String(allowedParam || '')
            .split(',')
            .map(h => h.trim().toLowerCase())
            .filter(Boolean);

        if (!allowed.length) {
            log.audit('AP BILL PDF - HOST NOT RESTRICTED',
                `bumId: ${bumId} | ${PARAM_API_HOSTS} is blank; sending bearer token to ${host}`);
            return null;
        }
        if (allowed.indexOf(host) === -1) {
            return `Refusing to send bearer token to unexpected host '${host}' (allowed: ${allowed.join(', ')})`;
        }
        return null;
    }

    // 'Invoice_0158087400_1011260127_a.pdf' — ddmmyyhhmm in account time, then the type suffix:
    // '_a' for attachmentFile, '_i' for imageFile, none for any other/missing type.
    // A 2nd, 3rd, ... file with the SAME suffix in one payload gets a '_2', '_3', ... counter
    // before the type suffix so names never clash: 'Invoice_0158087400_1011260127_2_a.pdf'.
    function buildPdfName(tranId, typeSuffix, occurrence) {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const stamp = pad(d.getDate())
            + pad(d.getMonth() + 1)
            + String(d.getFullYear()).slice(-2)
            + pad(d.getHours())
            + pad(d.getMinutes());
        const counter = occurrence && occurrence > 1 ? `_${occurrence}` : '';
        return `Invoice_${tranId || 'UNKNOWN'}_${stamp}${counter}${typeSuffix || ''}.pdf`;
    }

    // https.get hands the body back as a *string*, so the shape depends on how NetSuite
    // interpreted the response. Three cases, distinguished by the leading bytes:
    //
    //   'JVBERi0'  NetSuite already base64-encoded the binary body — pass straight through.
    //   '%PDF'     NetSuite decoded the bytes as text. Everything above 0x7F is now a
    //              replacement character, so the PDF structure survives but the content
    //              streams are destroyed — this is what produces a blank/broken PDF.
    //              Re-encoding cannot recover the lost bytes; see the header note.
    //   other      Unknown (JSON envelope, HTML error page, redirect stub) — logged, and the
    //              caller reports it rather than silently writing a garbage file.
    function toBase64(body, bumId) {
        const s = String(body || '').trim();

        if (s.indexOf('JVBERi0') === 0) {
            return s.replace(/[\r\n\s]/g, '');
        }

        if (s.indexOf('%PDF') === 0) {
            // Basware sends 'application/pdf;charset=utf-8'. The bogus charset makes NetSuite
            // decode the body as text. Whether that is recoverable depends on which decoder
            // ran: a 1:1 byte->char mapping (every code point <= 0xFF) can be rebuilt exactly,
            // whereas strict UTF-8 substitutes U+FFFD for every invalid sequence and the
            // original bytes are gone for good.
            const stats = analyseDecodedBody(s);
            log.audit('AP BILL PDF - BODY ANALYSIS',
                `bumId: ${bumId} | length: ${s.length} | maxCharCode: ${stats.maxCharCode}`
                + ` | replacementChars: ${stats.replacements} | above255: ${stats.above255}`);

            if (stats.replacements === 0 && stats.above255 === 0) {
                log.audit('AP BILL PDF - LOSSLESS RECOVERY',
                    `bumId: ${bumId} | body is a 1:1 byte mapping; rebuilding base64 from char codes`);
                return bytesToBase64(s);
            }

            log.error('AP BILL PDF - RAW BINARY BODY',
                `bumId: ${bumId} | https.get returned PDF bytes decoded as text with`
                + ` ${stats.replacements} replacement characters — the original bytes are`
                + ' unrecoverable. Basware must drop the bogus ";charset=utf-8" from the'
                + ' application/pdf Content-Type, or return the file base64-encoded.');
            return null;
        }

        // A JSON envelope carrying the document is a common Basware pattern — try to find it.
        if (s.indexOf('{') === 0) {
            const embedded = findBase64InJson(s);
            if (embedded) {
                log.audit('AP BILL PDF - BASE64 FROM JSON', `bumId: ${bumId} | extracted ${embedded.length} base64 chars`);
                return embedded;
            }
            log.error('AP BILL PDF - JSON BODY', `bumId: ${bumId} | JSON response with no recognisable base64 content: ${s.substring(0, 300)}`);
            return null;
        }

        log.error('AP BILL PDF - UNRECOGNISED BODY', `bumId: ${bumId} | first 300 chars: ${s.substring(0, 300)}`);
        return null;
    }

    // Tells apart a lossless 1:1 byte->char decode from a lossy UTF-8 one.
    // U+FFFD is the replacement character the decoder emits for invalid byte sequences —
    // a Flate-compressed PDF is full of them, so any non-zero count means data was destroyed.
    function analyseDecodedBody(s) {
        let maxCharCode = 0, replacements = 0, above255 = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c === 0xFFFD) replacements++;
            else if (c > 255) above255++;
            if (c > maxCharCode) maxCharCode = c;
        }
        return { maxCharCode, replacements, above255 };
    }

    // Base64-encodes a string whose char codes are the original bytes (0x00-0xFF).
    // Hand-rolled because N/encode only offers UTF-8 as an input encoding, which would
    // re-expand every high byte into a multi-byte sequence and corrupt the file.
    const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    function bytesToBase64(s) {
        const out = [];
        for (let i = 0; i < s.length; i += 3) {
            const b0 = s.charCodeAt(i) & 0xFF;
            const hasB1 = i + 1 < s.length;
            const hasB2 = i + 2 < s.length;
            const b1 = hasB1 ? s.charCodeAt(i + 1) & 0xFF : 0;
            const b2 = hasB2 ? s.charCodeAt(i + 2) & 0xFF : 0;

            out.push(B64_ALPHABET[b0 >> 2]);
            out.push(B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]);
            out.push(hasB1 ? B64_ALPHABET[((b1 & 0x0F) << 2) | (b2 >> 6)] : '=');
            out.push(hasB2 ? B64_ALPHABET[b2 & 0x3F] : '=');
        }
        return out.join('');
    }

    // Walks a JSON response looking for a property that holds a base64 PDF.
    function findBase64InJson(text) {
        let parsed;
        try { parsed = JSON.parse(text); } catch (e) { return null; }

        const keys = ['content', 'fileContent', 'data', 'document', 'body', 'base64', 'file'];
        for (const key of keys) {
            const value = parsed[key];
            if (typeof value === 'string' && value.indexOf('JVBERi0') === 0) {
                return value.replace(/[\r\n\s]/g, '');
            }
        }
        return null;
    }

    // ── Item resolution ──────────────────────────────────────────────────────
    // Finds the active item whose Vendors sublist has a row for THIS vendor with this Vendor
    // Code — the same data as the Vendor record's Financial > Items subtab. The item search
    // returns one row per item-vendor pair; vendor and code are re-checked on each row so a
    // code that belongs to another vendor of the same item can never match.
    // Returns the item internal ID, or null.
    function findItemByVendorCode(vendorId, vendorCode, bumId) {
        const tag = `bumId: ${bumId} | vendorId: ${vendorId} (${typeof vendorId}) | vendorCode: '${vendorCode}'`;
        log.audit('AP BILL ITEM SEARCH 1 - START', `${tag} | codeLength: ${String(vendorCode || '').length}`);

        if (!vendorId || !vendorCode) {
            log.audit('AP BILL ITEM SEARCH - SKIPPED', `${tag} | vendorId or vendorCode is empty`);
            return null;
        }

        const filters = [
            ['othervendor', 'anyof', vendorId], 'and',
            ['vendorcode', 'is', vendorCode], 'and',
            ['isinactive', 'is', 'F']
        ];
        log.audit('AP BILL ITEM SEARCH 2 - FILTERS', `${tag} | filters: ${JSON.stringify(filters)}`);

        let results;
        try {
            results = search.create({
                type: search.Type.ITEM,
                filters,
                columns: ['internalid', 'itemid', 'othervendor', 'vendorcode']
            }).run().getRange({ start: 0, end: 20 });
        } catch (e) {
            log.error('AP BILL ITEM SEARCH FAILED', `${tag} | ${e.name}: ${e.message}\n${e.stack}`);
            throw e;
        }

        log.audit('AP BILL ITEM SEARCH 3 - RAW RESULTS', `${tag} | rowCount: ${results.length}`
            + (results.length ? ' | rows: ' + results.map(r =>
                `{internalid: ${r.getValue('internalid')}, itemid: ${r.getValue('itemid')},`
                + ` othervendor: ${r.getValue('othervendor')} (${r.getText('othervendor')}),`
                + ` vendorcode: '${r.getValue('vendorcode')}'}`).join(' ; ') : ''));

        const wanted = vendorCode.toLowerCase();
        const itemIds = results
            .filter(r => {
                const vendorOk = String(r.getValue('othervendor')) === String(vendorId);
                const codeOk = String(r.getValue('vendorcode') || '').trim().toLowerCase() === wanted;
                if (!vendorOk || !codeOk) {
                    log.audit('AP BILL ITEM SEARCH - ROW REJECTED',
                        `${tag} | item ${r.getValue('internalid')} | vendorOk: ${vendorOk}`
                        + ` (row vendor '${r.getValue('othervendor')}') | codeOk: ${codeOk}`
                        + ` (row code '${r.getValue('vendorcode')}')`);
                }
                return vendorOk && codeOk;
            })
            .map(r => r.getValue('internalid'))
            .filter((v, i, arr) => arr.indexOf(v) === i);

        log.audit('AP BILL ITEM SEARCH 4 - FILTERED', `${tag} | matching itemIds: [${itemIds.join(', ')}]`);

        if (itemIds.length > 1) {
            log.audit('AP BILL ITEM VENDOR CODE AMBIGUOUS',
                `bumId: ${bumId} | vendor ${vendorId} has vendor code ${vendorCode} on items`
                + ` [${itemIds.join(', ')}] — using ${itemIds[0]}`);
        }

        return itemIds.length ? itemIds[0] : null;
    }

    // Second lookup: an ACTIVE Vendor Supplier Code record for THIS vendor + code whose item is
    // active. Code re-checked case-insensitively; oldest record wins if several match (the
    // learning UE never creates a second one). Non-fatal: a search failure (e.g. the role lacks
    // permission on the record) is logged and treated as "no match", so the line falls back to
    // the generic item instead of failing the bill.
    // Returns the item internal ID, or null.
    function findItemBySupplierCodeRecord(vendorId, vendorCode, bumId) {
        const tag = `bumId: ${bumId} | vendorId: ${vendorId} | supplierCode: '${vendorCode}'`;
        if (!vendorId || !vendorCode) return null;

        let results;
        try {
            results = search.create({
                type: VSC_RECORD,
                filters: [
                    [VSC_VENDOR, 'anyof', vendorId], 'and',
                    [VSC_CODE, 'is', vendorCode], 'and',
                    ['isinactive', 'is', 'F'], 'and',
                    [`${VSC_ITEM}.isinactive`, 'is', 'F']
                ],
                columns: [
                    search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
                    VSC_ITEM,
                    VSC_CODE
                ]
            }).run().getRange({ start: 0, end: 20 });
        } catch (e) {
            log.error('AP BILL SUPPLIER CODE SEARCH FAILED', `${tag} | ${e.name}: ${e.message}`);
            return null;
        }

        const wanted = vendorCode.toLowerCase();
        const itemIds = results
            .filter(r => String(r.getValue(VSC_CODE) || '').trim().toLowerCase() === wanted)
            .map(r => String(r.getValue(VSC_ITEM) || ''))
            .filter((v, i, arr) => v && arr.indexOf(v) === i);

        log.audit('AP BILL SUPPLIER CODE SEARCH', `${tag} | rowCount: ${results.length} | matching itemIds: [${itemIds.join(', ')}]`);

        if (itemIds.length > 1) {
            log.audit('AP BILL SUPPLIER CODE AMBIGUOUS',
                `${tag} | mapped to items [${itemIds.join(', ')}] — using ${itemIds[0]} (oldest record)`);
        }
        return itemIds.length ? itemIds[0] : null;
    }

    // Diagnostics only, run once per line when NO candidate code matched — never changes the
    // outcome. Two searches regardless of how many codes were tried:
    //   A. the codes alone (any vendor, active or not): on a different vendor / inactive item?
    //   B. the vendor alone: which Vendor Codes does NetSuite actually hold for this vendor?
    function logItemSearchDiagnostics(vendorId, vendorCodes, tag) {
        tag = `${tag} | codes tried: [${vendorCodes.join(', ')}]`;
        try {
            const codeFilters = [];
            vendorCodes.forEach((code, i) => {
                if (i) codeFilters.push('or');
                codeFilters.push(['vendorcode', 'is', code]);
            });
            const byCode = search.create({
                type: search.Type.ITEM,
                filters: codeFilters,
                columns: ['internalid', 'itemid', 'isinactive', 'othervendor', 'vendorcode']
            }).run().getRange({ start: 0, end: 20 });
            log.audit('AP BILL ITEM SEARCH DIAG A - CODE ANY VENDOR', `${tag} | rowCount: ${byCode.length}`
                + (byCode.length ? ' | rows: ' + byCode.map(r =>
                    `{internalid: ${r.getValue('internalid')}, itemid: ${r.getValue('itemid')},`
                    + ` inactive: ${r.getValue('isinactive')}, othervendor: ${r.getValue('othervendor')}`
                    + ` (${r.getText('othervendor')}), vendorcode: '${r.getValue('vendorcode')}'}`).join(' ; ') : ''));
        } catch (e) {
            log.error('AP BILL ITEM SEARCH DIAG A FAILED', `${tag} | ${e.name}: ${e.message}`);
        }

        try {
            const byVendor = search.create({
                type: search.Type.ITEM,
                filters: [['othervendor', 'anyof', vendorId]],
                columns: ['internalid', 'itemid', 'isinactive', 'othervendor', 'vendorcode']
            }).run().getRange({ start: 0, end: 50 });
            log.audit('AP BILL ITEM SEARCH DIAG B - VENDOR ITEMS', `${tag} | rowCount (max 50): ${byVendor.length}`
                + (byVendor.length ? ' | rows: ' + byVendor.map(r =>
                    `{internalid: ${r.getValue('internalid')}, itemid: ${r.getValue('itemid')},`
                    + ` inactive: ${r.getValue('isinactive')}, othervendor: ${r.getValue('othervendor')},`
                    + ` vendorcode: '${r.getValue('vendorcode')}'}`).join(' ; ') : ''));
        } catch (e) {
            log.error('AP BILL ITEM SEARCH DIAG B FAILED', `${tag} | ${e.name}: ${e.message}`);
        }
    }

    return { post };
});
