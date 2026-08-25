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
 * Source PDF: the payload carries a `links` array; the entry with rel = 'file' is a Basware
 * API URL for the original supplier PDF. After the bill is saved (so the NetSuite tranid
 * exists) the PDF is downloaded with HTTP Basic auth, filed in the File Cabinet as
 * Invoice_<tranid>_<ddmmyyhhmm>.pdf and attached to the bill. This is best-effort: a
 * download failure is logged and reported in the response but never fails the bill.
 *
 * The download URL is NOT a parameter — it arrives in the payload as an absolute href. Because
 * that href decides where the API credentials get sent, it is checked against an allowlist of
 * hosts before the request goes out (custscript_pret_ap_api_hosts).
 *
 * Script parameters (all set on the Script record, valued per deployment):
 *   custscript_pret_ap_pdf_folder    Integer  — File Cabinet folder internal ID
 *   custscript_pret_ap_api_user      Free-Form Text — Basware API username
 *   custscript_pret_ap_api_password  Password — Basware API password
 *   custscript_pret_ap_api_hosts     Free-Form Text — comma-separated allowed hosts for the
 *                                    file link, e.g. 'test-api.basware.com'. Blank = no
 *                                    restriction (logged as a warning).
 *
 * TBC / open items (see AP-JSON-to-VendorBill-Integration.md):
 *   - Currency: left to default from the resolved vendor rather than set explicitly from
 *     documentCurrencyCode — TBC whether that ever needs reconciling.
 *   - PDF response encoding: NetSuite returns https.get bodies as strings. toBase64() below
 *     handles both an already-base64 body and a raw '%PDF' body — confirm against the live
 *     Basware endpoint which one it actually sends.
 */
define(['N/record', 'N/search', 'N/log', 'N/https', 'N/file', 'N/encode', 'N/runtime'],
(record, search, log, https, file, encode, runtime) => {

    const BUM_ID_FIELD        = 'custbody_pret_uuid';        // existing field, also used by pret_fr_evendorcredit_ue.js
    const VENDOR_SIRET_FIELD  = 'custentity_pret_siret';
    const APPROVAL_STATUS_FIELD = 'approvalstatus';
    const PENDING_APPROVAL_VALUE = '1';

    const PARAM_PDF_FOLDER    = 'custscript_pret_ap_pdf_folder';
    const PARAM_API_USER      = 'custscript_pret_ap_api_user';
    const PARAM_API_PASSWORD  = 'custscript_pret_ap_api_password';
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

            log.audit('AP BILL COMPLETE', `bumId: ${bumId} | internalId: ${internalId} | pdfFileId: ${pdf.fileId}`);
            return {
                success: true,
                internalId,
                bumId,
                pdfFileId: pdf.fileId,
                pdfMessage: pdf.message,
                message: 'Vendor bill created and marked Pending Approval'
            };

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

    // ── Supplier PDF: download from Basware and file in the File Cabinet ─────
    // Runs after bill.save() so the NetSuite tranid is available for the filename.
    // Best-effort: never throws — a failure here must not roll back a valid bill.
    function attachSupplierPdf(requestBody, internalId, bumId) {
        try {
            const href = getFileLink(requestBody);
            if (!href) {
                log.audit('AP BILL PDF - NO FILE LINK', `bumId: ${bumId} | no links entry with rel='file'`);
                return { fileId: null, message: 'No file link in payload' };
            }

            const script     = runtime.getCurrentScript();
            const folderId   = script.getParameter({ name: PARAM_PDF_FOLDER });
            const apiUser    = script.getParameter({ name: PARAM_API_USER });
            const apiPassword = script.getParameter({ name: PARAM_API_PASSWORD });

            if (!folderId)                return failPdf(bumId, `Script parameter ${PARAM_PDF_FOLDER} is not set`);
            if (!apiUser || !apiPassword) return failPdf(bumId, `Script parameters ${PARAM_API_USER} / ${PARAM_API_PASSWORD} are not set`);

            const hostError = checkHostAllowed(href, script.getParameter({ name: PARAM_API_HOSTS }), bumId);
            if (hostError) return failPdf(bumId, hostError);

            const tranId = search.lookupFields({
                type: search.Type.VENDOR_BILL,
                id: internalId,
                columns: ['tranid']
            }).tranid;

            log.audit('AP BILL PDF - DOWNLOADING', `bumId: ${bumId} | tranid: ${tranId} | url: ${href}`);

            // Headers mirror the Postman request that is known to return a valid PDF.
            // Basware wants Content-Type: application/json even on this GET, and Accept: */*
            // rather than application/pdf — narrowing Accept changes what the API returns.
            const response = https.get({
                url: href,
                headers: {
                    Authorization: basicAuthHeader(apiUser, apiPassword),
                    'Content-Type': 'application/json',
                    Accept: '*/*'
                }
            });

            if (response.code !== 200) {
                return failPdf(bumId, `Basware returned HTTP ${response.code}: ${String(response.body || '').substring(0, 300)}`);
            }

            const rawBody = String(response.body || '');
            const headers = response.headers || {};
            const contentType = headers['Content-Type'] || headers['content-type'] || '(none)';

            // Diagnostic: the shape of this body decides how it must be encoded. Keep this —
            // a blank PDF is almost always visible here as a length or prefix mismatch.
            log.audit('AP BILL PDF - RESPONSE',
                `bumId: ${bumId} | code: ${response.code} | contentType: ${contentType}`
                + ` | bodyLength: ${rawBody.length} | first64: ${rawBody.substring(0, 64)}`);

            if (!rawBody.length) {
                return failPdf(bumId, 'Basware returned HTTP 200 with an empty body — nothing to save');
            }

            const contents = toBase64(rawBody, bumId);
            if (!contents) {
                return failPdf(bumId, 'Could not derive base64 PDF content from the response body');
            }

            const fileName = buildPdfName(tranId);
            const pdfFile = file.create({
                name: fileName,
                fileType: file.Type.PDF,
                contents,                            // binary file types expect base64 contents
                folder: Number(folderId),
                isOnline: false
            });
            const fileId = pdfFile.save();
            log.audit('AP BILL PDF - SAVED', `bumId: ${bumId} | fileId: ${fileId} | name: ${fileName} | folder: ${folderId}`);

            // Attach separately: the file is already safely in the cabinet at this point, so an
            // attach failure must still report the fileId rather than collapse into failPdf().
            try {
                record.attach({
                    record: { type: 'file', id: fileId },
                    to:     { type: record.Type.VENDOR_BILL, id: internalId }
                });
                log.audit('AP BILL PDF - ATTACHED', `bumId: ${bumId} | fileId: ${fileId} attached to vendor bill ${internalId} (Communication > Files)`);
                return { fileId, message: `Saved as ${fileName} and attached to the bill` };
            } catch (attachErr) {
                log.error('AP BILL PDF ATTACH FAILED', `bumId: ${bumId} | fileId: ${fileId} | internalId: ${internalId} | ${attachErr.name}: ${attachErr.message}`);
                return { fileId, message: `Saved as ${fileName} but not attached: ${attachErr.message}` };
            }

        } catch (e) {
            return failPdf(bumId, `${e.name}: ${e.message}`);
        }
    }

    function failPdf(bumId, message) {
        log.error('AP BILL PDF FAILED', `bumId: ${bumId} | ${message}`);
        return { fileId: null, message };
    }

    // links[] may sit at the top level of the payload or under data — accept either.
    function getFileLink(requestBody) {
        const links = (requestBody && requestBody.links)
            || (requestBody && requestBody.data && requestBody.data.links)
            || [];
        const match = links.find(l => l && l.rel === 'file'
            && (!l.method || String(l.method).toUpperCase() === 'GET'));
        return match ? match.href : null;
    }

    // The href is attacker-controllable input as far as this script is concerned: it decides
    // where the Basware credentials are sent. Only talk to hosts we expect. Returns an error
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
                `bumId: ${bumId} | ${PARAM_API_HOSTS} is blank; sending credentials to ${host}`);
            return null;
        }
        if (allowed.indexOf(host) === -1) {
            return `Refusing to send credentials to unexpected host '${host}' (allowed: ${allowed.join(', ')})`;
        }
        return null;
    }

    function basicAuthHeader(user, password) {
        // encode.convert can wrap long output across lines; headers must be a single line.
        const encoded = encode.convert({
            string: `${user}:${password}`,
            inputEncoding: encode.Encoding.UTF_8,
            outputEncoding: encode.Encoding.BASE_64
        }).replace(/[\r\n]/g, '');
        return `Basic ${encoded}`;
    }

    // 'Invoice_INVFR123456_1408261036.pdf' — ddmmyyhhmm in account time.
    function buildPdfName(tranId) {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const stamp = pad(d.getDate())
            + pad(d.getMonth() + 1)
            + String(d.getFullYear()).slice(-2)
            + pad(d.getHours())
            + pad(d.getMinutes());
        return `Invoice_${tranId || 'UNKNOWN'}_${stamp}.pdf`;
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
