/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Generates a UBL 2.1 / EN 16931 XML for French e-invoicing on invoice save,
 * saves it to the File Cabinet, sends it via HTTPS API and stamps the three
 * export flags on the invoice.
 *
 * Script Parameters (defined on the Script record in NetSuite):
 *   custscript_pret_api_url           Free-form text — API endpoint URL
 *   custscript_pret_api_function_key  Free-form Text — Value sent as the X-Function-Key header
 *   custscript_pret_api_doc_type      Free-form text — Value sent as the x-pret-document-type header
 *   custscript_pret_ubl_folder        Integer        — File Cabinet folder ID for XML files
 */
define(['N/record', 'N/file', 'N/https', 'N/runtime', 'N/log'],
(record, file, https, runtime, log) => {

    // ── afterSubmit ──────────────────────────────────────────────────────────
    function afterSubmit(context) {
        const { CREATE, COPY } = context.UserEventType;
        if (context.type !== CREATE && context.type !== COPY) return;

        try {
            const script      = runtime.getCurrentScript();
            const apiUrl      = script.getParameter({ name: 'custscript_pret_api_url' });
            const apiKey      = script.getParameter({ name: 'custscript_pret_api_function_key' });
            const apiDocType  = script.getParameter({ name: 'custscript_pret_api_doc_type' });
            const folderId    = parseInt(script.getParameter({ name: 'custscript_pret_ubl_folder' }), 10);

            if (!folderId || isNaN(folderId)) throw new Error('custscript_pret_ubl_folder parameter is not set on the deployment');

            const inv = record.load({ type: record.Type.INVOICE, id: context.newRecord.id });

            // Only process French invoices (FR subsidiary ID=16 or billing country = FR)
            const isFrSubsidiary  = String(inv.getValue('subsidiary')) === '16';
            const isFrBillCountry = inv.getValue('billcountry') === 'FR';
            if (!isFrSubsidiary && !isFrBillCountry) return;

            const sub  = record.load({ type: 'subsidiary', id: inv.getValue('subsidiary') });
            const cust = record.load({ type: record.Type.CUSTOMER, id: inv.getValue('entity') });

            let period = null;
            const periodId = inv.getValue('postingperiod');
            if (periodId) {
                try {
                    period = record.load({ type: 'accountingperiod', id: periodId });
                } catch (e) {
                    log.error('UBL PERIOD LOAD FAILED', `Invoice: ${inv.getValue('tranid')} | periodId: ${periodId} | ${e.message}`);
                }
            }

            const uuid     = generateUUID();
            const xml      = buildUBL(inv, sub, cust, period, uuid);
            const tranId   = String(inv.getValue('tranid'));
            const tranDate = fmtDate(inv.getValue('trandate')).replace(/-/g, '');
            const fileName = `${tranDate}_${tranId}_${inv.id}.xml`;

            const xmlFile = file.create({
                name:     fileName,
                fileType: file.Type.XMLDOC,
                contents: xml,
                folder:   folderId
            });
            const fileId = xmlFile.save();
            log.audit('UBL FILE SAVED', `Invoice: ${tranId} | File: ${fileName} | File ID: ${fileId}`);

            // Send via HTTPS API
            log.audit('UBL API PARAMS', `Invoice: ${tranId} | url: ${apiUrl || '(empty)'} | functionKey set: ${!!apiKey} | docType: ${apiDocType || '(empty)'}`);

            let sentToBW = false;
            if (apiUrl && apiKey && apiDocType) {
                try {
                    log.audit('UBL API CALLING', `Invoice: ${tranId} | POST ${apiUrl}`);
                    const response = https.post({
                        url:  apiUrl,
                        body: xml,
                        headers: {
                            'Content-Type':          'application/xml',
                            'X-Function-Key':        apiKey,
                            'x-pret-document-type':  apiDocType
                        }
                    });
                    if (response.code >= 200 && response.code < 300) {
                        sentToBW = true;
                        log.audit('UBL API SENT', `Invoice: ${tranId} | Status: ${response.code}`);
                    } else {
                        log.error('UBL API FAILED', `Invoice: ${tranId} | Status: ${response.code} | Body: ${response.body}`);
                    }
                } catch (apiErr) {
                    log.error('UBL API FAILED', `Invoice: ${tranId} | Name: ${apiErr.name} | Message: ${apiErr.message} | Stack: ${apiErr.stack}`);
                }
            } else {
                log.error('UBL API SKIPPED', `Invoice: ${tranId} | Missing parameters — url: ${!!apiUrl} | functionKey: ${!!apiKey} | docType: ${!!apiDocType}`);
            }

            record.submitFields({
                type:   record.Type.INVOICE,
                id:     inv.id,
                values: {
                    custbody_pret_ubl_export_ready:   true,
                    custbody_pret_ubl_export_date:    new Date(),
                    custbody_pret_invoice_sent_to_bw: sentToBW,
                    custbody_pret_uuid:               uuid
                }
            });
            log.audit('UBL COMPLETE', `Invoice: ${tranId} | File ID: ${fileId} | Sent to BW: ${sentToBW} | UUID: ${uuid}`);

        } catch (e) {
            log.error('UBL FAILED', `Invoice: ${context.newRecord.id} | ${e.message}\n${e.stack}`);
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

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

    // ── UBL 2.1 / EN 16931 builder ───────────────────────────────────────────
    function buildUBL(inv, sub, cust, period, uuid) {

        // ── Invoice header ───────────────────────────────────────────────────
        const tranId         = inv.getValue('tranid')                              || 'NOT_TRANID';
        const tranDate       = fmtDate(inv.getValue('trandate'))                   || 'NOT_TRANDATE';
        const dueDate        = fmtDate(inv.getValue('duedate'))                    || 'NOT_DUEDATE';
        const currency       = inv.getText('currency')                             || 'NOT_CURRENCY';
        const terms          = inv.getText('terms')                                || '';
        const memo           = inv.getValue('memo')                                || '';
        const otherRefNum    = inv.getValue('otherrefnum')                         || '';
        const accountingCost = cust.getValue('companyname')                        || '';
        // CASE WHEN {createdfrom} IS NULL THEN {otherrefnum} ELSE {createdfrom} END
        const createdFrom    = inv.getText('createdfrom') || inv.getValue('otherrefnum') || '';
        const despatchRef    = inv.getValue('custbody2')                           || '';

        // ── Accounting period ────────────────────────────────────────────────
        const periodStart = period ? (fmtDate(period.getValue('startdate')) || '') : '';
        const periodEnd   = period ? (fmtDate(period.getValue('enddate'))   || '') : '';

        // ── Supplier (subsidiary) ────────────────────────────────────────────
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

        // ── Delivery ─────────────────────────────────────────────────────────
        const deliveryDate = fmtDate(inv.getValue('custbody_pret_delivery_date'))     || '';
        let delLocId    = inv.getValue('shipaddressee')  || '';
        let delAddr1    = inv.getValue('shipaddr1')      || '';
        let delAddr2    = inv.getValue('shipaddr2')      || '';
        let delCity     = inv.getValue('shipcity')       || '';
        let delZip      = inv.getValue('shipzip')        || '';
        let delCountry  = inv.getValue('shipcountry')    || '';
        let delParty    = inv.getValue('shipattention')  || '';

        // Direct fields are unavailable when shipoverride=F — parse the formatted shipaddress field
        if (!delAddr1) {
            const rawAddr = (inv.getValue('shipaddress') || '').replace(/<br\s*\/?>/gi, '\n');
            const lines   = rawAddr.split('\n').map(l => l.trim()).filter(l => l);
            // Standard NetSuite format: attention, addressee, addr1, [addr2,] city+zip, country
            const zipIdx  = delZip ? lines.findIndex(l => l.includes(delZip)) : -1;
            const before  = zipIdx > 0 ? lines.slice(0, zipIdx) : lines.slice(0, -2);
            delParty  = before[0] || '';
            delLocId  = before[1] || '';
            delAddr1  = before[before.length - 1] || '';
            delAddr2  = before.length > 3 ? before[before.length - 2] : '';
            if (zipIdx >= 0) delCity = lines[zipIdx].replace(delZip, '').trim();
        }

        // ── Lines + tax accumulation ─────────────────────────────────────────
        const lineCount  = inv.getLineCount({ sublistId: 'item' });
        const taxMap     = {};
        let lineExtTotal = 0;
        let linesXml     = '';

        for (let i = 0; i < lineCount; i++) {
            const qty          = num(inv.getSublistValue({ sublistId: 'item', fieldId: 'quantity',    line: i }));
            const rate         = num(inv.getSublistValue({ sublistId: 'item', fieldId: 'rate',        line: i }));
            const amount       = num(inv.getSublistValue({ sublistId: 'item', fieldId: 'amount',      line: i }));
            const desc         = inv.getSublistValue({     sublistId: 'item', fieldId: 'description', line: i })
                              || inv.getSublistText({      sublistId: 'item', fieldId: 'item',        line: i })
                              || `NOT_DESC_LINE${i + 1}`;
            const itemId       = inv.getSublistValue({ sublistId: 'item', fieldId: 'item',                      line: i }) || `NOT_ITEM_LINE${i + 1}`;
            const taxRate      = num(inv.getSublistValue({ sublistId: 'item', fieldId: 'taxrate1',              line: i }), 1);
            const lineNum      = inv.getSublistValue({ sublistId: 'item', fieldId: 'line',                      line: i }) || (i + 1);
            const taxCode = 'S';   // TBC: derive from NetSuite tax code mapping (S/Z/E/AE)
            const uom     = 'EA';  // TBC: derive from NetSuite UOM mapping

            lineExtTotal += parseFloat(amount);

            const key = `${taxCode}_${taxRate}`;
            if (!taxMap[key]) taxMap[key] = { code: taxCode, rate: taxRate, base: 0, tax: 0 };
            taxMap[key].base += parseFloat(amount);
            taxMap[key].tax  += parseFloat(amount) * parseFloat(taxRate) / 100;

            linesXml += `
    <cac:InvoiceLine>
        <cbc:ID>${i + 1}</cbc:ID>
        <cbc:InvoicedQuantity unitCode="${uom}">${qty}</cbc:InvoicedQuantity>
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
    </cac:InvoiceLine>`;
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

        // ── Monetary totals ──────────────────────────────────────────────────
        const subtotal  = num(inv.getValue('subtotal'));
        const total     = num(inv.getValue('total'));
        const amountDue = num(inv.getValue('amountdue'));

        // ── Optional XML blocks ──────────────────────────────────────────────
        const periodBlock = (periodStart && periodEnd) ? `
    <cac:InvoicePeriod>
        <cbc:StartDate>${periodStart}</cbc:StartDate>
        <cbc:EndDate>${periodEnd}</cbc:EndDate>
        <cbc:DescriptionCode>3</cbc:DescriptionCode>
    </cac:InvoicePeriod>` : '';

        const orderRefBlock = (otherRefNum || createdFrom) ? `
    <cac:OrderReference>
        ${otherRefNum ? `<cbc:ID>${esc(otherRefNum)}</cbc:ID>` : ''}
        ${createdFrom ? `<cbc:SalesOrderID>${esc(createdFrom)}</cbc:SalesOrderID>` : ''}
    </cac:OrderReference>` : '';

        const despatchBlock = despatchRef ? `
    <cac:DespatchDocumentReference>
        <cbc:ID>${esc(despatchRef)}</cbc:ID>
    </cac:DespatchDocumentReference>` : '';

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

        const deliveryBlock = (deliveryDate || delAddr1) ? `
    <cac:Delivery>
        ${deliveryDate ? `<cbc:ActualDeliveryDate>${deliveryDate}</cbc:ActualDeliveryDate>` : ''}
        <cac:DeliveryLocation>
            ${delLocId ? `<cbc:ID>${esc(delLocId)}</cbc:ID>` : ''}
            <cac:Address>
                <cbc:StreetName>${esc(delAddr1)}</cbc:StreetName>
                ${delAddr2 ? `<cbc:AdditionalStreetName>${esc(delAddr2)}</cbc:AdditionalStreetName>` : ''}
                <cbc:CityName>${esc(delCity)}</cbc:CityName>
                <cbc:PostalZone>${delZip}</cbc:PostalZone>
                <cac:Country><cbc:IdentificationCode>${delCountry}</cbc:IdentificationCode></cac:Country>
            </cac:Address>
        </cac:DeliveryLocation>
        ${delParty ? `<cac:DeliveryParty><cac:PartyName><cbc:Name>${esc(delParty)}</cbc:Name></cac:PartyName></cac:DeliveryParty>` : ''}
    </cac:Delivery>` : '';

        const mandateBlock = (mandateRef || payerAccount) ? `
        <cac:PaymentMandate>
            ${mandateRef   ? `<cbc:ID>${esc(mandateRef)}</cbc:ID>` : ''}
            ${payerAccount ? `<cac:PayerFinancialAccount><cbc:ID>${esc(payerAccount)}</cbc:ID></cac:PayerFinancialAccount>` : ''}
        </cac:PaymentMandate>` : '';

        const termsBlock = terms ? `
    <cac:PaymentTerms>
        <cbc:Note>${esc(terms)}</cbc:Note>
    </cac:PaymentTerms>` : '';

        // ── Assemble ─────────────────────────────────────────────────────────
        return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
    <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
    <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>
    <cbc:ProfileID>B1</cbc:ProfileID>
    <cbc:ID>${esc(tranId)}</cbc:ID>
    <cbc:UUID>${uuid}</cbc:UUID>
    <cbc:IssueDate>${tranDate}</cbc:IssueDate>
    <cbc:DueDate>${dueDate}</cbc:DueDate>
    <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
    <cbc:Note>#REG#TBC</cbc:Note>
    <cbc:Note>#ABL#TBC</cbc:Note>
    ${memo        ? `<cbc:Note>#AAI#${esc(memo)}</cbc:Note>` : ''}
    ${pmtInfoNote ? `<cbc:Note>#PMT#${esc(pmtInfoNote)}</cbc:Note>` : ''}
    <cbc:Note>#AAB#TBC</cbc:Note>
    <cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>
    ${accountingCost ? `<cbc:AccountingCost>${esc(accountingCost)}</cbc:AccountingCost>` : ''}
    ${otherRefNum ? `<cbc:BuyerReference>${esc(otherRefNum)}</cbc:BuyerReference>` : ''}${periodBlock}${orderRefBlock}${despatchBlock}${receiptBlock}${originatorBlock}${contractBlock}${projectBlock}
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
    </cac:AccountingCustomerParty>${deliveryBlock}
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
</Invoice>`;
    }

    return { afterSubmit };
});
