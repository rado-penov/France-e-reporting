/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 *
 * Updates an Invoice or Credit Memo when Basware sends a response notification.
 * Expected request body:
 * {
 *   "uuid": "...",
 *   "documentType": "Invoice" | "CreditMemo",
 *   "status": "...",
 *   "rejectionReason": "..."
 * }
 */
define(['N/record', 'N/search', 'N/log'],
(record, search, log) => {

    const UUID_FIELD = 'custbody_pret_uuid';
    const REJECTED_FIELD = 'custbody_pret_transaction_rejected';
    const NOTIFICATION_FIELD = 'custbody_pret_basware_notification';
    const LAST_NOTIFICATION_DATE_FIELD = 'custbody_pret_last_notification_date';

    function post(requestBody) {
        const body = requestBody || {};
        const uuid = body.uuid;
        const documentType = body.documentType;
        const status = body.status;
        const rejectionReason = body.rejectionReason;

        log.audit('TRANSACTION NOTIFICATION RECEIVED', JSON.stringify({
            uuid: uuid || '',
            documentType: documentType || '',
            status: status || '',
            rejectionReason: rejectionReason || ''
        }));

        try {
            if (!uuid) {
                log.audit('TRANSACTION NOTIFICATION VALIDATION FAILED', 'Missing uuid in request body');
                return {
                    success: false,
                    message: 'Missing uuid in request body'
                };
            }

            const normalizedDocumentType = normalizeDocumentType(documentType);
            log.debug('TRANSACTION NOTIFICATION DOCUMENT TYPE', `Original: ${documentType || ''} | Normalized: ${normalizedDocumentType || 'unknown'}`);

            const transaction = findTransactionByUuid(uuid, normalizedDocumentType);
            if (!transaction) {
                log.audit('TRANSACTION NOTIFICATION NOT FOUND', `uuid: ${uuid} | documentType: ${documentType || ''}`);
                return {
                    success: false,
                    message: `Cannot find the transaction with uuid: ${uuid}`
                };
            }

            const recordType = transaction.type;
            const recordId = transaction.id;

            log.audit('TRANSACTION NOTIFICATION MATCH FOUND', `uuid: ${uuid} | recordType: ${recordType} | internalId: ${recordId}`);

            const tran = record.load({
                type: recordType,
                id: recordId,
                isDynamic: true
            });

            log.debug('TRANSACTION NOTIFICATION UPDATE FIELDS', `Setting rejected=true | notification=${rejectionReason || ''}`);

            tran.setValue({
                fieldId: REJECTED_FIELD,
                value: true
            });

            tran.setValue({
                fieldId: NOTIFICATION_FIELD,
                value: rejectionReason || ''
            });

            tran.setValue({
                fieldId: LAST_NOTIFICATION_DATE_FIELD,
                value: new Date()
            });

            const updatedId = tran.save();

            log.audit('TRANSACTION NOTIFICATION UPDATE SUCCESS', `uuid: ${uuid} | recordType: ${recordType} | internalId: ${updatedId} | status: ${status || ''}`);

            return {
                success: true,
                internalId: updatedId,
                resourceId: uuid,
                message: 'Transaction updated successfully'
            };
        } catch (e) {
            log.error('TRANSACTION NOTIFICATION UPDATE FAILED', `uuid: ${uuid} | documentType: ${documentType || ''} | status: ${status || ''} | ${e.name}: ${e.message}\n${e.stack}`);
            return {
                success: false,
                resourceId: uuid,
                message: `${e.name}: ${e.message}`
            };
        }
    }

    function normalizeDocumentType(documentType) {
        if (!documentType) {
            return '';
        }

        const value = String(documentType).trim().toLowerCase();
        if (value === 'invoice') {
            return 'invoice';
        }

        if (value === 'creditmemo' || value === 'credit memo' || value === 'credit-memo') {
            return 'creditmemo';
        }

        return value;
    }

    function findTransactionByUuid(uuid, documentType) {
        const searchConfigs = [];
        const trimmedUuid = String(uuid || '').trim();

        log.debug('TRANSACTION NOTIFICATION SEARCH DEBUG', `uuid: ${trimmedUuid} | documentType: ${documentType || ''}`);

        if (!documentType || documentType === 'invoice') {
            searchConfigs.push({
                type: search.Type.INVOICE,
                recordType: record.Type.INVOICE
            });
        }

        if (!documentType || documentType === 'creditmemo') {
            searchConfigs.push({
                type: search.Type.CREDIT_MEMO,
                recordType: record.Type.CREDIT_MEMO
            });
        }

        if (!searchConfigs.length) {
            searchConfigs.push(
                {
                    type: search.Type.INVOICE,
                    recordType: record.Type.INVOICE
                },
                {
                    type: search.Type.CREDIT_MEMO,
                    recordType: record.Type.CREDIT_MEMO
                }
            );
        }

        for (const config of searchConfigs) {
            const exactResults = search.create({
                type: config.type,
                filters: [[UUID_FIELD, search.Operator.IS, trimmedUuid]],
                columns: ['internalid', UUID_FIELD]
            }).run().getRange({ start: 0, end: 5 });

            if (exactResults && exactResults.length) {
                const matchedId = exactResults[0].getValue('internalid');
                const matchedUuid = exactResults[0].getValue(UUID_FIELD);
                log.debug('TRANSACTION NOTIFICATION SEARCH MATCH', `recordType: ${config.recordType} | internalId: ${matchedId} | storedUuid: ${matchedUuid}`);
                return {
                    type: config.recordType,
                    id: matchedId
                };
            }

            const containsResults = search.create({
                type: config.type,
                filters: [[UUID_FIELD, search.Operator.CONTAINS, trimmedUuid]],
                columns: ['internalid', UUID_FIELD]
            }).run().getRange({ start: 0, end: 5 });

            if (containsResults && containsResults.length) {
                const matchedId = containsResults[0].getValue('internalid');
                const matchedUuid = containsResults[0].getValue(UUID_FIELD);
                log.debug('TRANSACTION NOTIFICATION SEARCH MATCH (CONTAINS)', `recordType: ${config.recordType} | internalId: ${matchedId} | storedUuid: ${matchedUuid}`);
                return {
                    type: config.recordType,
                    id: matchedId
                };
            }
        }

        log.audit('TRANSACTION NOTIFICATION SEARCH NO MATCH', `uuid: ${trimmedUuid} | documentType: ${documentType || ''}`);
        return null;
    }

    return { post };
});
