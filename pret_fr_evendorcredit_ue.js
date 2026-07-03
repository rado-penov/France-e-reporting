/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Generates a UBL 2.1 / EN 16931 CreditNote XML for French e-invoicing on vendor credit save,
 * saves it to the File Cabinet, sends it via HTTPS API and stamps the export flags
 * on the vendor credit.
 *
 * Fires on CREATE or COPY only. Only processes vendor credits where subsidiary = 16 (France) or vendor country = FR.
 *
 * Party roles:
 *   AccountingSupplierParty = the Vendor  (issuing the credit note)
 *   AccountingCustomerParty = Subsidiary  (Pret France — receiving the credit)
 *
 * Script Parameters (defined on the Script record in NetSuite):
 *   custscript_pret_api_url_vc           Free-form text — API endpoint URL
 *   custscript_pret_api_function_key_vc  Free-form text — Value sent as the X-Function-Key header
 *   custscript_pret_api_doc_type_vc      Free-form text — Value sent as the x-pret-document-type header
 *   custscript_pret_ubl_folder_vc        Free-form text — File Cabinet folder ID for XML files
 */
define(['N/record', 'N/file', 'N/https', 'N/runtime', 'N/log'],
(record, file, https, runtime, log) => {

    // ── afterSubmit ──────────────────────────────────────────────────────────
    function afterSubmit(context) {
        const execCtx = runtime.executionContext;
        log.audit('UBL STEP 1 - FIRED', `context.type: ${context.type} | executionContext: ${execCtx} | record id: ${context.newRecord.id}`);

        const { CREATE, COPY } = context.UserEventType;

        if (context.type !== CREATE && context.type !== COPY) {
            log.audit('UBL STEP 1 - SKIPPED', `Only fires on CREATE or COPY, got: ${context.type}`);
            return;
        }
        log.audit('UBL STEP 2 - EVENT TYPE OK', `Processing ${context.type} for record id: ${context.newRecord.id}`);

        try {
            const script     = runtime.getCurrentScript();
            const apiUrl     = script.getParameter({ name: 'custscript_pret_api_url_vc' });
            const apiKey     = script.getParameter({ name: 'custscript_pret_api_function_key_vc' });
            const apiDocType = script.getParameter({ name: 'custscript_pret_api_doc_type_vc' });
            const folderId   = parseInt(script.getParameter({ name: 'custscript_pret_ubl_folder_vc' }), 10);
            log.audit('UBL STEP 3 - PARAMS READ', `folderId: ${folderId} | url: ${apiUrl || '(empty)'} | functionKey set: ${!!apiKey} | docType: ${apiDocType || '(empty)'}`);

            if (!folderId || isNaN(folderId)) throw new Error('custscript_pret_ubl_folder_vc parameter is not set on the deployment');

            const vc = record.load({ type: record.Type.VENDOR_CREDIT, id: context.newRecord.id });
            const tranId0      = vc.getValue('tranid');
            const subsidiaryId = parseInt(vc.getValue('subsidiary'), 10);

            const vendor = record.load({ type: record.Type.VENDOR, id: vc.getValue('entity') });
            const vendorCountry = vendor.getValue('billcountry') || '';

            const isFrance = vendorCountry === 'FR' || subsidiaryId === 16;
            log.audit('UBL STEP 4 - VC LOADED', `tranid: ${tranId0} | vendorCountry: ${vendorCountry} | subsidiaryId: ${subsidiaryId} | isFrance: ${isFrance}`);

            if (!isFrance) {
                log.audit('UBL STEP 4 - SKIPPED', `VC: ${tranId0} | not France — vendorCountry: ${vendorCountry} | subsidiaryId: ${subsidiaryId}`);
                return;
            }

            log.audit('UBL STEP 5 - VALIDATION OK', `VC: ${tranId0}`);

            const sub = record.load({ type: 'subsidiary', id: vc.getValue('subsidiary') });
            log.audit('UBL STEP 6 - SUBSIDIARY LOADED', `id: ${vc.getValue('subsidiary')} | legalname: ${sub.getValue('legalname')}`);
            log.audit('UBL STEP 7 - VENDOR LOADED',     `id: ${vc.getValue('entity')} | companyname: ${vendor.getValue('companyname')}`);

            let period = null;
            const periodId = vc.getValue('postingperiod');
            if (periodId) {
                try {
                    period = record.load({ type: 'accountingperiod', id: periodId });
                    log.audit('UBL STEP 8 - PERIOD LOADED', `periodId: ${periodId}`);
                } catch (e) {
                    log.error('UBL PERIOD LOAD FAILED', `VC: ${tranId0} | periodId: ${periodId} | ${e.message}`);
                }
            } else {
                log.audit('UBL STEP 8 - PERIOD SKIPPED', `No postingperiod on VC: ${tranId0}`);
            }

            const itemLines = vc.getLineCount({ sublistId: 'item' });
            const expLines  = vc.getLineCount({ sublistId: 'expense' });
            log.audit('UBL STEP 9 - BUILDING XML', `VC: ${tranId0} | item lines: ${itemLines} | expense lines: ${expLines}`);

            const uuid     = generateUUID();
            const xml      = buildUBL(vc, sub, vendor, period, uuid);
            const tranId   = String(vc.getValue('tranid'));
            const tranDate = fmtDate(vc.getValue('trandate')).replace(/-/g, '');
            const fileName = `${tranDate}_${tranId}_${vc.id}.xml`;
            log.audit('UBL STEP 10 - XML BUILT', `VC: ${tranId} | fileName: ${fileName} | xmlLength: ${xml.length}`);

            log.audit('UBL STEP 11 - SAVING FILE', `VC: ${tranId} | fileName: ${fileName} | folderId: ${folderId}`);
            const xmlFile = file.create({
                name:     fileName,
                fileType: file.Type.XMLDOC,
                contents: xml,
                folder:   folderId
            });
            const fileId = xmlFile.save();
            log.audit('UBL STEP 12 - FILE SAVED', `VC: ${tranId} | File: ${fileName} | File ID: ${fileId}`);

            log.audit('UBL STEP 13 - API PARAMS', `VC: ${tranId} | url: ${apiUrl || '(empty)'} | functionKey set: ${!!apiKey} | docType: ${apiDocType || '(empty)'}`);

            let sentToBW = false;
            if (apiUrl && apiKey && apiDocType) {
                try {
                    log.audit('UBL STEP 14 - API CALLING', `VC: ${tranId} | POST ${apiUrl}`);
                    const response = https.post({
                        url:  apiUrl,
                        body: xml,
                        headers: {
                            'Content-Type':         'application/xml',
                            'X-Function-Key':       apiKey,
                            'x-pret-document-type': apiDocType
                        }
                    });
                    if (response.code >= 200 && response.code < 300) {
                        sentToBW = true;
                        log.audit('UBL API SENT', `VC: ${tranId} | Status: ${response.code}`);
                    } else {
                        log.error('UBL API FAILED', `VC: ${tranId} | Status: ${response.code} | Body: ${response.body}`);
                    }
                } catch (apiErr) {
                    log.error('UBL API FAILED', `VC: ${tranId} | Name: ${apiErr.name} | Message: ${apiErr.message} | Stack: ${apiErr.stack}`);
                }
            } else {
                log.error('UBL API SKIPPED', `VC: ${tranId} | Missing parameters — url: ${!!apiUrl} | functionKey: ${!!apiKey} | docType: ${!!apiDocType}`);
            }

            log.audit('UBL STEP 17 - STAMPING FLAGS', `VC: ${tranId} | sentToBW: ${sentToBW}`);
            // TBC: confirm these custom field IDs exist on the Vendor Credit form
            record.submitFields({
                type:   record.Type.VENDOR_CREDIT,
                id:     vc.id,
                values: {
                    custbody_pret_ubl_export_ready:          true,
                    custbody_pret_ubl_export_date:           new Date(),
                    custbody_pret_vendorcredit_sent_to_bw:   sentToBW,
                    custbody_pret_uuid:                      uuid
                }
            });
            log.audit('UBL COMPLETE', `VC: ${tranId} | File ID: ${fileId} | Sent to BW: ${sentToBW} | UUID: ${uuid}`);

        } catch (e) {
            log.error('UBL FAILED', `VC: ${context.newRecord.id} | ${e.message}\n${e.stack}`);
        }
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
    function buildUBL(vc, sub, vendor, period, uuid) {

        // ── Vendor credit header ─────────────────────────────────────────────
        const tranId         = vc.getValue('tranid')      || 'NOT_TRANID';
        const tranDate       = fmtDate(vc.getValue('trandate')) || 'NOT_TRANDATE';
        const currency       = vc.getText('currency')     || 'NOT_CURRENCY';
        const terms          = vc.getText('terms')        || '';
        const memo           = vc.getValue('memo')        || '';
        const otherRefNum    = vc.getValue('otherrefnum') || '';
        const accountingCost = vendor.getValue('companyname') || '';
        // Reference to the original vendor bill this credit was raised against
        // getText('createdfrom') returns "Vendor Bill #VBFR00001" — strip the display prefix
        const originalBillRef = (vc.getText('createdfrom') || '').replace(/^Vendor\s+Bill\s+#?/i, '')
                             || vc.getValue('otherrefnum') || '';

        // ── Accounting period ────────────────────────────────────────────────
        const periodStart = period ? (fmtDate(period.getValue('startdate')) || '') : '';
        const periodEnd   = period ? (fmtDate(period.getValue('enddate'))   || '') : '';

        // ── Vendor (AccountingSupplierParty) ─────────────────────────────────
        // TBC: confirm SIREN/SIRET/legal form custom field IDs on the Vendor record
        const vendSiren     = vendor.getValue('custentity_pret_siren')              || 'NOT_VENDOR_SIREN';
        const vendSiret     = vendor.getValue('custentity_pret_siret')              || 'NOT_VENDOR_SIRET';
        const vendName      = vendor.getValue('companyname')                        || 'NOT_VENDOR_NAME';
        const vendAddr1     = vendor.getValue('billaddr1')                          || 'NOT_VENDOR_ADDR1';
        const vendAddr2     = vendor.getValue('billaddr2')                          || '';
        const vendCity      = vendor.getValue('billcity')                           || 'NOT_VENDOR_CITY';
        const vendZip       = vendor.getValue('billzip')                            || 'NOT_VENDOR_ZIP';
        const vendCountry   = vendor.getValue('billcountry')                        || 'NOT_VENDOR_COUNTRY';
        const vendVat       = vendor.getValue('vatregnumber')                       || 'NOT_VENDOR_VAT';
        const vendLegalForm = vendor.getValue('custentity_pret_sub_invoice_footer_text') || 'NOT_VENDOR_LEGAL_FORM'; // TBC
        const vendPhone     = vendor.getValue('phone')                              || 'NOT_VENDOR_PHONE';
        const vendEmail     = vendor.getValue('email')                              || 'NOT_VENDOR_EMAIL';

        // ── Subsidiary (AccountingCustomerParty = Pret France) ───────────────
        const subSiren    = sub.getValue('custrecord_pret_siren')                   || 'NOT_SUB_SIREN';
        const subSiret    = sub.getValue('custrecord_pret_siret')                   || 'NOT_SUB_SIRET';
        const subName     = sub.getValue('legalname')                               || 'NOT_SUB_NAME';
        const mainAddr    = sub.getSubrecord({ fieldId: 'mainaddress' });
        const subAddr1    = mainAddr.getValue('addr1')   || 'NOT_SUB_ADDR1';
        const subAddr2    = mainAddr.getValue('addr2')   || '';
        const subCity     = mainAddr.getValue('city')    || 'NOT_SUB_CITY';
        const subZip      = mainAddr.getValue('zip')     || 'NOT_SUB_ZIP';
        const subCountry  = mainAddr.getValue('country') || sub.getValue('country') || 'NOT_SUB_COUNTRY';
        const subVat      = sub.getValue('federalidnumber')                         || 'NOT_SUB_VAT';
        const subLegalForm = sub.getValue('custrecord_pret_sub_invoice_footer_text') || 'NOT_SUB_LEGAL_FORM';
        const subPhone    = sub.getValue('custrecord_pret_phone_number')             || 'NOT_SUB_PHONE';
        const subEmail    = sub.getValue('custrecord_pay_remittance_contact')        || 'NOT_SUB_EMAIL';
        // Pret's bank account — payee since subsidiary is receiving the refund
        const subIBAN     = sub.getValue('custrecord_pret_bank_account_iban')        || 'NOT_SUB_IBAN';
        const subBankName = sub.getValue('custrecord_pret_bank_name')                || 'NOT_SUB_BANK_NAME';
        const subBIC      = sub.getValue('custrecord_pret_sort_code_bic')            || 'NOT_SUB_BIC';
        const pmtInfoNote = sub.getValue('custrecord_pret_payment_info')             || '';
        const payMeansCode = vendor.getValue('custentity_pret_pay_method')           || 'NOT_PAY_METHOD'; // TBC

        // ── Lines + tax accumulation ─────────────────────────────────────────
        const taxMap     = {};
        let lineExtTotal = 0;
        let linesXml     = '';
        let lineCounter  = 0;

        // Item-based lines
        const itemLineCount = vc.getLineCount({ sublistId: 'item' });
        for (let i = 0; i < itemLineCount; i++) {
            lineCounter++;
            // Vendor credit quantities and amounts are stored as positive in NetSuite.
            // The 'amount' field can return 0 via SuiteScript; fall back to qty * rate.
            const qty       = absNum(vc.getSublistValue({ sublistId: 'item', fieldId: 'quantity',    line: i }));
            const rate      = absNum(vc.getSublistValue({ sublistId: 'item', fieldId: 'rate',        line: i }));
            const rawAmount = parseFloat(vc.getSublistValue({ sublistId: 'item', fieldId: 'amount',  line: i })) || 0;
            const amount    = rawAmount !== 0 ? absNum(rawAmount) : (parseFloat(qty) * parseFloat(rate)).toFixed(2);
            const desc      = vc.getSublistValue({ sublistId: 'item', fieldId: 'description', line: i })
                           || vc.getSublistText({  sublistId: 'item', fieldId: 'item',        line: i })
                           || `NOT_DESC_LINE${lineCounter}`;
            const itemId    = vc.getSublistValue({ sublistId: 'item', fieldId: 'item',     line: i }) || `NOT_ITEM_LINE${lineCounter}`;
            const taxRate   = num(vc.getSublistValue({ sublistId: 'item', fieldId: 'taxrate1', line: i }), 1);
            const lineNum   = vc.getSublistValue({ sublistId: 'item', fieldId: 'line', line: i }) || lineCounter;
            const taxCode   = 'S';  // TBC: derive from NetSuite tax code mapping (S/Z/E/AE)
            const uom       = 'EA'; // TBC: derive from NetSuite UOM mapping

            lineExtTotal += parseFloat(amount);
            const key = `${taxCode}_${taxRate}`;
            if (!taxMap[key]) taxMap[key] = { code: taxCode, rate: taxRate, base: 0, tax: 0 };
            taxMap[key].base += parseFloat(amount);
            taxMap[key].tax  += parseFloat(amount) * parseFloat(taxRate) / 100;

            linesXml += `
    <cac:CreditNoteLine>
        <cbc:ID>${lineCounter}</cbc:ID>
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

        // Expense-based lines
        const expLineCount = vc.getLineCount({ sublistId: 'expense' });
        for (let i = 0; i < expLineCount; i++) {
            lineCounter++;
            const rawAmount = parseFloat(vc.getSublistValue({ sublistId: 'expense', fieldId: 'amount',  line: i })) || 0;
            const amount    = absNum(rawAmount);
            const desc      = vc.getSublistValue({ sublistId: 'expense', fieldId: 'memo',    line: i })
                           || vc.getSublistText({  sublistId: 'expense', fieldId: 'account', line: i })
                           || `NOT_DESC_EXP${lineCounter}`;
            const taxRate   = num(vc.getSublistValue({ sublistId: 'expense', fieldId: 'taxrate1', line: i }), 1);
            const lineNum   = vc.getSublistValue({ sublistId: 'expense', fieldId: 'line', line: i }) || lineCounter;
            const taxCode   = 'S';
            const uom       = 'EA';

            lineExtTotal += parseFloat(amount);
            const key = `${taxCode}_${taxRate}`;
            if (!taxMap[key]) taxMap[key] = { code: taxCode, rate: taxRate, base: 0, tax: 0 };
            taxMap[key].base += parseFloat(amount);
            taxMap[key].tax  += parseFloat(amount) * parseFloat(taxRate) / 100;

            linesXml += `
    <cac:CreditNoteLine>
        <cbc:ID>${lineCounter}</cbc:ID>
        <cbc:CreditedQuantity unitCode="${uom}">1</cbc:CreditedQuantity>
        <cbc:LineExtensionAmount currencyID="${currency}">${amount}</cbc:LineExtensionAmount>
        <cac:OrderLineReference><cbc:LineID>${lineNum}</cbc:LineID></cac:OrderLineReference>
        <cac:Item>
            <cbc:Name>${esc(desc)}</cbc:Name>
            <cac:ClassifiedTaxCategory>
                <cbc:ID>${taxCode}</cbc:ID>
                <cbc:Percent>${parseFloat(taxRate).toFixed(1)}</cbc:Percent>
                <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
            </cac:ClassifiedTaxCategory>
        </cac:Item>
        <cac:Price>
            <cbc:PriceAmount currencyID="${currency}">${amount}</cbc:PriceAmount>
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
        // subtotal/total can return 0 via SuiteScript on vendor credits; fall back to line-computed values.
        // amountdue does not exist on vendor credits — use unapplied (unapplied credit balance).
        const subtotalRaw = parseFloat(absNum(vc.getValue('subtotal')));
        const totalRaw    = parseFloat(absNum(vc.getValue('total')));
        const subtotal    = (subtotalRaw || lineExtTotal).toFixed(2);
        const total       = (totalRaw    || (lineExtTotal + totalTax)).toFixed(2);
        const amountDue   = absNum(vc.getValue('unapplied') || vc.getValue('amountremaining'));

        // ── Optional XML blocks ──────────────────────────────────────────────
        const billingRefBlock = originalBillRef ? `
    <cac:BillingReference>
        <cac:InvoiceDocumentReference>
            <cbc:ID>${esc(originalBillRef)}</cbc:ID>
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

        const termsBlock = terms ? `
    <cac:PaymentTerms>
        <cbc:Note>${esc(terms)}</cbc:Note>
    </cac:PaymentTerms>` : '';

        // ── Assemble — UBL CreditNote schema ─────────────────────────────────
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
            <cbc:EndpointID schemeID="0225">${esc(vendSiren)}</cbc:EndpointID>
            <cac:PartyIdentification>
                <cbc:ID schemeID="0009">${esc(vendSiret)}</cbc:ID>
            </cac:PartyIdentification>
            <cac:PartyName><cbc:Name>${esc(vendName)}</cbc:Name></cac:PartyName>
            <cac:PostalAddress>
                <cbc:StreetName>${esc(vendAddr1)}</cbc:StreetName>
                ${vendAddr2 ? `<cbc:AdditionalStreetName>${esc(vendAddr2)}</cbc:AdditionalStreetName>` : ''}
                <cbc:CityName>${esc(vendCity)}</cbc:CityName>
                <cbc:PostalZone>${vendZip}</cbc:PostalZone>
                <cac:Country><cbc:IdentificationCode>${vendCountry}</cbc:IdentificationCode></cac:Country>
            </cac:PostalAddress>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>${esc(vendVat)}</cbc:CompanyID>
                <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>${esc(vendName)}</cbc:RegistrationName>
                <cbc:CompanyID schemeID="0002">${esc(vendSiren)}</cbc:CompanyID>
                <cbc:CompanyLegalForm>${esc(vendLegalForm)}</cbc:CompanyLegalForm>
            </cac:PartyLegalEntity>
            <cac:Contact>
                <cbc:Name>${esc(vendName)}</cbc:Name>
                <cbc:Telephone>${esc(vendPhone)}</cbc:Telephone>
                <cbc:ElectronicMail>${esc(vendEmail)}</cbc:ElectronicMail>
            </cac:Contact>
        </cac:Party>
    </cac:AccountingSupplierParty>
    <cac:AccountingCustomerParty>
        <cac:Party>
            <cbc:EndpointID schemeID="0225">${esc(subSiren)}</cbc:EndpointID>
            <cac:PartyIdentification>
                <cbc:ID schemeID="0009">${esc(subSiret)}</cbc:ID>
            </cac:PartyIdentification>
            <cac:PartyName><cbc:Name>${esc(subName)}</cbc:Name></cac:PartyName>
            <cac:PostalAddress>
                <cbc:StreetName>${esc(subAddr1)}</cbc:StreetName>
                ${subAddr2 ? `<cbc:AdditionalStreetName>${esc(subAddr2)}</cbc:AdditionalStreetName>` : ''}
                <cbc:CityName>${esc(subCity)}</cbc:CityName>
                <cbc:PostalZone>${subZip}</cbc:PostalZone>
                <cac:Country><cbc:IdentificationCode>${subCountry}</cbc:IdentificationCode></cac:Country>
            </cac:PostalAddress>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>${esc(subVat)}</cbc:CompanyID>
                <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>${esc(subName)}</cbc:RegistrationName>
                <cbc:CompanyID schemeID="0002">${esc(subSiren)}</cbc:CompanyID>
                <cbc:CompanyLegalForm>${esc(subLegalForm)}</cbc:CompanyLegalForm>
            </cac:PartyLegalEntity>
            <cac:Contact>
                <cbc:Name>${esc(subName)}</cbc:Name>
                <cbc:Telephone>${esc(subPhone)}</cbc:Telephone>
                <cbc:ElectronicMail>${esc(subEmail)}</cbc:ElectronicMail>
            </cac:Contact>
        </cac:Party>
    </cac:AccountingCustomerParty>
    <cac:PaymentMeans>
        <cbc:PaymentMeansCode>${esc(payMeansCode)}</cbc:PaymentMeansCode>
        <cac:PayeeFinancialAccount>
            <cbc:ID>${esc(subIBAN)}</cbc:ID>
            <cbc:Name>${esc(subBankName)}</cbc:Name>
            <cac:FinancialInstitutionBranch><cbc:ID>${esc(subBIC)}</cbc:ID></cac:FinancialInstitutionBranch>
        </cac:PayeeFinancialAccount>
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
