/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Generates a UBL 2.1 / EN 16931 XML for French e-billing (vendor bills) on bill save,
 * saves it to the File Cabinet, sends it via HTTPS API and stamps the export flags
 * on the vendor bill.
 *
 * Only processes vendor bills where subsidiary = 16 (France).
 *
 * In the output XML:
 *   AccountingSupplierParty = Vendor   (sender of the bill)
 *   AccountingCustomerParty = Pret FR  (receiver / buyer, subsidiary ID=16)
 *
 * Script Parameters (defined on the Script record in NetSuite):
 *   custscript_pret_api_url_vb              Free-form text            — API endpoint URL
 *   custscript_pret_oauth_token_url_vb      Free-form text            — OAuth2 token endpoint URL (client_credentials grant)
 *   custscript_pret_oauth_client_id_vb      Free-form text            — OAuth2 client_id
 *   custscript_pret_oauth_client_secret_vb  Free-form Text (Password) — OAuth2 client_secret
 *   custscript_pret_oauth_scope_vb          Free-form text            — OAuth2 scope
 *   custscript_pret_api_doc_type_vb         Free-form text            — Value sent as the X-Pret-Document-Type header
 *   custscript_pret_ubl_folder_vb           Integer                   — File Cabinet folder ID for XML files
 */
define(['N/record', 'N/file', 'N/https', 'N/runtime', 'N/log'],
(record, file, https, runtime, log) => {

    // ── afterSubmit ──────────────────────────────────────────────────────────
    function afterSubmit(context) {
        const { CREATE, COPY } = context.UserEventType;
        log.audit('UBL FIRED', `context.type: ${context.type} | record id: ${context.newRecord.id}`);
        if (context.type !== CREATE && context.type !== COPY) {
            log.audit('UBL SKIPPED', `event type is not CREATE or COPY: ${context.type}`);
            return;
        }

        try {
            const script    = runtime.getCurrentScript();
            const apiUrl       = script.getParameter({ name: 'custscript_pret_api_url_vb' });
            const tokenUrl     = script.getParameter({ name: 'custscript_pret_oauth_token_url_vb' });
            const clientId     = script.getParameter({ name: 'custscript_pret_oauth_client_id_vb' });
            const clientSecret = script.getParameter({ name: 'custscript_pret_oauth_client_secret_vb' });
            const scope        = script.getParameter({ name: 'custscript_pret_oauth_scope_vb' });
            const apiDocType   = script.getParameter({ name: 'custscript_pret_api_doc_type_vb' });
            const folderId     = parseInt(script.getParameter({ name: 'custscript_pret_ubl_folder_vb' }), 10);

            if (!folderId || isNaN(folderId)) throw new Error('custscript_pret_ubl_folder_vb parameter is not set on the deployment');

            const bill = record.load({ type: record.Type.VENDOR_BILL, id: context.newRecord.id });
            const subsidiaryId = bill.getValue('subsidiary');

            // Only process France subsidiary (ID=16)
            if (String(subsidiaryId) !== '16') {
                log.audit('UBL SKIPPED', `Bill: ${bill.getValue('tranid')} | subsidiary is not France (16): ${subsidiaryId}`);
                return;
            }

            const sub    = record.load({ type: 'subsidiary', id: bill.getValue('subsidiary') });
            const vendor = record.load({ type: record.Type.VENDOR, id: bill.getValue('entity') });

            let period = null;
            const periodId = bill.getValue('postingperiod');
            if (periodId) {
                try {
                    period = record.load({ type: 'accountingperiod', id: periodId });
                } catch (e) {
                    log.error('UBL PERIOD LOAD FAILED', `Bill: ${bill.getValue('tranid')} | periodId: ${periodId} | ${e.message}`);
                }
            }

            const uuid     = generateUUID();
            const xml      = buildUBL(bill, sub, vendor, period, uuid);
            const tranId   = String(bill.getValue('tranid'));
            const tranDate = fmtDate(bill.getValue('trandate')).replace(/-/g, '');
            const fileName = `${tranDate}_${tranId}_${bill.id}.xml`;

            const xmlFile = file.create({
                name:     fileName,
                fileType: file.Type.XMLDOC,
                contents: xml,
                folder:   folderId
            });
            const fileId = xmlFile.save();
            log.audit('UBL FILE SAVED', `Bill: ${tranId} | File: ${fileName} | File ID: ${fileId}`);

            const oauthConfigured = !!(tokenUrl && clientId && clientSecret && scope);
            log.audit('UBL API PARAMS', `Bill: ${tranId} | url: ${apiUrl || '(empty)'} | oauth configured: ${oauthConfigured} | docType: ${apiDocType || '(empty)'}`);

            let sentToBW = false;
            if (apiUrl && oauthConfigured && apiDocType) {
                try {
                    const bearerToken = getBearerToken(tokenUrl, clientId, clientSecret, scope);
                    log.audit('UBL API CALLING', `Bill: ${tranId} | POST ${apiUrl}`);
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
                        log.audit('UBL API SENT', `Bill: ${tranId} | Status: ${response.code}`);
                    } else {
                        log.error('UBL API FAILED', `Bill: ${tranId} | Status: ${response.code} | Body: ${response.body}`);
                    }
                } catch (apiErr) {
                    log.error('UBL API FAILED', `Bill: ${tranId} | Name: ${apiErr.name} | Message: ${apiErr.message} | Stack: ${apiErr.stack}`);
                }
            } else {
                log.error('UBL API SKIPPED', `Bill: ${tranId} | Missing parameters — url: ${!!apiUrl} | oauth configured: ${oauthConfigured} | docType: ${!!apiDocType}`);
            }

            // TBC: confirm these custom field IDs exist on the Vendor Bill form
            record.submitFields({
                type:   record.Type.VENDOR_BILL,
                id:     bill.id,
                values: {
                    custbody_pret_ubl_export_ready:  true,
                    custbody_pret_ubl_export_date:   new Date(),
                    custbody_pret_bill_sent_to_bw:   sentToBW,
                    custbody_pret_uuid:              uuid
                }
            });
            log.audit('UBL COMPLETE', `Bill: ${tranId} | File ID: ${fileId} | Sent to BW: ${sentToBW} | UUID: ${uuid}`);

        } catch (e) {
            log.error('UBL FAILED', `Bill: ${context.newRecord.id} | ${e.message}\n${e.stack}`);
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
    function buildUBL(bill, sub, vendor, period, uuid) {

        // ── Bill header ──────────────────────────────────────────────────────
        const tranId      = bill.getValue('otherrefnum') || bill.getValue('tranid') || 'NOT_TRANID';
        const tranDate    = fmtDate(bill.getValue('trandate'))  || 'NOT_TRANDATE';
        const dueDate     = fmtDate(bill.getValue('duedate'))   || 'NOT_DUEDATE';
        const currency    = bill.getText('currency')            || 'NOT_CURRENCY';
        const terms       = bill.getText('terms')               || '';
        const memo        = bill.getValue('memo')               || '';
        const otherRefNum = bill.getValue('otherrefnum')        || '';
        // PO or order reference the bill was created from
        const createdFrom = bill.getText('createdfrom')         || '';

        // ── Accounting period ────────────────────────────────────────────────
        const periodStart = period ? (fmtDate(period.getValue('startdate')) || '') : '';
        const periodEnd   = period ? (fmtDate(period.getValue('enddate'))   || '') : '';

        // ── Seller (Vendor) ──────────────────────────────────────────────────
        // TBC: confirm SIREN/SIRET custom field IDs on the Vendor record
        const selSiren     = vendor.getValue('custentity_pret_siren')         || 'NOT_SELLER_SIREN';
        const selSiret     = vendor.getValue('custentity_pret_siret')         || 'NOT_SELLER_SIRET';
        const selName      = vendor.getValue('companyname')                   || 'NOT_SELLER_NAME';
        const selAddr1     = vendor.getValue('billaddr1')                     || 'NOT_SELLER_ADDR1';
        const selAddr2     = vendor.getValue('billaddr2')                     || '';
        const selCity      = vendor.getValue('billcity')                      || 'NOT_SELLER_CITY';
        const selZip       = vendor.getValue('billzip')                       || 'NOT_SELLER_ZIP';
        const selCountry   = vendor.getValue('billcountry')                   || 'NOT_SELLER_COUNTRY';
        const selVat       = vendor.getValue('vatregnumber')                  || 'NOT_SELLER_VAT';
        // TBC: confirm legal form field ID on Vendor record
        const selLegalForm = vendor.getValue('custentity_pret_legal_form')    || '';
        const selPhone     = vendor.getValue('phone')                         || 'NOT_SELLER_PHONE';
        const selEmail     = vendor.getValue('email')                         || 'NOT_SELLER_EMAIL';
        // TBC: confirm bank account field IDs on Vendor record
        const selIBAN      = vendor.getValue('custentity_pret_bank_iban')     || 'NOT_SELLER_IBAN';
        const selBankName  = vendor.getValue('custentity_pret_bank_name')     || 'NOT_SELLER_BANK_NAME';
        const selBIC       = vendor.getValue('custentity_pret_bank_bic')      || 'NOT_SELLER_BIC';
        // TBC: confirm payment method field ID on Vendor record
        const payMeansCode = vendor.getValue('custentity_pret_pay_method')    || 'NOT_PAY_METHOD';

        // ── Buyer (Pret France Subsidiary, ID=16) ────────────────────────────
        const buyerSiren     = sub.getValue('custrecord_pret_siren')                   || 'NOT_BUYER_SIREN';
        const buyerSiret     = sub.getValue('custrecord_pret_siret')                   || 'NOT_BUYER_SIRET';
        const buyerName      = sub.getValue('legalname')                               || 'NOT_BUYER_NAME';
        const mainAddr       = sub.getSubrecord({ fieldId: 'mainaddress' });
        const buyerAddr1     = mainAddr.getValue('addr1')   || 'NOT_BUYER_ADDR1';
        const buyerAddr2     = mainAddr.getValue('addr2')   || '';
        const buyerCity      = mainAddr.getValue('city')    || 'NOT_BUYER_CITY';
        const buyerZip       = mainAddr.getValue('zip')     || 'NOT_BUYER_ZIP';
        const buyerCountry   = mainAddr.getValue('country') || sub.getValue('country') || 'NOT_BUYER_COUNTRY';
        const buyerVat       = sub.getValue('federalidnumber')                          || 'NOT_BUYER_VAT';
        const buyerLegalForm = sub.getValue('custrecord_pret_sub_invoice_footer_text')  || '';
        const buyerPhone     = sub.getValue('custrecord_pret_phone_number')             || 'NOT_BUYER_PHONE';
        const buyerEmail     = sub.getValue('custrecord_pay_remittance_contact')        || 'NOT_BUYER_EMAIL';
        const pmtInfoNote    = sub.getValue('custrecord_pret_payment_info')             || '';

        // ── Lines + tax accumulation ─────────────────────────────────────────
        const taxMap     = {};
        let lineExtTotal = 0;
        let linesXml     = '';
        let lineIndex    = 0;

        // Item-based lines
        const itemLineCount = bill.getLineCount({ sublistId: 'item' });
        for (let i = 0; i < itemLineCount; i++) {
            lineIndex++;
            const qty     = num(bill.getSublistValue({ sublistId: 'item', fieldId: 'quantity',    line: i }));
            const rate    = num(bill.getSublistValue({ sublistId: 'item', fieldId: 'rate',        line: i }));
            const amount  = num(bill.getSublistValue({ sublistId: 'item', fieldId: 'amount',      line: i }));
            const desc    = bill.getSublistValue({     sublistId: 'item', fieldId: 'description', line: i })
                         || bill.getSublistText({      sublistId: 'item', fieldId: 'item',        line: i })
                         || `NOT_DESC_LINE${lineIndex}`;
            const itemId  = bill.getSublistValue({ sublistId: 'item', fieldId: 'item',     line: i }) || `NOT_ITEM_LINE${lineIndex}`;
            const taxRate = num(bill.getSublistValue({ sublistId: 'item', fieldId: 'taxrate1', line: i }), 1);
            const lineNum = bill.getSublistValue({ sublistId: 'item', fieldId: 'line',     line: i }) || lineIndex;
            const taxCode = 'S';   // TBC: derive from NetSuite tax code mapping (S/Z/E/AE)
            const uom     = 'EA';  // TBC: derive from NetSuite UOM mapping

            lineExtTotal += parseFloat(amount);
            const key = `${taxCode}_${taxRate}`;
            if (!taxMap[key]) taxMap[key] = { code: taxCode, rate: taxRate, base: 0, tax: 0 };
            taxMap[key].base += parseFloat(amount);
            taxMap[key].tax  += parseFloat(amount) * parseFloat(taxRate) / 100;

            linesXml += `
    <cac:InvoiceLine>
        <cbc:ID>${lineIndex}</cbc:ID>
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

        // Expense-based lines (qty=1, price=amount)
        const expLineCount = bill.getLineCount({ sublistId: 'expense' });
        for (let i = 0; i < expLineCount; i++) {
            lineIndex++;
            const amount  = num(bill.getSublistValue({ sublistId: 'expense', fieldId: 'amount',  line: i }));
            const desc    = bill.getSublistValue({     sublistId: 'expense', fieldId: 'memo',    line: i })
                         || bill.getSublistText({      sublistId: 'expense', fieldId: 'account', line: i })
                         || `NOT_DESC_EXP${lineIndex}`;
            const catId   = bill.getSublistValue({ sublistId: 'expense', fieldId: 'category', line: i }) || `NOT_CAT_EXP${lineIndex}`;
            // TBC: confirm tax rate field on expense lines (taxrate1 vs taxrate)
            const taxRate = num(bill.getSublistValue({ sublistId: 'expense', fieldId: 'taxrate1', line: i }), 1);
            const taxCode = 'S';   // TBC: derive from NetSuite tax code mapping (S/Z/E/AE)

            lineExtTotal += parseFloat(amount);
            const key = `${taxCode}_${taxRate}`;
            if (!taxMap[key]) taxMap[key] = { code: taxCode, rate: taxRate, base: 0, tax: 0 };
            taxMap[key].base += parseFloat(amount);
            taxMap[key].tax  += parseFloat(amount) * parseFloat(taxRate) / 100;

            linesXml += `
    <cac:InvoiceLine>
        <cbc:ID>${lineIndex}</cbc:ID>
        <cbc:InvoicedQuantity unitCode="EA">1</cbc:InvoicedQuantity>
        <cbc:LineExtensionAmount currencyID="${currency}">${amount}</cbc:LineExtensionAmount>
        <cac:OrderLineReference><cbc:LineID>${lineIndex}</cbc:LineID></cac:OrderLineReference>
        <cac:Item>
            <cbc:Name>${esc(desc)}</cbc:Name>
            <cac:SellersItemIdentification><cbc:ID>${esc(String(catId))}</cbc:ID></cac:SellersItemIdentification>
            <cac:ClassifiedTaxCategory>
                <cbc:ID>${taxCode}</cbc:ID>
                <cbc:Percent>${parseFloat(taxRate).toFixed(1)}</cbc:Percent>
                <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
            </cac:ClassifiedTaxCategory>
        </cac:Item>
        <cac:Price>
            <cbc:PriceAmount currencyID="${currency}">${amount}</cbc:PriceAmount>
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
        const subtotal  = num(bill.getValue('subtotal'));
        const total     = num(bill.getValue('total'));
        const amountDue = num(bill.getValue('amountdue'));

        // ── Optional XML blocks ──────────────────────────────────────────────
        const periodBlock = (periodStart && periodEnd) ? `
    <cac:InvoicePeriod>
        <cbc:StartDate>${periodStart}</cbc:StartDate>
        <cbc:EndDate>${periodEnd}</cbc:EndDate>
        <cbc:DescriptionCode>3</cbc:DescriptionCode>
    </cac:InvoicePeriod>` : '';

        const orderRefBlock = (otherRefNum || createdFrom) ? `
    <cac:OrderReference>
        ${otherRefNum  ? `<cbc:ID>${esc(otherRefNum)}</cbc:ID>` : ''}
        ${createdFrom  ? `<cbc:SalesOrderID>${esc(createdFrom)}</cbc:SalesOrderID>` : ''}
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
    ${createdFrom ? `<cbc:BuyerReference>${esc(createdFrom)}</cbc:BuyerReference>` : ''}${periodBlock}${orderRefBlock}${receiptBlock}${originatorBlock}${contractBlock}${projectBlock}
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
                ${selLegalForm ? `<cbc:CompanyLegalForm>${esc(selLegalForm)}</cbc:CompanyLegalForm>` : ''}
            </cac:PartyLegalEntity>
            <cac:Contact>
                <cbc:Name>${esc(selName)}</cbc:Name>
                <cbc:Telephone>${esc(selPhone)}</cbc:Telephone>
                <cbc:ElectronicMail>${esc(selEmail)}</cbc:ElectronicMail>
            </cac:Contact>
        </cac:Party>
    </cac:AccountingSupplierParty>
    <cac:AccountingCustomerParty>
        <cac:Party>
            <cbc:EndpointID schemeID="0225">${esc(buyerSiren)}</cbc:EndpointID>
            <cac:PartyIdentification>
                <cbc:ID schemeID="0009">${esc(buyerSiret)}</cbc:ID>
            </cac:PartyIdentification>
            <cac:PartyName><cbc:Name>${esc(buyerName)}</cbc:Name></cac:PartyName>
            <cac:PostalAddress>
                <cbc:StreetName>${esc(buyerAddr1)}</cbc:StreetName>
                ${buyerAddr2 ? `<cbc:AdditionalStreetName>${esc(buyerAddr2)}</cbc:AdditionalStreetName>` : ''}
                <cbc:CityName>${esc(buyerCity)}</cbc:CityName>
                <cbc:PostalZone>${buyerZip}</cbc:PostalZone>
                <cac:Country><cbc:IdentificationCode>${buyerCountry}</cbc:IdentificationCode></cac:Country>
            </cac:PostalAddress>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>${esc(buyerVat)}</cbc:CompanyID>
                <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>${esc(buyerName)}</cbc:RegistrationName>
                <cbc:CompanyID schemeID="0002">${esc(buyerSiren)}</cbc:CompanyID>
                ${buyerLegalForm ? `<cbc:CompanyLegalForm>${esc(buyerLegalForm)}</cbc:CompanyLegalForm>` : ''}
            </cac:PartyLegalEntity>
            <cac:Contact>
                <cbc:Name>${esc(buyerName)}</cbc:Name>
                <cbc:Telephone>${esc(buyerPhone)}</cbc:Telephone>
                <cbc:ElectronicMail>${esc(buyerEmail)}</cbc:ElectronicMail>
            </cac:Contact>
        </cac:Party>
    </cac:AccountingCustomerParty>
    <cac:PaymentMeans>
        <cbc:PaymentMeansCode>${esc(payMeansCode)}</cbc:PaymentMeansCode>
        <cac:PayeeFinancialAccount>
            <cbc:ID>${esc(selIBAN)}</cbc:ID>
            <cbc:Name>${esc(selBankName)}</cbc:Name>
            <cac:FinancialInstitutionBranch><cbc:ID>${esc(selBIC)}</cbc:ID></cac:FinancialInstitutionBranch>
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
</Invoice>`;
    }

    return { afterSubmit };
});
