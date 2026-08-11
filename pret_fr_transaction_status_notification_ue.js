/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Sends approval / rejection notifications to Basware when the Document Status of a
 * French Vendor Bill or Vendor Credit changes on edit.
 *
 * Rules:
 * - Subsidiary must be France (internal id 16).
 * - Bills created by the AP RESTlet notify on Open and Rejected.
 * - Bills created any other way (UI) notify on Open only.
 * - Vendor Credits follow the same subsidiary rule and notify on Open and Rejected.
 *
 * Create context is derived from custbody_pret_ubl_export_ready: pret_fr_ebilling_ue.js
 * sets it on UI-created bills and skips RESTlet context entirely, while
 * pret_fr_ap_vendorbill_rl.js sets only custbody_pret_uuid. So the flag being true
 * means the bill came in through the UI.
 *
 * Deploy on Vendor Bill and Vendor Credit.
 */
define(['N/search', 'N/https', 'N/runtime', 'N/log'],
(search, https, runtime, log) => {

    const API_URL_PARAM = 'custscript_pret_api_url_tsn';
    const TOKEN_URL_PARAM = 'custscript_pret_oauth_token_url_tsn';
    const CLIENT_ID_PARAM = 'custscript_pret_oauth_client_id_tsn';
    const CLIENT_SECRET_PARAM = 'custscript_pret_oauth_client_secret_tsn';
    const SCOPE_PARAM = 'custscript_pret_oauth_scope_tsn';
    const DOC_TYPE_PARAM = 'custscript_pret_api_doc_type_tsn';

    const FRANCE_SUBSIDIARY_ID = '16';
    const UUID_FIELD = 'custbody_pret_uuid';
    const UBL_EXPORT_READY_FIELD = 'custbody_pret_ubl_export_ready';

    // TBC: confirm the Document Status field id and that it exposes "Open" / "Rejected"
    const STATUS_FIELD = 'status';

    // TBC: confirm which body field holds the approval / rejection notes
    const APPROVAL_NOTES_FIELD = 'custbody_pret_approval_notes';

    const DEFAULT_REJECTION_REASON = 'The transaction has been rejected. Please contact the AP department for more details.';

    function afterSubmit(context) {
        const newRecord = context.newRecord;
        const recordType = newRecord && newRecord.type;
        const transactionId = newRecord && newRecord.id;

        log.audit('STATUS NOTIFICATION START', `type: ${context.type} | record: ${recordType} | id: ${transactionId}`);

        try {
            if (context.type !== context.UserEventType.EDIT &&
                context.type !== context.UserEventType.XEDIT) {
                log.audit('STATUS NOTIFICATION SKIPPED', `Event type is "${context.type}", expected edit or xedit`);
                return;
            }

            // status is derived from the approval status and is recalculated after the write,
            // so newRecord still holds the pre-save value here. Read the saved record instead.
            const details = lookupTransaction(recordType, transactionId);
            if (!details) {
                log.error('STATUS NOTIFICATION FAILED', `Could not read ${recordType} ${transactionId}`);
                return;
            }

            log.audit('STATUS NOTIFICATION RECORD', JSON.stringify(details));

            const oldStatus = normalizeStatusValue(readRecordStatus(context.oldRecord));
            const newStatus = normalizeStatusValue(details.statusText || details.statusValue);

            log.audit('STATUS NOTIFICATION STATUS CHECK',
                `old: "${oldStatus || '(none)'}" | new: "${newStatus || '(none)'}" | ` +
                `raw new value: "${details.statusValue}" | raw new text: "${details.statusText}"`);

            if (oldStatus === newStatus) {
                log.audit('STATUS NOTIFICATION SKIPPED', 'Document Status did not change');
                return;
            }

            if (newStatus !== 'open' && newStatus !== 'rejected') {
                log.audit('STATUS NOTIFICATION SKIPPED', `New status "${newStatus || '(none)'}" does not require a notification`);
                return;
            }

            if (details.subsidiaryId !== FRANCE_SUBSIDIARY_ID) {
                log.audit('STATUS NOTIFICATION SKIPPED', `Subsidiary is ${details.subsidiaryId || '(none)'}, expected ${FRANCE_SUBSIDIARY_ID} (France)`);
                return;
            }

            const createdViaUi = details.ublExportReady === true;

            if (recordType === 'vendorbill' && createdViaUi && newStatus !== 'open') {
                log.audit('STATUS NOTIFICATION SKIPPED', `UI-created vendor bill set to "${newStatus}" — only Open is notified`);
                return;
            }

            if (!details.uuid) {
                log.error('STATUS NOTIFICATION NO UUID',
                    `${recordType} ${transactionId} has no ${UUID_FIELD}; Basware cannot be told which document this is. Nothing sent.`);
                return;
            }

            const documentType = recordType === 'vendorcredit' ? 'CreditNote' : 'Invoice';
            let payload;

            if (newStatus === 'open') {
                payload = {
                    uuid: details.uuid,
                    tranId: details.tranId,
                    documentType: documentType,
                    status: 'BusinessAccept'
                };
            } else {
                const rejectionReason = (details.approvalNotes && String(details.approvalNotes).trim()) || DEFAULT_REJECTION_REASON;
                payload = {
                    uuid: details.uuid,
                    tranId: details.tranId,
                    documentType: documentType,
                    status: 'BusinessReject',
                    rejectionReason: rejectionReason
                };
            }

            sendNotification(payload);
            log.audit('STATUS NOTIFICATION SENT', JSON.stringify(payload));
        } catch (e) {
            log.error('STATUS NOTIFICATION FAILED', `${e.name}: ${e.message}\n${e.stack}`);
        }
    }

    function lookupTransaction(recordType, transactionId) {
        if (!recordType || !transactionId) return null;

        try {
            const columns = ['subsidiary', 'status', 'tranid', UUID_FIELD, APPROVAL_NOTES_FIELD];
            if (recordType === 'vendorbill') columns.push(UBL_EXPORT_READY_FIELD);

            const values = search.lookupFields({
                type: recordType,
                id: transactionId,
                columns: columns
            });

            const subsidiary = values.subsidiary;
            return {
                subsidiaryId: (subsidiary && subsidiary.length) ? String(subsidiary[0].value) : '',
                statusValue: firstValue(values.status, 'value'),
                statusText: firstValue(values.status, 'text'),
                tranId: values.tranid || '',
                uuid: values[UUID_FIELD] || '',
                approvalNotes: values[APPROVAL_NOTES_FIELD] || '',
                ublExportReady: values[UBL_EXPORT_READY_FIELD] === true
            };
        } catch (e) {
            log.error('STATUS NOTIFICATION LOOKUP FAILED', `${recordType} | ${transactionId} | ${e.message}`);
            return null;
        }
    }

    function sendNotification(payload) {
        const script = runtime.getCurrentScript();
        const apiUrl = script.getParameter({ name: API_URL_PARAM });
        const tokenUrl = script.getParameter({ name: TOKEN_URL_PARAM });
        const clientId = script.getParameter({ name: CLIENT_ID_PARAM });
        const clientSecret = script.getParameter({ name: CLIENT_SECRET_PARAM });
        const scope = script.getParameter({ name: SCOPE_PARAM });
        const apiDocType = script.getParameter({ name: DOC_TYPE_PARAM });

        const missing = [
            [API_URL_PARAM, apiUrl],
            [TOKEN_URL_PARAM, tokenUrl],
            [CLIENT_ID_PARAM, clientId],
            [CLIENT_SECRET_PARAM, clientSecret],
            [SCOPE_PARAM, scope],
            [DOC_TYPE_PARAM, apiDocType]
        ].filter(pair => !pair[1]).map(pair => pair[0]);

        if (missing.length) {
            log.error('STATUS NOTIFICATION PARAMETERS MISSING', missing.join(', '));
            throw new Error(`Missing posting parameters: ${missing.join(', ')}`);
        }

        const token = getBearerToken(tokenUrl, clientId, clientSecret, scope);

        log.audit('STATUS NOTIFICATION POSTING', `${apiUrl} | ${JSON.stringify(payload)}`);
        const response = https.post({
            url: apiUrl,
            body: JSON.stringify(payload),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'X-Pret-Document-Type': apiDocType
            }
        });

        log.audit('STATUS NOTIFICATION API RESPONSE', `Status: ${response.code} | Body: ${response.body}`);

        if (response.code < 200 || response.code >= 300) {
            throw new Error(`Notification API returned ${response.code}: ${response.body}`);
        }

        return {
            statusCode: response.code,
            body: response.body
        };
    }

    function getBearerToken(tokenUrl, clientId, clientSecret, scope) {
        const body = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}` +
                     `&client_secret=${encodeURIComponent(clientSecret)}&scope=${encodeURIComponent(scope)}`;

        log.audit('STATUS NOTIFICATION TOKEN REQUEST', `${tokenUrl} | client_id: ${clientId} | scope: ${scope}`);
        const response = https.post({
            url: tokenUrl,
            body: body,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (response.code < 200 || response.code >= 300) {
            log.error('STATUS NOTIFICATION TOKEN FAILED', `Status: ${response.code} | Body: ${response.body}`);
            throw new Error(`Token request failed — Status: ${response.code} | Body: ${response.body}`);
        }

        const parsed = JSON.parse(response.body);
        if (!parsed.access_token) {
            throw new Error(`Token response missing access_token — Body: ${response.body}`);
        }

        log.audit('STATUS NOTIFICATION TOKEN OK', `Status: ${response.code}`);
        return parsed.access_token;
    }

    // lookupFields returns select fields as [{value, text}] but plain fields as strings.
    function firstValue(field, prop) {
        if (!field) return '';
        if (Array.isArray(field)) return field.length ? String(field[0][prop] || '') : '';
        return String(field);
    }

    function readRecordStatus(rec) {
        if (!rec) return '';
        try {
            return rec.getText({ fieldId: STATUS_FIELD }) || rec.getValue({ fieldId: STATUS_FIELD }) || '';
        } catch (e) {
            return rec.getValue({ fieldId: STATUS_FIELD }) || '';
        }
    }

    function normalizeStatusValue(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'open') return 'open';
        if (normalized === 'rejected') return 'rejected';
        return normalized;
    }

    return { afterSubmit };
});
