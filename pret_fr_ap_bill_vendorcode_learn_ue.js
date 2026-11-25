/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * Version history (date = commit date):
 *   v1.0.0  (2026-11-15) - Initial release: on Vendor Bill EDIT of a RESTlet-created bill, a line
 *                          that carries a Basware vendor code and whose item was changed keeps
 *                          its original description, and after save the bill's vendor + that
 *                          code are added to the new item's Vendors sublist ("teaching" the
 *                          item mapping).
 *   v1.1.0  (2026-11-18) - Mappings are written to the Vendor Supplier Code custom record
 *                          (customrecord_pret_vendor_suppler_code: Item / Vendor / Supplier
 *                          Code, shown as a sublist on the item) instead of the item's native
 *                          Vendors sublist. The native sublist holds ONE code per vendor per item
 *                          ("Vendor/Subsidiary must be unique"); the custom record holds any
 *                          number, so e.g. two supplier codes of the same vendor can both point
 *                          to 'Food - Taxable'. Items are no longer loaded or saved.
 *
 * Vendor Bill — learn Basware supplier codes.
 *
 * pret_fr_ap_vendorbill_rl.js puts the Basware generic item on a line whose supplier code is not
 * mapped for the vendor, and keeps that code on custcol_pret_vendor_code_basware. When a user
 * then edits the bill and replaces the item with the right one, this script records the mapping
 * (Vendor + Supplier Code -> Item) as a Vendor Supplier Code record, so the next bill from that
 * vendor with the same code resolves to the item automatically.
 *
 * Trigger: EDIT only (create / xedit / copy etc. are ignored).
 *
 * Bill filter: ONLY bills created by the AP RESTlet (pret_fr_ap_vendorbill_rl.js) — bills created
 *   in the UI, by CSV or by any other script are skipped entirely. Same rule as
 *   pret_fr_transaction_status_notification_ue.js: the RESTlet sets custbody_pret_uuid (bumId)
 *   but never custbody_pret_ubl_export_ready, whereas pret_fr_ebilling_ue.js stamps BOTH on
 *   every non-RESTlet bill. So RESTlet-created = uuid set AND export-ready not ticked. Read from
 *   the pre-edit record, so nothing the user changes in this edit can switch it on.
 *
 * Line filter: ONLY lines where custcol_pret_vendor_code_basware is NOT empty — every other line
 *   (item resolved correctly by the RESTlet) is skipped before anything else is read. Of those,
 *   a line is processed only when ALL of these hold:
 *   - the line existed before the edit (matched to the old record by lineuniquekey);
 *   - its item changed in this edit, and the new item is not the Basware generic item.
 *
 * beforeSubmit: the line's description is restored to its pre-edit value — changing the item
 *   makes NetSuite source the new item's own description over the supplier's text.
 * afterSubmit: for each (vendor, supplier code) on the changed lines — one mapping per line, so
 *   several codes can map to the same item:
 *     - an active mapping record already maps the code to THIS item    → nothing to do;
 *     - an active mapping record maps the code to ANOTHER item         → skipped, logged;
 *     - the item's native Vendors sublist already has this vendor+code → nothing to do;
 *     - another item's native Vendors sublist has this vendor+code     → skipped, logged;
 *     - otherwise                                                      → mapping record created.
 *   Rule: one vendor + code maps to exactly ONE item, so the RESTlet never finds two. Only
 *   active mappings to active items count — the same ones the RESTlet uses — so deactivating a
 *   wrong mapping lets the next correction create the right one.
 *   The same code on two changed lines of one bill with different items: the first line wins.
 *   Best-effort: a failure on one code is logged and never affects the others or the bill.
 *
 * Permissions: the user editing the bill (or the deployment's Execute As role) needs Create on
 *   the Vendor Supplier Code record.
 *
 * custcol_pret_vendor_code_basware is NOT cleared — it stays on the line as an audit trail.
 */
define(['N/record', 'N/search', 'N/log'], (record, search, log) => {

    const VENDOR_CODE_COL = 'custcol_pret_vendor_code_basware';
    const UUID_FIELD = 'custbody_pret_uuid';                          // set by the RESTlet (bumId)
    const UBL_EXPORT_READY_FIELD = 'custbody_pret_ubl_export_ready';  // set only on non-RESTlet bills
    const DEFAULT_ITEM_ID = '49662';            // Basware generic item (same as the RESTlet)

    // Vendor Supplier Code custom record (child of Item -> sublist on the item's Purchasing tab).
    // IDs as created in the account (note 'suppler').
    const VSC_RECORD = 'customrecord_pret_vendor_suppler_code';
    const VSC_ITEM   = 'custrecord_pret_vc_item';
    const VSC_VENDOR = 'custrecord_pret_vc_vendor';
    const VSC_CODE   = 'custrecord_pret_vc_supplier_code';

    function beforeSubmit(context) {
        if (context.type !== context.UserEventType.EDIT) return;
        const billId = context.newRecord.id;

        try {
            if (!isRestletCreated(context.oldRecord, billId)) return;

            const changes = getChangedVendorCodeLines(context.oldRecord, context.newRecord);
            log.audit('BILL VENDOR CODE LEARN - BEFORE SUBMIT',
                `bill ${billId} | ${changes.length} line(s) with a Basware vendor code and a changed item`);

            for (const c of changes) {
                if (!c.oldDescription || c.oldDescription === c.newDescription) continue;
                context.newRecord.setSublistValue({
                    sublistId: 'item', fieldId: 'description', line: c.line, value: c.oldDescription
                });
                log.audit('BILL VENDOR CODE LEARN - DESCRIPTION KEPT',
                    `bill ${billId} | line ${c.line + 1} | item ${c.oldItem} -> ${c.newItem}`
                    + ` | description restored to '${c.oldDescription}' (was '${c.newDescription}')`);
            }
        } catch (e) {
            log.error('BILL VENDOR CODE LEARN - BEFORE SUBMIT FAILED', `bill ${billId} | ${e.name}: ${e.message}\n${e.stack}`);
        }
    }

    function afterSubmit(context) {
        if (context.type !== context.UserEventType.EDIT) return;
        const bill = context.newRecord;
        const billId = bill.id;

        try {
            if (!isRestletCreated(context.oldRecord, billId)) return;

            const changes = getChangedVendorCodeLines(context.oldRecord, bill);
            if (!changes.length) {
                log.audit('BILL VENDOR CODE LEARN - NOTHING TO LEARN', `bill ${billId}`);
                return;
            }

            const vendorId = String(bill.getValue('entity') || '');
            log.audit('BILL VENDOR CODE LEARN - AFTER SUBMIT',
                `bill ${billId} | vendor ${vendorId}`
                + ` | pairs: ${changes.map(c => `line ${c.line + 1}: '${c.vendorCode}' -> item ${c.newItem}`).join(' ; ')}`);
            if (!vendorId) {
                log.audit('BILL VENDOR CODE LEARN - NO VENDOR', `bill ${billId} | bill has no vendor — nothing learned`);
                return;
            }

            // One mapping per code. The same code twice on this bill: first line wins.
            const itemByCode = {};
            for (const c of changes) {
                const key = c.vendorCode.toLowerCase();
                if (itemByCode[key]) {
                    if (itemByCode[key] !== c.newItem) {
                        log.audit('BILL VENDOR CODE LEARN - CONFLICT ON BILL',
                            `bill ${billId} | line ${c.line + 1} | code '${c.vendorCode}' -> item ${c.newItem}`
                            + ` ignored: an earlier line on this bill maps the same code to item ${itemByCode[key]}`);
                    }
                    continue;
                }
                itemByCode[key] = c.newItem;

                try {
                    learnCode(vendorId, c, billId);
                } catch (e) {
                    log.error('BILL VENDOR CODE LEARN - CODE FAILED',
                        `bill ${billId} | line ${c.line + 1} | vendor ${vendorId} | code '${c.vendorCode}'`
                        + ` | item ${c.newItem} | ${e.name}: ${e.message}\n${e.stack}`);
                }
            }
        } catch (e) {
            log.error('BILL VENDOR CODE LEARN - AFTER SUBMIT FAILED', `bill ${billId} | ${e.name}: ${e.message}\n${e.stack}`);
        }
    }

    // True only for a bill created by pret_fr_ap_vendorbill_rl.js: bumId on custbody_pret_uuid
    // and custbody_pret_ubl_export_ready NOT ticked (pret_fr_ebilling_ue.js ticks it, together
    // with its own uuid, on every bill created any other way). Checked on the pre-edit record.
    function isRestletCreated(rec, billId) {
        const uuid = rec ? String(rec.getValue(UUID_FIELD) || '').trim() : '';
        const exportReady = rec ? rec.getValue(UBL_EXPORT_READY_FIELD) : null;
        const isExportReady = exportReady === true || exportReady === 'T';
        const ok = !!uuid && !isExportReady;
        if (!ok) {
            log.audit('BILL VENDOR CODE LEARN - SKIPPED, NOT A RESTLET BILL',
                `bill ${billId} | ${UUID_FIELD}: '${uuid}' | ${UBL_EXPORT_READY_FIELD}: ${exportReady}`);
        }
        return ok;
    }

    // Lines of newRec that carry a vendor code AND whose item differs from the same line on
    // oldRec (matched by lineuniquekey). Returns [{ line, vendorCode, oldItem, newItem,
    // oldDescription, newDescription }].
    function getChangedVendorCodeLines(oldRec, newRec) {
        const oldByKey = {};
        const oldCount = oldRec ? oldRec.getLineCount({ sublistId: 'item' }) : 0;
        for (let i = 0; i < oldCount; i++) {
            const key = oldRec.getSublistValue({ sublistId: 'item', fieldId: 'lineuniquekey', line: i });
            if (!key) continue;
            oldByKey[key] = {
                item: String(oldRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }) || ''),
                description: oldRec.getSublistValue({ sublistId: 'item', fieldId: 'description', line: i }) || ''
            };
        }

        const out = [];
        const count = newRec.getLineCount({ sublistId: 'item' });
        for (let i = 0; i < count; i++) {
            // Line filter, checked FIRST: only lines with a Basware vendor code. Empty = the
            // RESTlet resolved the item correctly — skip without reading anything else.
            const vendorCode = String(newRec.getSublistValue({ sublistId: 'item', fieldId: VENDOR_CODE_COL, line: i }) || '').trim();
            if (!vendorCode) continue;

            const key = newRec.getSublistValue({ sublistId: 'item', fieldId: 'lineuniquekey', line: i });
            const old = key && oldByKey[key];
            if (!old) continue;                                         // new line in this edit — no "before" item

            const newItem = String(newRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }) || '');
            if (!newItem || newItem === old.item || newItem === DEFAULT_ITEM_ID) continue;

            out.push({
                line: i,
                vendorCode,
                oldItem: old.item,
                newItem,
                oldDescription: old.description,
                newDescription: newRec.getSublistValue({ sublistId: 'item', fieldId: 'description', line: i }) || ''
            });
        }
        return out;
    }

    // Creates the Vendor Supplier Code record for (vendor, code) -> item, unless the code is
    // already mapped for this vendor (to this item: nothing to do; to another item: skipped).
    function learnCode(vendorId, c, billId) {
        const tag = `bill ${billId} | line ${c.line + 1} | vendor ${vendorId} | code '${c.vendorCode}' | item ${c.newItem}`;

        const mapped = findMappedItems(vendorId, c.vendorCode);
        if (mapped.indexOf(c.newItem) !== -1) {
            log.audit('BILL VENDOR CODE LEARN - ALREADY MAPPED', `${tag} | a Vendor Supplier Code record already maps it`);
            return;
        }
        if (mapped.length) {
            log.audit('BILL VENDOR CODE LEARN - CODE ALREADY USED',
                `${tag} | code is already mapped to item(s) [${mapped.join(', ')}] for this vendor (Vendor Supplier Code)`
                + ' — not added, to avoid two items for one code. Fix or deactivate the mapping manually if needed.');
            return;
        }

        const native = findNativeItems(vendorId, c.vendorCode);
        if (native.indexOf(c.newItem) !== -1) {
            log.audit('BILL VENDOR CODE LEARN - ALREADY KNOWN', `${tag} | the item's own Vendors sublist already has this vendor + code`);
            return;
        }
        if (native.length) {
            log.audit('BILL VENDOR CODE LEARN - CODE ALREADY USED',
                `${tag} | code is already the native vendor code of item(s) [${native.join(', ')}] for this vendor`
                + ' — not added, to avoid two items for one code. Fix the item records manually if needed.');
            return;
        }

        // Dynamic mode so the Vendor ID field sources from the vendor as it does in the UI.
        const rec = record.create({ type: VSC_RECORD, isDynamic: true });
        rec.setValue({ fieldId: VSC_ITEM, value: c.newItem });
        rec.setValue({ fieldId: VSC_VENDOR, value: vendorId });
        rec.setValue({ fieldId: VSC_CODE, value: c.vendorCode });
        const id = rec.save();
        log.audit('BILL VENDOR CODE LEARN - MAPPING CREATED', `${tag} | Vendor Supplier Code record ${id} created`);
    }

    // Items an ACTIVE Vendor Supplier Code record maps this vendor + code to (active items
    // only — the same rows the RESTlet uses). Code compared case-insensitively.
    function findMappedItems(vendorId, vendorCode) {
        const results = search.create({
            type: VSC_RECORD,
            filters: [
                [VSC_VENDOR, 'anyof', vendorId], 'and',
                [VSC_CODE, 'is', vendorCode], 'and',
                ['isinactive', 'is', 'F'], 'and',
                [`${VSC_ITEM}.isinactive`, 'is', 'F']
            ],
            columns: [VSC_ITEM, VSC_CODE]
        }).run().getRange({ start: 0, end: 20 });

        const wanted = vendorCode.toLowerCase();
        return unique(results
            .filter(r => String(r.getValue(VSC_CODE) || '').trim().toLowerCase() === wanted)
            .map(r => String(r.getValue(VSC_ITEM) || ''))
            .filter(Boolean));
    }

    // Active items whose native Vendors sublist has this vendor + code (same search as the
    // RESTlet's first lookup).
    function findNativeItems(vendorId, vendorCode) {
        const results = search.create({
            type: search.Type.ITEM,
            filters: [
                ['othervendor', 'anyof', vendorId], 'and',
                ['vendorcode', 'is', vendorCode], 'and',
                ['isinactive', 'is', 'F']
            ],
            columns: ['internalid', 'othervendor', 'vendorcode']
        }).run().getRange({ start: 0, end: 20 });

        const wanted = vendorCode.toLowerCase();
        return unique(results
            .filter(r => String(r.getValue('othervendor')) === String(vendorId)
                && String(r.getValue('vendorcode') || '').trim().toLowerCase() === wanted)
            .map(r => String(r.getValue('internalid'))));
    }

    function unique(arr) {
        return arr.filter((v, i) => arr.indexOf(v) === i);
    }

    return { beforeSubmit, afterSubmit };
});
