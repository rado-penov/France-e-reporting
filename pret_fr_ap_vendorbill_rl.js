/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 *
 * Inbound AP JSON -> Vendor Bill RESTlet. Accepts Basware "BUM" JSON (same vendor as the
 * outbound NetSuite -> Basware UBL webhook, opposite direction) and creates a Vendor Bill.
 *
 * Vendor resolution: matched by FR:SIRET (custentity_pret_siret on the Vendor record) —
 * the payload never carries a NetSuite internal ID.
 *
 * Idempotency: bumId (top-level UUID on the payload) is matched against BUM_ID_FIELD on
 * the Vendor Bill. A repeat bumId returns the existing internal ID instead of duplicating.
 *
 * PO handling: only the standalone (isIssuedAgainstOrder = false) path is implemented.
 * PO-matched bills are rejected with a not-yet-implemented message pending mapping decisions.
 * Standalone bills are left to NetSuite's own approval routing default (Pending Approval on
 * creation) — this script does not set an approval status field itself.
 *
 * Response contract: always HTTP 200; body is { success, internalId, bumId, message }.
 * TBC — confirm with Basware whether differentiated HTTP status codes per failure type
 * are actually required, or whether a body-level success flag is sufficient.
 *
 * Line coding: lines are built on the 'item' sublist (not 'expense'), with the NetSuite
 * Item resolved by matching data.invoiceLines[].item.sellersItem.id against the Item
 * record's own `itemid` field. Account and tax code are intentionally left unset per line —
 * both default from that resolved item's own settings (confirmed 2026-07-17). The AP account
 * on the bill header is likewise never set explicitly; it always defaults to the vendor's
 * payables account. If a manual tax override is ever needed, the vendor's own `taxitem`
 * field is the fallback — not implemented for now.
 *
 * TBC / open items (see AP-JSON-to-VendorBill-Integration.md):
 *   - Currency: left to default from the resolved vendor rather than set explicitly from
 *     documentCurrencyCode — TBC whether that ever needs reconciling.
 */
define(['N/record', 'N/search', 'N/log'],
(record, search, log) => {

    const BUM_ID_FIELD        = 'custbody_pret_uuid';        // existing field, also used by pret_fr_evendorcredit_ue.js
    const VENDOR_SIRET_FIELD  = 'custentity_pret_siret';

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

            if (data.isIssuedAgainstOrder) {
                log.error('AP BILL PO-MATCHED NOT SUPPORTED', `bumId: ${bumId} | orderReference: ${JSON.stringify(data.orderReference || {})}`);
                return { success: false, bumId, message: 'PO-matched bills are not yet supported by this RESTlet' };
            }

            const siret = getSiret(data);
            if (!siret) {
                return { success: false, bumId, message: 'No FR:SIRET identification found in accountingSupplierParty.partyIdentifications' };
            }

            const vendorId = findVendorBySiret(siret);
            if (!vendorId) {
                log.error('AP BILL VENDOR NOT FOUND', `bumId: ${bumId} | SIRET: ${siret}`);
                return { success: false, bumId, message: `No vendor found for SIRET ${siret}` };
            }
            log.audit('AP BILL STEP 3 - VENDOR RESOLVED', `bumId: ${bumId} | SIRET: ${siret} | vendorId: ${vendorId}`);

            const vendor = record.load({ type: record.Type.VENDOR, id: vendorId });
            const subsidiaryId = vendor.getValue('subsidiary');

            const bill = record.create({ type: record.Type.VENDOR_BILL, isDynamic: true });
            bill.setValue('entity', vendorId);
            if (subsidiaryId) bill.setValue('subsidiary', subsidiaryId);
            if (data.issueDate) bill.setValue('trandate', new Date(data.issueDate));
            bill.setValue('tranid', (data.externalDocumentIdentifier && data.externalDocumentIdentifier.id) || '');
            bill.setValue(BUM_ID_FIELD, bumId);
            log.audit('AP BILL STEP 4 - HEADER SET', `bumId: ${bumId} | vendorId: ${vendorId} | subsidiary: ${subsidiaryId}`);

            const lines = data.invoiceLines || [];
            if (!lines.length) {
                return { success: false, bumId, message: 'No invoiceLines in payload' };
            }

            for (const line of lines) {
                const qty          = (line.quantity && line.quantity.amount) || 1;
                const price        = (line.price && line.price.amount) || 0;
                const sellersItemId = line.item && line.item.sellersItem && line.item.sellersItem.id;
                if (!sellersItemId) throw new Error(`Line ${line.id || ''} missing item.sellersItem.id`);

                const itemId = findItemBySellersId(sellersItemId);
                if (!itemId) throw new Error(`No NetSuite item found with itemid ${sellersItemId}`);

                bill.selectNewLine({ sublistId: 'item' });
                bill.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item',     value: itemId });
                bill.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: qty });
                bill.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate',     value: price });
                bill.commitLine({ sublistId: 'item' });
            }
            log.audit('AP BILL STEP 5 - LINES SET', `bumId: ${bumId} | lineCount: ${lines.length}`);

            const internalId = bill.save();
            log.audit('AP BILL COMPLETE', `bumId: ${bumId} | internalId: ${internalId}`);
            return { success: true, internalId, bumId, message: 'Vendor bill created, Pending Approval' };

        } catch (e) {
            log.error('AP BILL FAILED', `bumId: ${bumId} | ${e.name}: ${e.message}\n${e.stack}`);
            return { success: false, bumId, message: `${e.name}: ${e.message}` };
        }
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

    // ── Vendor resolution ────────────────────────────────────────────────────
    function getSiret(data) {
        const ids = (data.accountingSupplierParty && data.accountingSupplierParty.partyIdentifications) || [];
        const match = ids.find(pid => pid.schemeId === 'FR:SIRET');
        return match ? match.id : null;
    }

    function findVendorBySiret(siret) {
        const results = search.create({
            type: record.Type.VENDOR,
            filters: [[VENDOR_SIRET_FIELD, 'is', siret]],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });
        return results.length ? results[0].getValue('internalid') : null;
    }

    // ── Item resolution ──────────────────────────────────────────────────────
    // Matches invoiceLines[].item.sellersItem.id against the Item record's own 'itemid' field.
    function findItemBySellersId(sellersItemId) {
        const results = search.create({
            type: search.Type.ITEM,
            filters: [['itemid', 'is', sellersItemId]],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });
        return results.length ? results[0].getValue('internalid') : null;
    }

    return { post };
});
