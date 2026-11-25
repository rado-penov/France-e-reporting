/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 *
 * Version history (date = commit date):
 *   v1.0.0  (2026-08-21) - Initial release: inbound Basware BUM JSON -> Vendor Credit; lines
 *                          read from invoiceLines.
 *   v1.0.1  (2026-08-28) - Basware Generic Item fallback for unmatched lines; RESTlet-created
 *                          credits skipped by the UBL export.
 *   v1.0.2  (2026-10-01) - Duplicate France vendor credits blocked by vendor + reference number.
 *   v1.0.3  (2026-10-21) - Transaction date off-by-one fixed.
 *   v1.1.0  (2026-11-18) - Supplier PDF handling brought level with the bill RESTlet: EVERY file
 *                          url is downloaded (attachments[].url, else every links[] rel='file'),
 *                          one file per url as CreditMemo_<tranid>_<ddmmyyhhmm>[_n].pdf, each
 *                          url best-effort and independent. HTTP Basic auth replaced by an
 *                          OAuth2 client-credentials bearer token (new _vc OAuth parameters;
 *                          _api_user_vc / _api_password_vc no longer read); Azure SAS urls are
 *                          fetched without a token. Response adds pdfFileIds and pdfFiles.
 *                          Host allowlist must now include api.basware.com.
 *
 * Inbound AP JSON -> Vendor Credit RESTlet. Accepts Basware "BUM" JSON (same vendor as the
 * outbound NetSuite -> Basware UBL webhook, opposite direction) and creates a Vendor Credit.
 * Sibling of pret_fr_ap_vendorbill_rl.js — same logic, credit-note-shaped payload.
 *
 * Vendor resolution: matched by FR:SIRET (custentity_pret_siret on the Vendor record) —
 * the payload never carries a NetSuite internal ID.
 *
 * Idempotency: bumId (top-level UUID on the payload) is matched against BUM_ID_FIELD on
 * the Vendor Credit. A repeat bumId returns the existing internal ID instead of duplicating.
 *
 * Duplicate protection: a DIFFERENT bumId whose supplier credit note number already exists as a
 * vendor credit for the same vendor (created via UI, RESTlet or anything else) is refused with
 * { success: false, existingInternalId, message }. The same rule is enforced again at save time
 * by pret_fr_evendorcredit_ue.js beforeSubmit (PRET_DUPLICATE_CREDIT), which also owns the
 * vendor-scoped externalid backstop — this script does not set externalid itself.
 *
 * PO handling: only the standalone (isIssuedAgainstOrder = false) path is implemented.
 * PO-matched credits are rejected with a not-yet-implemented message pending mapping decisions.
 * Standalone credits are left to NetSuite's own approval routing default (Pending Approval on
 * creation) — this script does not set an approval status field itself.
 *
 * Line coding: lines are built on the 'item' sublist (not 'expense'), with the NetSuite
 * Item resolved by matching data.creditNoteLines[].item's own seller item code against the
 * Item record's `itemid` field. Unlike the vendor bill payload, credit note lines observed so
 * far do not carry an item.sellersItem.id — the resolver checks item.sellersItem.id first (for
 * parity with the vendor bill shape) and falls back to item.name when it's absent (confirmed
 * against the 2026-08-20 sample payload, where lines carry only item.name, e.g. "600021").
 * Account and tax code are intentionally left unset per line — both default from that resolved
 * item's own settings, same as the vendor bill RESTlet. The AP account on the credit header is
 * likewise never set explicitly; it always defaults to the vendor's payables account.
 *
 * Supplier PDFs (ported from pret_fr_ap_vendorbill_rl.js, 2026-10-23): EVERY file url on the
 * payload is downloaded after save, filed in the File Cabinet as
 * CreditMemo_<tranid>_<ddmmyyhhmm>[_n].pdf and attached to the credit — one file per url. The
 * urls come from `attachments[].url` when present (same shape as the bill payload); otherwise
 * from every `links[]` entry with rel = 'file' — the live Basware credit-note payload
 * (2026-10-23, Egencia FRC4999648) carries two such links (attachmentFile + imageFile) and no
 * attachments[] at all. Authenticated with an OAuth2 client-credentials bearer token fetched
 * once from the configured token endpoint and shared across the downloads — unless the url is
 * an Azure SAS link (has a `sig=` query parameter), which is fetched with no Authorization
 * header since Azure rejects two schemes. Best-effort and per-url — a failure on one attachment
 * is reported but never stops the others, and never fails the credit. A bearer-token url is
 * checked against a host allowlist (custscript_pret_ap_api_hosts_vc) before the token is sent,
 * because the url arrives in the payload and decides where the token goes.
 *
 * Response contract: always HTTP 200; body is { success, internalId, bumId, message,
 * pdfFileId (first file), pdfFileIds (all files), pdfFiles (per-url detail), pdfMessage }.
 *
 * Script parameters (all set on the Script record, valued per deployment):
 *   custscript_pret_ap_pdf_folder_vc       Integer  — File Cabinet folder internal ID
 *   custscript_pret_ap_oauth_token_url_vc  Free-Form Text — OAuth2 token endpoint URL
 *   custscript_pret_ap_oauth_client_id_vc  Free-Form Text — OAuth2 client_id
 *   custscript_pret_ap_oauth_secret_vc     Password — OAuth2 client_secret
 *   custscript_pret_ap_oauth_scope_vc      Free-Form Text — OAuth2 scope (optional)
 *   custscript_pret_ap_api_hosts_vc        Free-Form Text — comma-separated allowed hosts for the
 *                                          file url, e.g. 'api.basware.com'. Blank = no
 *                                          restriction (logged as a warning).
 *   (custscript_pret_ap_api_user_vc / custscript_pret_ap_api_password_vc — Basic auth — are no
 *   longer read and can be removed from the Script record.)
 *
 * TBC / open items (mirrors pret_fr_ap_vendorbill_rl.js):
 *   - Currency: left to default from the resolved vendor rather than set explicitly from
 *     documentCurrencyCode — TBC whether that ever needs reconciling.
 *   - PDF response encoding: NetSuite returns https.get bodies as strings. toBase64() below
 *     handles both an already-base64 body and a raw '%PDF' body — confirm against the live
 *     Basware endpoint which one it actually sends.
 */
define(['N/record', 'N/search', 'N/log', 'N/https', 'N/file', 'N/runtime'],
(record, search, log, https, file, runtime) => {

    const BUM_ID_FIELD        = 'custbody_pret_uuid';        // existing field, also used by pret_fr_evendorcredit_ue.js
    const VENDOR_SIRET_FIELD  = 'custentity_pret_siret';
    const APPROVAL_STATUS_FIELD = 'approvalstatus';
    const PENDING_APPROVAL_VALUE = '1';

    const PARAM_PDF_FOLDER          = 'custscript_pret_ap_pdf_folder_vc';
    const PARAM_OAUTH_TOKEN_URL     = 'custscript_pret_ap_oauth_token_url_vc';
    const PARAM_OAUTH_CLIENT_ID     = 'custscript_pret_ap_oauth_client_id_vc';
    const PARAM_OAUTH_CLIENT_SECRET = 'custscript_pret_ap_oauth_secret_vc';
    const PARAM_OAUTH_SCOPE         = 'custscript_pret_ap_oauth_scope_vc';
    const PARAM_API_HOSTS           = 'custscript_pret_ap_api_hosts_vc';

    // Fallback item when a line's seller item code doesn't resolve to a real NetSuite Item.
    // 'Basware Generic Item' (internal ID 49662) — used instead of failing the whole credit.
    const FALLBACK_ITEM_ID = 49662;

    function post(requestBody) {
        const bumId = requestBody && requestBody.bumId;
        log.audit('AP CREDIT STEP 1 - RECEIVED', `bumId: ${bumId}`);

        try {
            const validationError = validate(requestBody);
            if (validationError) {
                log.error('AP CREDIT VALIDATION FAILED', `bumId: ${bumId} | ${validationError}`);
                return { success: false, bumId, message: validationError };
            }

            const data = requestBody.data;

            const existingId = findExistingCredit(bumId);
            if (existingId) {
                log.audit('AP CREDIT DUPLICATE', `bumId: ${bumId} | existing internalId: ${existingId}`);
                return { success: true, internalId: existingId, bumId, message: 'Already processed (idempotent match)' };
            }
            log.audit('AP CREDIT STEP 2 - NOT A DUPLICATE', `bumId: ${bumId}`);

            if (data.isIssuedAgainstOrder) {
                log.error('AP CREDIT PO-MATCHED NOT SUPPORTED', `bumId: ${bumId} | orderReference: ${JSON.stringify(data.orderReference || {})}`);
                return { success: false, bumId, message: 'PO-matched credits are not yet supported by this RESTlet' };
            }

            const siret = getSiret(data);
            if (!siret) {
                return { success: false, bumId, message: 'No FR:SIRET identification found in accountingSupplierParty.partyIdentifications' };
            }

            const vendorId = findVendorBySiret(siret);
            if (!vendorId) {
                log.error('AP CREDIT VENDOR NOT FOUND', `bumId: ${bumId} | SIRET: ${siret}`);
                return { success: false, bumId, message: `No vendor found for SIRET ${siret}` };
            }
            log.audit('AP CREDIT STEP 3 - VENDOR RESOLVED', `bumId: ${bumId} | SIRET: ${siret} | vendorId: ${vendorId}`);

            const vendor = record.load({ type: record.Type.VENDOR, id: vendorId });
            const subsidiaryId = vendor.getValue('subsidiary');

            const credit = record.create({ type: record.Type.VENDOR_CREDIT, isDynamic: true });
            credit.setValue('entity', vendorId);
            if (subsidiaryId) credit.setValue('subsidiary', subsidiaryId);
            // Supplier's own credit note number becomes the NetSuite reference number (tranid).
            // Duplicate check BEFORE any further work: same vendor + same number = refuse.
            // (A repeat of the same bumId was already handled above as an idempotent match.)
            const supplierCreditNumber = String((data.externalDocumentIdentifier && data.externalDocumentIdentifier.id) || '').trim();
            if (supplierCreditNumber) {
                const existingCreditId = findCreditByVendorAndNumber(vendorId, supplierCreditNumber);
                if (existingCreditId) {
                    log.error('AP CREDIT DUPLICATE NUMBER',
                        `bumId: ${bumId} | vendorId: ${vendorId} | credit number: ${supplierCreditNumber}` +
                        ` | existing credit internalId: ${existingCreditId} — refused`);
                    return {
                        success: false,
                        bumId,
                        existingInternalId: existingCreditId,
                        message: `Duplicate: a vendor credit with reference number "${supplierCreditNumber}" already exists` +
                                 ` for this vendor (internal ID ${existingCreditId})`
                    };
                }
            }

            const tranDate = parseIssueDate(data.issueDate);
            if (tranDate) credit.setValue('trandate', tranDate);
            credit.setValue('tranid', supplierCreditNumber);
            credit.setValue(BUM_ID_FIELD, bumId);
            log.audit('AP CREDIT STEP 4 - HEADER SET', `bumId: ${bumId} | vendorId: ${vendorId} | subsidiary: ${subsidiaryId}`);

            const lines = data.creditNoteLines || [];
            if (!lines.length) {
                return { success: false, bumId, message: 'No creditNoteLines in payload' };
            }

            for (const line of lines) {
                const qty          = (line.quantity && line.quantity.amount) || 1;
                const price        = (line.price && line.price.amount) || 0;
                const sellersItemId = (line.item && line.item.sellersItem && line.item.sellersItem.id)
                    || (line.item && line.item.name);
                if (!sellersItemId) throw new Error(`Line ${line.id || ''} missing item.sellersItem.id / item.name`);

                let itemId = findItemBySellersId(sellersItemId);
                if (!itemId) {
                    log.audit('AP CREDIT ITEM FALLBACK', `bumId: ${bumId} | Line ${line.id || ''} | no item found for '${sellersItemId}' — falling back to internal ID ${FALLBACK_ITEM_ID} (Basware Generic Item)`);
                    itemId = FALLBACK_ITEM_ID;
                }

                credit.selectNewLine({ sublistId: 'item' });
                credit.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item',     value: itemId });
                credit.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: qty });
                credit.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate',     value: price });
                credit.commitLine({ sublistId: 'item' });
            }
            log.audit('AP CREDIT STEP 5 - LINES SET', `bumId: ${bumId} | lineCount: ${lines.length}`);

            try {
                credit.setValue({
                    fieldId: APPROVAL_STATUS_FIELD,
                    value: PENDING_APPROVAL_VALUE
                });
                log.audit('AP CREDIT APPROVAL STATUS SET', `bumId: ${bumId} | approvalStatus: ${PENDING_APPROVAL_VALUE}`);
            } catch (approvalErr) {
                log.audit('AP CREDIT APPROVAL STATUS NOT SET', `bumId: ${bumId} | ${approvalErr.message}`);
            }

            const internalId = credit.save();
            log.audit('AP CREDIT STEP 6 - SAVED', `bumId: ${bumId} | internalId: ${internalId}`);

            // Post-submit: the tranid only exists once the record is saved.
            const pdf = attachSupplierPdf(requestBody, internalId, bumId);

            log.audit('AP CREDIT COMPLETE', `bumId: ${bumId} | internalId: ${internalId} | pdfFileIds: [${pdf.fileIds.join(', ')}] | ${pdf.message}`);
            return {
                success: true,
                internalId,
                bumId,
                pdfFileId: pdf.fileId,          // first saved file — kept for existing consumers
                pdfFileIds: pdf.fileIds,        // every saved file, one per url
                pdfFiles: pdf.files,            // per-url { url, fileId, message }
                pdfMessage: pdf.message,
                message: 'Vendor credit created and marked Pending Approval'
            };

        } catch (e) {
            log.error('AP CREDIT FAILED', `bumId: ${bumId} | ${e.name}: ${e.message}\n${e.stack}`);
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
        if (!body.data.creditNoteLines || !body.data.creditNoteLines.length) return 'Missing data.creditNoteLines';
        return null;
    }

    // ── Idempotency lookup ───────────────────────────────────────────────────
    function findExistingCredit(bumId) {
        const results = search.create({
            type: record.Type.VENDOR_CREDIT,
            filters: [[BUM_ID_FIELD, 'is', bumId]],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });
        return results.length ? results[0].getValue('internalid') : null;
    }

    // ── Duplicate lookup: same vendor + same reference number ────────────────
    function findCreditByVendorAndNumber(vendorId, tranId) {
        const filters = [
            ['mainline', 'is', 'T'], 'and',
            ['tranid', 'is', tranId]
        ];
        if (vendorId) filters.push('and', ['entity', 'anyof', vendorId]);

        const results = search.create({
            type: search.Type.VENDOR_CREDIT,
            filters,
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

    // ── Supplier PDFs: download every file url and file in the File Cabinet ──
    // Runs after credit.save() so the NetSuite tranid is available for the filename.
    // One file per url — a credit note often carries several (the credit PDF plus an image or
    // supporting document). Each url is handled independently: a failure on one is logged and
    // reported but never stops the others, and never fails the credit.
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
                    : 'No file url in payload'
            };
        };

        try {
            const hrefs = getFileLinks(requestBody);
            if (!hrefs.length) {
                log.audit('AP CREDIT PDF - NO FILE LINK', `bumId: ${bumId} | no attachments[].url and no links[] entry with rel='file'`);
                return summary([]);
            }
            log.audit('AP CREDIT PDF - ATTACHMENTS FOUND', `bumId: ${bumId} | ${hrefs.length} url(s) to download`);

            const script       = runtime.getCurrentScript();
            const folderId     = script.getParameter({ name: PARAM_PDF_FOLDER });
            const tokenUrl     = script.getParameter({ name: PARAM_OAUTH_TOKEN_URL });
            const clientId     = script.getParameter({ name: PARAM_OAUTH_CLIENT_ID });
            const clientSecret = script.getParameter({ name: PARAM_OAUTH_CLIENT_SECRET });
            const scope        = script.getParameter({ name: PARAM_OAUTH_SCOPE });
            const allowedHosts = script.getParameter({ name: PARAM_API_HOSTS });

            if (!folderId) {
                const msg = failPdf(bumId, `Script parameter ${PARAM_PDF_FOLDER} is not set`).message;
                return summary(hrefs.map(url => ({ url, fileId: null, message: msg })));
            }

            const tranId = search.lookupFields({
                type: search.Type.VENDOR_CREDIT,
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

            const files = hrefs.map((href, index) => {
                const seq = index + 1;
                try {
                    const result = downloadAndAttachOne(href, {
                        internalId, bumId, tranId, folderId, allowedHosts, getBearerToken,
                        seq, total: hrefs.length
                    });
                    return { url: href, fileId: result.fileId, message: result.message };
                } catch (e) {
                    return { url: href, fileId: null, message: failPdf(bumId, `[${seq}/${hrefs.length}] ${e.name}: ${e.message}`).message };
                }
            });

            return summary(files);

        } catch (e) {
            const msg = failPdf(bumId, `${e.name}: ${e.message}`).message;
            return { fileId: null, fileIds: [], files: [], message: msg };
        }
    }

    // Downloads ONE file url, saves it to the File Cabinet and attaches it to the credit.
    // Returns { fileId, message }; fileId is null when the download or save failed.
    function downloadAndAttachOne(href, ctx) {
        const { internalId, bumId, tranId, folderId, allowedHosts, getBearerToken, seq, total } = ctx;
        const tag = `[${seq}/${total}]`;

        // A SAS link (Azure Blob, '?...&sig=...') carries its own authorization in the query
        // string. Azure refuses a second scheme alongside it
        // (DirectApiRequestHasMoreThanOneAuthorization), so no bearer token is fetched or
        // sent — and with no token going out, the host allowlist has nothing to protect.
        const isSasUrl = /[?&]sig=/i.test(href);
        const requestHeaders = { 'Content-Type': 'application/json', Accept: '*/*' };

        if (isSasUrl) {
            log.audit('AP CREDIT PDF - SAS URL', `bumId: ${bumId} | ${tag} url carries a SAS signature; downloading without a bearer token`);
        } else {
            const hostError = checkHostAllowed(href, allowedHosts, bumId);
            if (hostError) return failPdf(bumId, `${tag} ${hostError}`);

            const token = getBearerToken();
            if (token.error) return failPdf(bumId, `${tag} ${token.error}`);
            requestHeaders.Authorization = `Bearer ${token.accessToken}`;
        }

        log.audit('AP CREDIT PDF - DOWNLOADING', `bumId: ${bumId} | ${tag} tranid: ${tranId} | url: ${href}`);

        // Content-Type/Accept kept as on the original Basware request that is known to
        // return a valid PDF — narrowing Accept to application/pdf changed what came back.
        const response = https.get({ url: href, headers: requestHeaders });

        if (response.code !== 200) {
            return failPdf(bumId, `${tag} File endpoint returned HTTP ${response.code}: ${String(response.body || '').substring(0, 300)}`);
        }

        const rawBody = String(response.body || '');
        const headers = response.headers || {};
        const contentType = headers['Content-Type'] || headers['content-type'] || '(none)';

        // Diagnostic: the shape of this body decides how it must be encoded. Keep this —
        // a blank PDF is almost always visible here as a length or prefix mismatch.
        log.audit('AP CREDIT PDF - RESPONSE',
            `bumId: ${bumId} | ${tag} code: ${response.code} | contentType: ${contentType}`
            + ` | bodyLength: ${rawBody.length} | first64: ${rawBody.substring(0, 64)}`);

        if (!rawBody.length) {
            return failPdf(bumId, `${tag} File endpoint returned HTTP 200 with an empty body — nothing to save`);
        }

        const contents = toBase64(rawBody, bumId);
        if (!contents) {
            return failPdf(bumId, `${tag} Could not derive base64 PDF content from the response body`);
        }

        const fileName = buildPdfName(tranId, seq);
        const pdfFile = file.create({
            name: fileName,
            fileType: file.Type.PDF,
            contents,                            // binary file types expect base64 contents
            folder: Number(folderId),
            isOnline: false
        });
        const fileId = pdfFile.save();
        log.audit('AP CREDIT PDF - SAVED', `bumId: ${bumId} | ${tag} fileId: ${fileId} | name: ${fileName} | folder: ${folderId}`);

        // Attach separately: the file is already safely in the cabinet at this point, so an
        // attach failure must still report the fileId rather than collapse into failPdf().
        try {
            record.attach({
                record: { type: 'file', id: fileId },
                to:     { type: record.Type.VENDOR_CREDIT, id: internalId }
            });
            log.audit('AP CREDIT PDF - ATTACHED', `bumId: ${bumId} | ${tag} fileId: ${fileId} attached to vendor credit ${internalId} (Communication > Files)`);
            return { fileId, message: `Saved as ${fileName} and attached to the credit` };
        } catch (attachErr) {
            log.error('AP CREDIT PDF ATTACH FAILED', `bumId: ${bumId} | ${tag} fileId: ${fileId} | internalId: ${internalId} | ${attachErr.name}: ${attachErr.message}`);
            return { fileId, message: `Saved as ${fileName} but not attached: ${attachErr.message}` };
        }
    }

    function failPdf(bumId, message) {
        log.error('AP CREDIT PDF FAILED', `bumId: ${bumId} | ${message}`);
        return { fileId: null, message };
    }

    // Returns EVERY file url on the payload (trimmed, blanks and exact repeats dropped), in
    // payload order. Two shapes are accepted, each at the top level or under data:
    //   1. attachments[].url — the shape the vendor bill payload uses; preferred when present.
    //   2. links[] with rel='file' (method GET or absent) — the shape the live credit-note
    //      payload uses (2026-10-23): two Basware /v2/files/<refId> hrefs, no attachments[].
    // links[] is only consulted when attachments[] yields nothing, so a payload carrying both
    // is never downloaded twice.
    function getFileLinks(requestBody) {
        const pick = (key) => (requestBody && requestBody[key])
            || (requestBody && requestBody.data && requestBody.data[key])
            || [];
        const clean = (urls) => urls
            .map(u => (u == null ? '' : String(u).trim()))
            .filter((u, i, arr) => u && arr.indexOf(u) === i);

        const attachments = pick('attachments');
        if (Array.isArray(attachments)) {
            const urls = clean(attachments.map(a => a && a.url));
            if (urls.length) return urls;
        }

        const links = pick('links');
        if (!Array.isArray(links)) return [];
        return clean(links
            .filter(l => l && l.rel === 'file' && (!l.method || String(l.method).toUpperCase() === 'GET'))
            .map(l => l.href));
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

        log.audit('AP CREDIT PDF - TOKEN OBTAINED', `bumId: ${bumId} | token_type: ${parsed.token_type || '(none)'} | expires_in: ${parsed.expires_in || '(none)'}`);
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
            log.audit('AP CREDIT PDF - HOST NOT RESTRICTED',
                `bumId: ${bumId} | ${PARAM_API_HOSTS} is blank; sending bearer token to ${host}`);
            return null;
        }
        if (allowed.indexOf(host) === -1) {
            return `Refusing to send bearer token to unexpected host '${host}' (allowed: ${allowed.join(', ')})`;
        }
        return null;
    }

    // 'CreditMemo_FRC4999648_2310261036.pdf' — ddmmyyhhmm in account time. The 2nd, 3rd, ...
    // file of the same credit gets a '_2', '_3', ... suffix so files downloaded within the
    // same minute never share a name: 'CreditMemo_FRC4999648_2310261036_2.pdf'.
    function buildPdfName(tranId, seq) {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const stamp = pad(d.getDate())
            + pad(d.getMonth() + 1)
            + String(d.getFullYear()).slice(-2)
            + pad(d.getHours())
            + pad(d.getMinutes());
        const suffix = seq && seq > 1 ? `_${seq}` : '';
        return `CreditMemo_${tranId || 'UNKNOWN'}_${stamp}${suffix}.pdf`;
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
            log.audit('AP CREDIT PDF - BODY ANALYSIS',
                `bumId: ${bumId} | length: ${s.length} | maxCharCode: ${stats.maxCharCode}`
                + ` | replacementChars: ${stats.replacements} | above255: ${stats.above255}`);

            if (stats.replacements === 0 && stats.above255 === 0) {
                log.audit('AP CREDIT PDF - LOSSLESS RECOVERY',
                    `bumId: ${bumId} | body is a 1:1 byte mapping; rebuilding base64 from char codes`);
                return bytesToBase64(s);
            }

            log.error('AP CREDIT PDF - RAW BINARY BODY',
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
                log.audit('AP CREDIT PDF - BASE64 FROM JSON', `bumId: ${bumId} | extracted ${embedded.length} base64 chars`);
                return embedded;
            }
            log.error('AP CREDIT PDF - JSON BODY', `bumId: ${bumId} | JSON response with no recognisable base64 content: ${s.substring(0, 300)}`);
            return null;
        }

        log.error('AP CREDIT PDF - UNRECOGNISED BODY', `bumId: ${bumId} | first 300 chars: ${s.substring(0, 300)}`);
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
    // Matches creditNoteLines[].item's seller item code against the Item record's own
    // 'itemid' field. Prefers item.sellersItem.id (matches the vendor bill payload shape);
    // falls back to item.name since observed credit note payloads omit sellersItem entirely.
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
