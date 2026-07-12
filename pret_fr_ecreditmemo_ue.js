/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Generates a UBL 2.1 / EN 16931 CreditNote XML for French e-invoicing on credit memo save,
 * saves it to the File Cabinet, sends it via HTTPS API and stamps the export flags
 * on the credit memo.
 *
 * Only processes credit memos where subsidiary = 16 (France) or billing country = FR.
 *
 * Script Parameters (defined on the Script record in NetSuite):
 *   custscript_pret_api_url_cm              Free-form text            — API endpoint URL
 *   custscript_pret_oauth_token_url_cm      Free-form text            — OAuth2 token endpoint URL (client_credentials grant)
 *   custscript_pret_oauth_client_id_cm      Free-form text            — OAuth2 client_id
 *   custscript_pret_oauth_client_secret_cm  Free-form Text (Password) — OAuth2 client_secret
 *   custscript_pret_oauth_scope_cm          Free-form text            — OAuth2 scope
 *   custscript_pret_api_doc_type_cm         Free-form text            — Value sent as the X-Pret-Document-Type header
 *   custscript_pret_ubl_folder_cm           Free-form text            — File Cabinet folder ID for XML files
 */
define(['N/record', 'N/file', 'N/https', 'N/runtime', 'N/log'],
(record, file, https, runtime, log) => {

    // ── afterSubmit ──────────────────────────────────────────────────────────
    function afterSubmit(context) {
        const execCtx      = runtime.executionContext;
        const isUI         = execCtx === runtime.ContextType.USER_INTERFACE;
        const isUserEvent  = execCtx === 'USEREVENT'; // approval workflow button saves
        const ctxLabel     = isUI ? 'UI' : isUserEvent ? 'USEREVENT' : 'Integration';
        log.audit('UBL STEP 1 - FIRED', `context.type: ${context.type} | executionContext: ${execCtx} | isUI: ${isUI} | isUserEvent: ${isUserEvent} | record id: ${context.newRecord.id}`);

        const { CREATE, EDIT } = context.UserEventType;

        // Integration (not UI, not USEREVENT): process CREATE only
        // UI / USEREVENT (approval workflow): process EDIT only
        if (!isUI && !isUserEvent && context.type !== CREATE) {
            log.audit('UBL STEP 1 - SKIPPED', `Integration context — only fires on CREATE, got: ${context.type}`);
            return;
        }
        if ((isUI || isUserEvent) && context.type !== EDIT) {
            log.audit('UBL STEP 1 - SKIPPED', `${ctxLabel} context — only fires on EDIT, got: ${context.type}`);
            return;
        }
        log.audit('UBL STEP 2 - EVENT TYPE OK', `Processing ${context.type} (${ctxLabel}) for record id: ${context.newRecord.id}`);

        try {
            const script    = runtime.getCurrentScript();
            const apiUrl       = script.getParameter({ name: 'custscript_pret_api_url_cm' });
            const tokenUrl     = script.getParameter({ name: 'custscript_pret_oauth_token_url_cm' });
            const clientId     = script.getParameter({ name: 'custscript_pret_oauth_client_id_cm' });
            const clientSecret = script.getParameter({ name: 'custscript_pret_oauth_client_secret_cm' });
            const scope        = script.getParameter({ name: 'custscript_pret_oauth_scope_cm' });
            const apiDocType   = script.getParameter({ name: 'custscript_pret_api_doc_type_cm' });
            const folderId     = parseInt(script.getParameter({ name: 'custscript_pret_ubl_folder_cm' }), 10);
            const oauthConfigured = !!(tokenUrl && clientId && clientSecret && scope);
            log.audit('UBL STEP 3 - PARAMS READ', `folderId: ${folderId} | url: ${apiUrl || '(empty)'} | oauth configured: ${oauthConfigured} | docType: ${apiDocType || '(empty)'}`);

            if (!folderId || isNaN(folderId)) throw new Error('custscript_pret_ubl_folder parameter is not set on the deployment');

            const cm = record.load({ type: record.Type.CREDIT_MEMO, id: context.newRecord.id });
            const tranId0        = cm.getValue('tranid');
            const statusRef      = cm.getValue('statusRef');
            const potentialAmt   = parseFloat(cm.getValue('custbody_potentialamount') || 0);
            const approvalStatus = cm.getText('custbody_arapprovalstatus');
            const subsidiaryId   = parseInt(cm.getValue('subsidiary'), 10);

            // billcountry returns undefined for UI-created CMs (address stored as subrecord);
            // fall back to the billingaddress subrecord, then to subsidiary 16 = France.
            let billCountry = cm.getValue('billcountry') || '';
            if (!billCountry) {
                try {
                    const billAddrSub = cm.getSubrecord({ fieldId: 'billingaddress' });
                    if (billAddrSub) billCountry = billAddrSub.getValue({ fieldId: 'country' }) || '';
                } catch (e) { /* address not a subrecord on this CM */ }
            }
            const isFrance = billCountry === 'FR' || subsidiaryId === 16;
            log.audit('UBL STEP 4 - CM LOADED', `tranid: ${tranId0} | billcountry: ${billCountry} | subsidiaryId: ${subsidiaryId} | isFrance: ${isFrance} | status: ${statusRef} | potentialamount: ${potentialAmt} | approvalStatus: ${approvalStatus}`);

            // Common: billing country must be France (FR) or subsidiary must be France (ID 16)
            if (!isFrance) {
                log.audit('UBL STEP 4 - SKIPPED', `CM: ${tranId0} | not France — billcountry: ${billCountry} | subsidiaryId: ${subsidiaryId}`);
                return;
            }
            // Common: no potential amount
            if (potentialAmt !== 0) {
                log.audit('UBL STEP 4 - SKIPPED', `CM: ${tranId0} | custbody_potentialamount is not 0: ${potentialAmt}`);
                return;
            }

            if (isUI || isUserEvent) {
                // UI / USEREVENT (approval workflow): also require Open status and Approved AR approval
                if (statusRef !== 'open') {
                    log.audit('UBL STEP 4 - SKIPPED', `CM: ${tranId0} | ${ctxLabel} — status is not Open: ${statusRef}`);
                    return;
                }
                if (approvalStatus !== 'Approved') {
                    log.audit('UBL STEP 4 - SKIPPED', `CM: ${tranId0} | ${ctxLabel} — arapprovalstatus is not Approved: ${approvalStatus}`);
                    return;
                }
            }

            log.audit('UBL STEP 5 - VALIDATION OK', `CM: ${tranId0} | context: ${ctxLabel} | billcountry: ${billCountry} | status: ${statusRef} | potentialamount: ${potentialAmt} | approvalStatus: ${approvalStatus}`);

            const sub  = record.load({ type: 'subsidiary', id: cm.getValue('subsidiary') });
            log.audit('UBL STEP 6 - SUBSIDIARY LOADED', `id: ${cm.getValue('subsidiary')} | legalname: ${sub.getValue('legalname')}`);

            const cust = record.load({ type: record.Type.CUSTOMER, id: cm.getValue('entity') });
            log.audit('UBL STEP 7 - CUSTOMER LOADED', `id: ${cm.getValue('entity')} | companyname: ${cust.getValue('companyname')}`);

            let period = null;
            const periodId = cm.getValue('postingperiod');
            if (periodId) {
                try {
                    period = record.load({ type: 'accountingperiod', id: periodId });
                    log.audit('UBL STEP 8 - PERIOD LOADED', `periodId: ${periodId}`);
                } catch (e) {
                    log.error('UBL PERIOD LOAD FAILED', `CM: ${cm.getValue('tranid')} | periodId: ${periodId} | ${e.message}`);
                }
            } else {
                log.audit('UBL STEP 8 - PERIOD SKIPPED', `No postingperiod on CM: ${cm.getValue('tranid')}`);
            }

            log.audit('UBL STEP 9 - BUILDING XML', `CM: ${cm.getValue('tranid')} | lines: ${cm.getLineCount({ sublistId: 'item' })}`);
            const uuid     = generateUUID();
            const xml      = buildUBL(cm, sub, cust, period, uuid);
            const tranId   = String(cm.getValue('tranid'));
            const tranDate = fmtDate(cm.getValue('trandate')).replace(/-/g, '');
            const fileName = `${tranDate}_${tranId}_${cm.id}.xml`;
            log.audit('UBL STEP 10 - XML BUILT', `CM: ${tranId} | fileName: ${fileName} | xmlLength: ${xml.length}`);

            log.audit('UBL STEP 11 - SAVING FILE', `CM: ${tranId} | fileName: ${fileName} | folderId: ${folderId}`);
            const xmlFile = file.create({
                name:     fileName,
                fileType: file.Type.XMLDOC,
                contents: xml,
                folder:   folderId
            });
            const fileId = xmlFile.save();
            log.audit('UBL STEP 12 - FILE SAVED', `CM: ${tranId} | File: ${fileName} | File ID: ${fileId}`);

            let sentToBW = false;
            if (apiUrl && oauthConfigured && apiDocType) {
                try {
                    const bearerToken = getBearerToken(tokenUrl, clientId, clientSecret, scope);
                    log.audit('UBL STEP 14 - API CALLING', `CM: ${tranId} | POST ${apiUrl}`);
                    const response = https.post({
                        url:  apiUrl,
                        body: xml,
                        headers: {
                            'Content-Type':           'application/xml',
                            'Authorization':          `Bearer ${bearerToken}`,
                            'X-Pret-Document-Type':   apiDocType
                        }
                    });
                    if (response.code >= 200 && response.code < 300) {
                        sentToBW = true;
                        log.audit('UBL API SENT', `CM: ${tranId} | Status: ${response.code}`);
                    } else {
                        log.error('UBL API FAILED', `CM: ${tranId} | Status: ${response.code} | Body: ${response.body}`);
                    }
                } catch (apiErr) {
                    log.error('UBL API FAILED', `CM: ${tranId} | Name: ${apiErr.name} | Message: ${apiErr.message} | Stack: ${apiErr.stack}`);
                }
            } else {
                log.error('UBL API SKIPPED', `CM: ${tranId} | Missing parameters — url: ${!!apiUrl} | oauth configured: ${oauthConfigured} | docType: ${!!apiDocType}`);
            }

            log.audit('UBL STEP 17 - STAMPING FLAGS', `CM: ${tranId} | sentToBW: ${sentToBW}`);
            // TBC: confirm these custom field IDs exist on the Credit Memo form
            record.submitFields({
                type:   record.Type.CREDIT_MEMO,
                id:     cm.id,
                values: {
                    custbody_pret_ubl_export_ready:      true,
                    custbody_pret_ubl_export_date:       new Date(),
                    custbody_pret_creditmemo_sent_to_bw: sentToBW,
                    custbody_pret_invoice_sent_to_bw:    false,
                    custbody_pret_uuid:                  uuid
                }
            });
            log.audit('UBL COMPLETE', `CM: ${tranId} | File ID: ${fileId} | Sent to BW: ${sentToBW} | UUID: ${uuid}`);

        } catch (e) {
            log.error('UBL FAILED', `CM: ${context.newRecord.id} | ${e.message}\n${e.stack}`);
        }
    }

    // ── OAuth2 helper ────────────────────────────────────────────────────────
    // Fetches a fresh bearer token via the client_credentials grant. Called immediately
    // before each API send so the caller never has to worry about token expiry/refresh.
    function getBearerToken(tokenUrl, clientId, clientSecret, scope) {
        const body = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}` +
                     `&client_secret=${encodeURIComponent(clientSecret)}&scope=${encodeURIComponent(scope)}`;
        const response = https.post({
            url:     tokenUrl,
            body:    body,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        if (response.code < 200 || response.code >= 300) {
            throw new Error(`Token request failed — Status: ${response.code} | Body: ${response.body}`);
        }
        const parsed = JSON.parse(response.body);
        if (!parsed.access_token) throw new Error(`Token response missing access_token — Body: ${response.body}`);
        return parsed.access_token;
    }

    // ── XML helpers ──────────────────────────────────────────────────────────
    function esc(v) {
        return String(v ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    function fmtDate(d) {
        if (!d) return '';
        const dt = d instanceof Date ? d : new Date(d);
        return dt.toISOString().slice(0, 10);
    }

    function num(v, dp = 2) {
        return parseFloat(v || 0).toFixed(dp);
    }

    function absNum(v, dp = 2) {
        return Math.abs(parseFloat(v || 0)).toFixed(dp);
    }

    function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    // ── UBL 2.1 / EN 16931 CreditNote builder ───────────────────────────────
    function buildUBL(cm, sub, cust, period, uuid) {

        // ── Credit memo header ───────────────────────────────────────────────
        const tranId         = cm.getValue('tranid')                               || 'NOT_TRANID';
        const tranDate       = fmtDate(cm.getValue('trandate'))                    || 'NOT_TRANDATE';
        const currency       = cm.getText('currency')                              || 'NOT_CURRENCY';
        const terms          = cm.getText('terms')                                 || '';
        const memo           = cm.getValue('memo')                                 || '';
        const otherRefNum    = cm.getValue('otherrefnum')                          || '';
        const accountingCost = cust.getValue('companyname')                        || '';
        // Reference to the original invoice this credit memo was raised against
        // getText('createdfrom') returns "Invoice #INVFR00056992" — strip the display prefix
        const originalInvRef = (cm.getText('createdfrom') || '').replace(/^Invoice\s+#?/i, '')
                            || cm.getValue('otherrefnum') || '';

        // ── Accounting period ────────────────────────────────────────────────
        const periodStart = period ? (fmtDate(period.getValue('startdate')) || '') : '';
        const periodEnd   = period ? (fmtDate(period.getValue('enddate'))   || '') : '';

        // ── Supplier (subsidiary = Pret FR) ──────────────────────────────────
        const selSiren     = sub.getValue('custrecord_pret_siren')                    || 'NOT_SELLER_SIREN';
        const selSiret     = sub.getValue('custrecord_pret_siret')                    || 'NOT_SELLER_SIRET';
        const selName      = sub.getValue('legalname')                                || 'NOT_SELLER_NAME';
        const mainAddr     = sub.getSubrecord({ fieldId: 'mainaddress' });
        const selAddr1     = mainAddr.getValue('addr1')   || 'NOT_SELLER_ADDR1';
        const selAddr2     = mainAddr.getValue('addr2')   || '';
        const selCity      = mainAddr.getValue('city')    || 'NOT_SELLER_CITY';
        const selZip       = mainAddr.getValue('zip')     || 'NOT_SELLER_ZIP';
        const selCountry   = mainAddr.getValue('country') || sub.getValue('country') || 'NOT_SELLER_COUNTRY';
        const selVat       = sub.getValue('federalidnumber')                          || 'NOT_SELLER_VAT';
        const selLegalForm = sub.getValue('custrecord_pret_sub_invoice_footer_text')  || 'NOT_SELLER_LEGAL_FORM';
        const selContact   = sub.getValue('legalname')                                || 'NOT_SELLER_CONTACT';
        const selPhone     = sub.getValue('custrecord_pret_phone_number')             || 'NOT_SELLER_PHONE';
        const selEmail     = sub.getValue('custrecord_pay_remittance_contact')        || 'NOT_SELLER_EMAIL';
        const selIBAN      = sub.getValue('custrecord_pret_bank_account_iban')        || 'NOT_SELLER_IBAN';
        const selBankName  = sub.getValue('custrecord_pret_bank_name')                || 'NOT_SELLER_BANK_NAME';
        const selBIC       = sub.getValue('custrecord_pret_sort_code_bic')            || 'NOT_SELLER_BIC';
        const pmtInfoNote  = sub.getValue('custrecord_pret_payment_info')             || '';

        // ── Customer ─────────────────────────────────────────────────────────
        const custSiren    = cust.getValue('custentity_pret_siren')                   || 'NOT_CUST_SIREN';
        const custSiret    = cust.getValue('custentity_pret_siret')                   || 'NOT_CUST_SIRET';
        const custName     = cust.getValue('companyname')                             || 'NOT_CUST_NAME';
        const custAddr1    = cust.getValue('billaddr1')                               || 'NOT_CUST_ADDR1';
        const custAddr2    = cust.getValue('billaddr2')                               || '';
        const custCity     = cust.getValue('billcity')                                || 'NOT_CUST_CITY';
        const custZip      = cust.getValue('billzip')                                 || 'NOT_CUST_ZIP';
        const custCountry  = cust.getValue('billcountry')                             || 'NOT_CUST_COUNTRY';
        const custVat      = cust.getValue('vatregnumber')                            || 'NOT_CUST_VAT';
        const custPhone    = cust.getValue('phone')                                   || 'NOT_CUST_PHONE';
        const custEmail    = cust.getValue('email')                                   || 'NOT_CUST_EMAIL';
        const payMeansCode = cust.getValue('custentity_pret_pay_method')              || 'NOT_PAY_METHOD';
        const mandateRef   = cust.getValue('custentity_pret_sepa_mandate_reference')  || '';
        const payerAccount = cust.getValue('custentity_pret_sepa_payer_account')      || '';

        // ── Lines + tax accumulation ─────────────────────────────────────────
        const lineCount  = cm.getLineCount({ sublistId: 'item' });
        const taxMap     = {};
        let lineExtTotal = 0;
        let linesXml     = '';

        for (let i = 0; i < lineCount; i++) {
            // Credit memo quantities and amounts are stored as positive in NetSuite.
            // The 'amount' field can return 0 via SuiteScript on credit memos, so fall back to qty * rate.
            const qty       = absNum(cm.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }));
            const rate      = absNum(cm.getSublistValue({ sublistId: 'item', fieldId: 'rate',     line: i }));
            const rawAmount = parseFloat(cm.getSublistValue({ sublistId: 'item', fieldId: 'amount', line: i })) || 0;
            const amount    = rawAmount !== 0 ? absNum(rawAmount) : (parseFloat(qty) * parseFloat(rate)).toFixed(2);
            const desc    = cm.getSublistValue({        sublistId: 'item', fieldId: 'description', line: i })
                         || cm.getSublistText({         sublistId: 'item', fieldId: 'item',        line: i })
                         || `NOT_DESC_LINE${i + 1}`;
            const itemId  = cm.getSublistValue({ sublistId: 'item', fieldId: 'item',     line: i }) || `NOT_ITEM_LINE${i + 1}`;
            const taxRate = num(cm.getSublistValue({ sublistId: 'item', fieldId: 'taxrate1', line: i }), 1);
            const lineNum = cm.getSublistValue({ sublistId: 'item', fieldId: 'line',     line: i }) || (i + 1);
            const taxCode = 'S';   // TBC: derive from NetSuite tax code mapping (S/Z/E/AE)
            const uom     = 'EA';  // TBC: derive from NetSuite UOM mapping

            lineExtTotal += parseFloat(amount);

            const key = `${taxCode}_${taxRate}`;
            if (!taxMap[key]) taxMap[key] = { code: taxCode, rate: taxRate, base: 0, tax: 0 };
            taxMap[key].base += parseFloat(amount);
            taxMap[key].tax  += parseFloat(amount) * parseFloat(taxRate) / 100;

            // UBL CreditNote uses CreditNoteLine / CreditedQuantity
            linesXml += `
    <cac:CreditNoteLine>
        <cbc:ID>${i + 1}</cbc:ID>
        <cbc:CreditedQuantity unitCode="${uom}">${qty}</cbc:CreditedQuantity>
        <cbc:LineExtensionAmount currencyID="${currency}">${amount}</cbc:LineExtensionAmount>
        <cac:OrderLineReference><cbc:LineID>${lineNum}</cbc:LineID></cac:OrderLineReference>
        <cac:Item>
            <cbc:Name>${esc(desc)}</cbc:Name>
            <cac:SellersItemIdentification><cbc:ID>${esc(String(itemId))}</cbc:ID></cac:SellersItemIdentification>
            <cac:ClassifiedTaxCategory>
                <cbc:ID>${taxCode}</cbc:ID>
                <cbc:Percent>${parseFloat(taxRate).toFixed(1)}</cbc:Percent>
                <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
            </cac:ClassifiedTaxCategory>
        </cac:Item>
        <cac:Price>
            <cbc:PriceAmount currencyID="${currency}">${rate}</cbc:PriceAmount>
        </cac:Price>
    </cac:CreditNoteLine>`;
        }

        // ── Tax subtotals ────────────────────────────────────────────────────
        let taxSubtotalsXml = '';
        let totalTax = 0;
        for (const t of Object.values(taxMap)) {
            totalTax += t.tax;
            taxSubtotalsXml += `
        <cac:TaxSubtotal>
            <cbc:TaxableAmount currencyID="${currency}">${t.base.toFixed(2)}</cbc:TaxableAmount>
            <cbc:TaxAmount currencyID="${currency}">${t.tax.toFixed(2)}</cbc:TaxAmount>
            <cac:TaxCategory>
                <cbc:ID>${t.code}</cbc:ID>
                <cbc:Percent>${parseFloat(t.rate).toFixed(1)}</cbc:Percent>
                <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
            </cac:TaxCategory>
        </cac:TaxSubtotal>`;
        }

        // ── Monetary totals — all positive in a CreditNote ───────────────────
        // subtotal/total can return 0 via SuiteScript on credit memos; fall back to line-computed values.
        // amountdue does not exist on credit memos — use amountremaining (unapplied balance).
        const subtotalRaw = parseFloat(absNum(cm.getValue('subtotal')));
        const totalRaw    = parseFloat(absNum(cm.getValue('total')));
        const subtotal    = (subtotalRaw || lineExtTotal).toFixed(2);
        const total       = (totalRaw    || (lineExtTotal + totalTax)).toFixed(2);
        const amountDue   = absNum(cm.getValue('amountremaining') || cm.getValue('unapplied'));

        // ── Optional XML blocks ──────────────────────────────────────────────
        const billingRefBlock = originalInvRef ? `
    <cac:BillingReference>
        <cac:InvoiceDocumentReference>
            <cbc:ID>${esc(originalInvRef)}</cbc:ID>
        </cac:InvoiceDocumentReference>
    </cac:BillingReference>` : '';

        const periodBlock = (periodStart && periodEnd) ? `
    <cac:InvoicePeriod>
        <cbc:StartDate>${periodStart}</cbc:StartDate>
        <cbc:EndDate>${periodEnd}</cbc:EndDate>
        <cbc:DescriptionCode>3</cbc:DescriptionCode>
    </cac:InvoicePeriod>` : '';

        const orderRefBlock = otherRefNum ? `
    <cac:OrderReference>
        <cbc:ID>${esc(otherRefNum)}</cbc:ID>
    </cac:OrderReference>` : '';

        const receiptBlock = `
    <cac:ReceiptDocumentReference>
        <cbc:ID>NOTAPPLICABLE</cbc:ID>
    </cac:ReceiptDocumentReference>`;

        const originatorBlock = `
    <cac:OriginatorDocumentReference>
        <cbc:ID>NOTAPPLICABLE</cbc:ID>
    </cac:OriginatorDocumentReference>`;

        const contractBlock = otherRefNum ? `
    <cac:ContractDocumentReference>
        <cbc:ID>${esc(otherRefNum)}</cbc:ID>
    </cac:ContractDocumentReference>` : '';

        const projectBlock = `
    <cac:ProjectReference>
        <cbc:ID>NOTAPPLICABLE</cbc:ID>
    </cac:ProjectReference>`;

        const mandateBlock = (mandateRef || payerAccount) ? `
        <cac:PaymentMandate>
            ${mandateRef   ? `<cbc:ID>${esc(mandateRef)}</cbc:ID>` : ''}
            ${payerAccount ? `<cac:PayerFinancialAccount><cbc:ID>${esc(payerAccount)}</cbc:ID></cac:PayerFinancialAccount>` : ''}
        </cac:PaymentMandate>` : '';

        const termsBlock = terms ? `
    <cac:PaymentTerms>
        <cbc:Note>${esc(terms)}</cbc:Note>
    </cac:PaymentTerms>` : '';

        // ── Assemble — UBL CreditNote schema ────────────────────────────────
        return `<?xml version="1.0" encoding="UTF-8"?>
<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
            xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
            xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
    <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
    <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>
    <cbc:ProfileID>B1</cbc:ProfileID>
    <cbc:ID>${esc(tranId)}</cbc:ID>
    <cbc:UUID>${uuid}</cbc:UUID>
    <cbc:IssueDate>${tranDate}</cbc:IssueDate>
    <cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>
    <cbc:Note>#REG#TBC</cbc:Note>
    <cbc:Note>#ABL#TBC</cbc:Note>
    ${memo        ? `<cbc:Note>#AAI#${esc(memo)}</cbc:Note>` : ''}
    ${pmtInfoNote ? `<cbc:Note>#PMT#${esc(pmtInfoNote)}</cbc:Note>` : ''}
    <cbc:Note>#AAB#TBC</cbc:Note>
    <cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>
    ${accountingCost ? `<cbc:AccountingCost>${esc(accountingCost)}</cbc:AccountingCost>` : ''}
    ${otherRefNum ? `<cbc:BuyerReference>${esc(otherRefNum)}</cbc:BuyerReference>` : ''}${periodBlock}${orderRefBlock}${billingRefBlock}${receiptBlock}${originatorBlock}${contractBlock}${projectBlock}
    <cac:AccountingSupplierParty>
        <cac:Party>
            <cbc:EndpointID schemeID="0225">${esc(selSiren)}</cbc:EndpointID>
            <cac:PartyIdentification>
                <cbc:ID schemeID="0009">${esc(selSiret)}</cbc:ID>
            </cac:PartyIdentification>
            <cac:PartyName><cbc:Name>${esc(selName)}</cbc:Name></cac:PartyName>
            <cac:PostalAddress>
                <cbc:StreetName>${esc(selAddr1)}</cbc:StreetName>
                ${selAddr2 ? `<cbc:AdditionalStreetName>${esc(selAddr2)}</cbc:AdditionalStreetName>` : ''}
                <cbc:CityName>${esc(selCity)}</cbc:CityName>
                <cbc:PostalZone>${selZip}</cbc:PostalZone>
                <cac:Country><cbc:IdentificationCode>${selCountry}</cbc:IdentificationCode></cac:Country>
            </cac:PostalAddress>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>${esc(selVat)}</cbc:CompanyID>
                <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>${esc(selName)}</cbc:RegistrationName>
                <cbc:CompanyID schemeID="0002">${esc(selSiren)}</cbc:CompanyID>
                <cbc:CompanyLegalForm>${esc(selLegalForm)}</cbc:CompanyLegalForm>
            </cac:PartyLegalEntity>
            <cac:Contact>
                <cbc:Name>${esc(selContact)}</cbc:Name>
                <cbc:Telephone>${esc(selPhone)}</cbc:Telephone>
                <cbc:ElectronicMail>${esc(selEmail)}</cbc:ElectronicMail>
            </cac:Contact>
        </cac:Party>
    </cac:AccountingSupplierParty>
    <cac:AccountingCustomerParty>
        <cac:Party>
            <cbc:EndpointID schemeID="0225">${esc(custSiren)}</cbc:EndpointID>
            <cac:PartyIdentification>
                <cbc:ID schemeID="0009">${esc(custSiret)}</cbc:ID>
            </cac:PartyIdentification>
            <cac:PartyName><cbc:Name>${esc(custName)}</cbc:Name></cac:PartyName>
            <cac:PostalAddress>
                <cbc:StreetName>${esc(custAddr1)}</cbc:StreetName>
                ${custAddr2 ? `<cbc:AdditionalStreetName>${esc(custAddr2)}</cbc:AdditionalStreetName>` : ''}
                <cbc:CityName>${esc(custCity)}</cbc:CityName>
                <cbc:PostalZone>${custZip}</cbc:PostalZone>
                <cac:Country><cbc:IdentificationCode>${custCountry}</cbc:IdentificationCode></cac:Country>
            </cac:PostalAddress>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>${esc(custVat)}</cbc:CompanyID>
                <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:CompanyID schemeID="0002">${esc(custSiren)}</cbc:CompanyID>
            </cac:PartyLegalEntity>
            <cac:Contact>
                <cbc:Name>${esc(custName)}</cbc:Name>
                <cbc:Telephone>${esc(custPhone)}</cbc:Telephone>
                <cbc:ElectronicMail>${esc(custEmail)}</cbc:ElectronicMail>
            </cac:Contact>
        </cac:Party>
    </cac:AccountingCustomerParty>
    <cac:PaymentMeans>
        <cbc:PaymentMeansCode>${esc(payMeansCode)}</cbc:PaymentMeansCode>
        <cac:PayeeFinancialAccount>
            <cbc:ID>${esc(selIBAN)}</cbc:ID>
            <cbc:Name>${esc(selBankName)}</cbc:Name>
            <cac:FinancialInstitutionBranch><cbc:ID>${esc(selBIC)}</cbc:ID></cac:FinancialInstitutionBranch>
        </cac:PayeeFinancialAccount>${mandateBlock}
    </cac:PaymentMeans>${termsBlock}
    <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${currency}">${totalTax.toFixed(2)}</cbc:TaxAmount>${taxSubtotalsXml}
    </cac:TaxTotal>
    <cac:LegalMonetaryTotal>
        <cbc:LineExtensionAmount currencyID="${currency}">${lineExtTotal.toFixed(2)}</cbc:LineExtensionAmount>
        <cbc:TaxExclusiveAmount currencyID="${currency}">${subtotal}</cbc:TaxExclusiveAmount>
        <cbc:TaxInclusiveAmount currencyID="${currency}">${total}</cbc:TaxInclusiveAmount>
        <cbc:PayableAmount currencyID="${currency}">${amountDue}</cbc:PayableAmount>
    </cac:LegalMonetaryTotal>${linesXml}
</CreditNote>`;
    }

    return { afterSubmit };
});
