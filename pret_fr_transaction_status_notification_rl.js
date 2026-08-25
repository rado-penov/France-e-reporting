/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 *
 * Sends approval / rejection notifications for Vendor Bill and Vendor Credit transactions.
 *
 * Expected request body:
 * {
 *   "transactionId": 123,
 *   "recordType": "vendorbill" | "vendorcredit",
 *   "context": "edit",
 *   "createContext": "Script (Restlet)",
 *   "changedField": "Document Status",
 *   "newValue": "Open" | "Rejected",
 *   "approvalNotes": "...",
 *   "uuid": "optional-uuid"
 * }
 *
 * Notes:
 * - Vendor Bill notifications are only sent when the create-record context is "Script (Restlet)".
 * - Vendor Credit notifications are sent regardless of create-record context.
 * - The script runs only for edit events.
 */
define(['N/record', 'N/search', 'N/https', 'N/runtime', 'N/log'],
(record, search, https, runtime, log) => {

    const API_URL_PARAM = 'custscript_pret_api_url_tsn';
    const TOKEN_URL_PARAM = 'custscript_pret_oauth_token_url_tsn';
    const CLIENT_ID_PARAM = 'custscript_pret_oauth_client_id_tsn';
    const CLIENT_SECRET_PARAM = 'custscript_pret_oauth_client_secret_tsn';
    const SCOPE_PARAM = 'custscript_pret_oauth_scope_tsn';
    const DOC_TYPE_PARAM = 'custscript_pret_api_doc_type_tsn';

    const DEFAULT_REJECTION_REASON = 'The transaction has been rejected. Please contact the AP department for more details.';

    function post(requestBody) {
        log.audit('STATUS NOTIFICATION RAW BODY', typeof requestBody === 'string'
            ? requestBody
            : JSON.stringify(requestBody));

        const body = requestBody || {};
        const transactionId = body.transactionId || body.id || body.recordId;
        const requestedRecordType = normalizeRecordType(body.recordType || body.transactionType || body.type);
        const context = normalizeContext(body.context || body.executionContext || body.eventType);
        const createContext = normalizeCreateContext(body.createContext || body.createRecordContext || body.recordContext);
        const changedField = normalizeFieldName(body.changedField || body.fieldId);
        const newValue = normalizeStatusValue(body.newValue || body.newStatus);
        const approvalNotes = body.approvalNotes || body.notes || '';
        let transactionUuid = body.uuid || body.transactionUuid || '';

        log.audit('STATUS NOTIFICATION RECEIVED', JSON.stringify({
            transactionId: transactionId || '',
            recordType: requestedRecordType || '',
            context: context || '',
            createContext: createContext || '',
            changedField: changedField || '',
            newValue: newValue || ''
        }));

        try {
            if (context !== 'edit') {
                log.audit('STATUS NOTIFICATION SKIPPED', `Context is "${context || '(missing)'}", expected "edit"`);
                return {
                    success: true,
                    message: 'Ignored: not an edit event'
                };
            }

            if (!requestedRecordType) {
                log.error('STATUS NOTIFICATION SKIPPED', 'Missing transaction type in request body');
                return {
                    success: false,
                    message: 'Missing transaction type'
                };
            }

            if (requestedRecordType === 'vendorbill') {
                if (!createContext || createContext !== 'scriptrestlet') {
                    log.audit('STATUS NOTIFICATION SKIPPED', `Vendor bill ignored because create context is ${createContext || '(missing)'}`);
                    return {
                        success: true,
                        message: 'Ignored: vendor bill notifications require create context Script (Restlet)'
                    };
                }
            }

            if (changedField !== 'documentstatus') {
                log.audit('STATUS NOTIFICATION SKIPPED', `Changed field is "${changedField || '(missing)'}", expected "documentstatus"`);
                return {
                    success: true,
                    message: 'Ignored: Document Status was not changed'
                };
            }

            if (!transactionId) {
                log.error('STATUS NOTIFICATION SKIPPED', 'Missing transactionId in request body');
                return {
                    success: false,
                    message: 'Missing transactionId'
                };
            }

            const transaction = loadTransaction(requestedRecordType, transactionId);
            if (!transaction) {
                return {
                    success: false,
                    message: `Could not load transaction ${transactionId}`
                };
            }

            log.audit('STATUS NOTIFICATION RECORD LOADED', `${requestedRecordType} | id ${transactionId}`);

            if (!transactionUuid) {
                transactionUuid = transaction.getValue({ fieldId: 'custbody_pret_uuid' }) || '';
                log.audit('STATUS NOTIFICATION UUID', `Read from record: "${transactionUuid || '(empty)'}"`);
            } else {
                log.audit('STATUS NOTIFICATION UUID', `Supplied in request: "${transactionUuid}"`);
            }

            const documentType = requestedRecordType === 'vendorcredit' ? 'CreditNote' : 'Invoice';
            let payload;

            if (newValue === 'open') {
                payload = {
                    uuid: transactionUuid,
                    documentType: documentType,
                    status: 'BusinessAccept'
                };
            } else if (newValue === 'rejected') {
                const rejectionReason = (approvalNotes && String(approvalNotes).trim()) || DEFAULT_REJECTION_REASON;
                payload = {
                    uuid: transactionUuid,
                    documentType: documentType,
                    status: 'BusinessReject',
                    rejectionReason: rejectionReason
                };
            } else {
                log.audit('STATUS NOTIFICATION SKIPPED', `New value is "${newValue || '(missing)'}", expected "open" or "rejected"`);
                return {
                    success: true,
                    message: 'Ignored: status change does not require a notification'
                };
            }

            const response = sendNotification(payload);
            log.audit('STATUS NOTIFICATION SENT', JSON.stringify(payload));

            return {
                success: true,
                message: 'Notification sent successfully',
                payload: payload,
                response: response
            };
        } catch (e) {
            log.error('STATUS NOTIFICATION FAILED', `${e.name}: ${e.message}\n${e.stack}`);
            return {
                success: false,
                message: `${e.name}: ${e.message}`
            };
        }
    }

    function loadTransaction(recordType, transactionId) {
        let recordTypeId;
        switch (recordType) {
            case 'vendorbill':
                recordTypeId = record.Type.VENDOR_BILL;
                break;
            case 'vendorcredit':
                recordTypeId = record.Type.VENDOR_CREDIT;
                break;
            default:
                return null;
        }

        try {
            return record.load({
                type: recordTypeId,
                id: transactionId,
                isDynamic: false
            });
        } catch (e) {
            log.error('STATUS NOTIFICATION LOAD FAILED', `${recordType} | ${transactionId} | ${e.message}`);
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

        log.audit('STATUS NOTIFICATION PARAMETERS OK', JSON.stringify({
            apiUrl: apiUrl,
            tokenUrl: tokenUrl,
            clientId: clientId,
            scope: scope,
            docType: apiDocType
        }));

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

        log.audit('STATUS NOTIFICATION TOKEN OK', `Status: ${response.code}`);

        const parsed = JSON.parse(response.body);
        if (!parsed.access_token) {
            throw new Error(`Token response missing access_token — Body: ${response.body}`);
        }

        return parsed.access_token;
    }

    function normalizeRecordType(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'vendor bill' || normalized === 'vendorbill' || normalized === 'vendor_bill') return 'vendorbill';
        if (normalized === 'vendor credit' || normalized === 'vendorcredit' || normalized === 'vendor_credit') return 'vendorcredit';
        return normalized;
    }

    function normalizeContext(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) return '';
        if (normalized === 'edit' || normalized === 'editrecord') return 'edit';
        if (normalized === 'create' || normalized === 'create record') return 'create';
        return normalized;
    }

    function normalizeCreateContext(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) return '';
        if (normalized === 'script (restlet)' || normalized === 'scriptrestlet' || normalized === 'restlet') return 'scriptrestlet';
        return normalized;
    }

    function normalizeFieldName(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'document status' || normalized === 'documentstatus') return 'documentstatus';
        return normalized;
    }

    function normalizeStatusValue(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'open') return 'open';
        if (normalized === 'rejected') return 'rejected';
        return normalized;
    }

    function get(requestParams) {
        log.audit('STATUS NOTIFICATION PING', JSON.stringify(requestParams || {}));
        return {
            success: true,
            message: 'Status notification RESTlet is deployed and reachable'
        };
    }

    return { get, post };
});
