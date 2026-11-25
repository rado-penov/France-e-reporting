/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Version history (date = commit date):
 *   v1.0.0  (2026-07-03) - Initial release: UBL 2.1 / EN 16931 XML on invoice save, filed in the
 *                          File Cabinet and sent via HTTPS API.
 *   v1.0.1  (2026-07-12) - OAuth2 bearer token auth.
 *   v1.0.2  (2026-08-25) - Correct tax amounts, FR eligibility check.
 *   v1.0.3  (2026-09-24) - Hardened export eligibility and seller address lookups.
 *   v1.1.0  (2026-11-18) - Invoice PDF rendered with the form's Advanced PDF/HTML template, saved
 *                          to folder 1751997 as Invoice_<tranid>_<ddMMyy>.pdf (Paris date) and
 *                          attached to the invoice. When the XML was accepted, JSON
 *                          [{ uuid, pdfInternalId }] is POSTed to the same API URL with the new
 *                          custscript_pret_pdf_api_doc_type header value. PDF failures are
 *                          isolated from the UBL outcome. EDIT is now a permanent trigger (the
 *                          testing-only note is removed); entry audit log added.
 *   v1.1.1  (2026-11-20) - BR-FR-CO-10 (BT-71-1): DeliveryLocation/cbc:ID (shipaddressee) now
 *                          always carries a schemeID — 0009 for a valid 14-digit SIRET, otherwise
 *                          0088 as advised by Basware; omitted when shipaddressee is empty.
 *                          Customer PartyLegalEntity gains RegistrationName and CompanyLegalForm
 *                          (custentity_pret_company_legal_name / _legal_form). HTML tags are
 *                          stripped from the seller CompanyLegalForm and the #PMT# note. Ship-to address read from the shippingaddress
 *                          subrecord; empty CityName/PostalZone/StreetName elements are omitted.
 *   v1.1.2  (2026-11-23) - Restore the standard OASIS UBL 2.1 namespaces (default Invoice-2, cac,
 *                          cbc) on the root element; the placeholder pret.com URIs made schema
 *                          validators reject the document ("No matching global declaration").
 *
 * Generates a UBL 2.1 / EN 16931 XML for French e-invoicing on invoice save,
 * saves it to the File Cabinet, sends it via HTTPS API and stamps the three
 * export flags on the invoice. Finally renders the invoice PDF with the existing
 * Advanced PDF/HTML template on the invoice's form (French wording is driven by the
 * FR subsidiary), saves it to folder 1751997 as Invoice_{tranid}_{ddMMyy}.pdf and
 * attaches it to the invoice (Communication > Files). If the XML was accepted, a JSON
 * [{ uuid, pdfInternalId }] is then POSTed to the same API URL.
 *
 * Script Parameters (defined on the Script record in NetSuite):
 *   custscript_pret_api_url              Free-form text            — API endpoint URL
 *   custscript_pret_oauth_token_url      Free-form text            — OAuth2 token endpoint URL (client_credentials grant)
 *   custscript_pret_oauth_client_id      Free-form text            — OAuth2 client_id
 *   custscript_pret_oauth_client_secret  Free-form Text (Password) — OAuth2 client_secret
 *   custscript_pret_oauth_scope          Free-form text            — OAuth2 scope
 *   custscript_pret_api_doc_type         Free-form text            — Value sent as the X-Pret-Document-Type header
 *   custscript_pret_pdf_api_doc_type     Free-form text            — X-Pret-Document-Type header for the PDF JSON call
 *   custscript_pret_ubl_folder           Integer                   — File Cabinet folder ID for XML files
 */
define(['N/record', 'N/file', 'N/https', 'N/runtime', 'N/log', 'N/render', 'N/format'],
(record, file, https, runtime, log, render, format) => {

    const PDF_FOLDER_ID = 1751997;

    // ── afterSubmit ──────────────────────────────────────────────────────────
    function afterSubmit(context) {
        log.audit('UBL ENTRY', `Type: ${context.type} | Invoice ID: ${context.newRecord.id} | Context: ${runtime.executionContext}`);
        const { CREATE, COPY, EDIT } = context.UserEventType;
        if (context.type !== CREATE && context.type !== COPY && context.type !== EDIT) return;

        try {
            const script      = runtime.getCurrentScript();
            const apiUrl       = script.getParameter({ name: 'custscript_pret_api_url' });
            const tokenUrl     = script.getParameter({ name: 'custscript_pret_oauth_token_url' });
            const clientId     = script.getParameter({ name: 'custscript_pret_oauth_client_id' });
            const clientSecret = script.getParameter({ name: 'custscript_pret_oauth_client_secret' });
            const scope        = script.getParameter({ name: 'custscript_pret_oauth_scope' });
            const apiDocType   = script.getParameter({ name: 'custscript_pret_api_doc_type' });
            const pdfDocType   = script.getParameter({ name: 'custscript_pret_pdf_api_doc_type' });
            const folderId    = parseInt(script.getParameter({ name: 'custscript_pret_ubl_folder' }), 10);

            if (!folderId || isNaN(folderId)) throw new Error('custscript_pret_ubl_folder parameter is not set on the deployment');

            const inv = record.load({ type: record.Type.INVOICE, id: context.newRecord.id });

            // Only process French invoices (FR subsidiary ID=16 or billing country = FR)
            const isFrSubsidiary  = String(inv.getValue('subsidiary')) === '16';

            // The flattened 'billcountry' body field isn't reliably populated when the account
            // uses the Address subrecord model (confirmed 2026-08-27: getValue('billcountry')
            // returned undefined for an invoice whose billingaddress subrecord/native export both
            // show FR) — fall back to the billingaddress subrecord's own country field.
            let billCountry = inv.getValue('billcountry');
            if (!billCountry) {
                try {
                    const billAddr = inv.getSubrecord({ fieldId: 'billingaddress' });
                    billCountry = billAddr ? billAddr.getValue({ fieldId: 'country' }) : billCountry;
                } catch (e) {
                    log.audit('UBL BILLING ADDRESS SUBRECORD READ FAILED', `Invoice: ${inv.getValue('tranid')} | ${e.message}`);
                }
            }
            const isFrBillCountry = billCountry === 'FR';

            if (!isFrSubsidiary || !isFrBillCountry) {
                log.error('UBL ELIGIBILITY CHECK FAILED', `Invoice: ${inv.getValue('tranid')} | subsidiary: "${inv.getValue('subsidiary')}" (isFrSubsidiary: ${isFrSubsidiary}) | billcountry: "${billCountry}" (isFrBillCountry: ${isFrBillCountry})`);
                return;
            }

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
            const oauthConfigured = !!(tokenUrl && clientId && clientSecret && scope);
            log.audit('UBL API PARAMS', `Invoice: ${tranId} | url: ${apiUrl || '(empty)'} | oauth configured: ${oauthConfigured} | docType: ${apiDocType || '(empty)'}`);

            let sentToBW    = false;
            let bearerToken = null;   // reused by the PDF JSON call below
            if (apiUrl && oauthConfigured && apiDocType) {
                try {
                    bearerToken = getBearerToken(tokenUrl, clientId, clientSecret, scope);
                    log.audit('UBL API CALLING', `Invoice: ${tranId} | POST ${apiUrl}`);
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
                        log.audit('UBL API SENT', `Invoice: ${tranId} | Status: ${response.code}`);
                    } else {
                        log.error('UBL API FAILED', `Invoice: ${tranId} | Status: ${response.code} | Body: ${response.body}`);
                    }
                } catch (apiErr) {
                    log.error('UBL API FAILED', `Invoice: ${tranId} | Name: ${apiErr.name} | Message: ${apiErr.message} | Stack: ${apiErr.stack}`);
                }
            } else {
                log.error('UBL API SKIPPED', `Invoice: ${tranId} | Missing parameters — url: ${!!apiUrl} | oauth configured: ${oauthConfigured} | docType: ${!!apiDocType}`);
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

            // French PDF — isolated so a template/render failure never masks the UBL outcome above
            try {
                const pdfFileId = savePdf(inv, tranId);
                log.audit('PDF FILE SAVED', `Invoice: ${tranId} | File ID: ${pdfFileId}`);

                // Show the PDF under the invoice's Communication > Files subtab
                record.attach({
                    record: { type: 'file', id: pdfFileId },
                    to:     { type: record.Type.INVOICE, id: inv.id }
                });
                log.audit('PDF ATTACHED', `Invoice: ${tranId} | File ID: ${pdfFileId}`);

                // Tell Basware which PDF belongs to the XML it just accepted (linked by UUID)
                if (!sentToBW) {
                    log.audit('PDF JSON SKIPPED', `Invoice: ${tranId} | XML was not accepted by the API`);
                } else if (!pdfDocType) {
                    log.error('PDF JSON SKIPPED', `Invoice: ${tranId} | custscript_pret_pdf_api_doc_type is not set on the deployment`);
                } else {
                    sendPdfJson(apiUrl, bearerToken, pdfDocType, uuid, pdfFileId, tranId);
                }
            } catch (pdfErr) {
                log.error('PDF FAILED', `Invoice: ${tranId} | ${pdfErr.message}\n${pdfErr.stack}`);
            }

        } catch (e) {
            log.error('UBL FAILED', `Invoice: ${context.newRecord.id} | ${e.message}\n${e.stack}`);
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

    // ── French PDF ───────────────────────────────────────────────────────────
    // Prints the invoice exactly as the UI Print button does — same form, same Advanced PDF/HTML
    // template (which already switches to French wording for the FR subsidiary).
    function savePdf(inv, tranId) {
        const pdf  = render.transaction({ entityId: Number(inv.id), printMode: render.PrintMode.PDF });
        pdf.name   = `Invoice_${tranId}_${parisDateDDMMYY()}.pdf`;
        pdf.folder = PDF_FOLDER_ID;
        return pdf.save();
    }

    function sendPdfJson(apiUrl, bearerToken, docType, uuid, pdfFileId, tranId) {
        const body = JSON.stringify([{ uuid: uuid, pdfInternalId: Number(pdfFileId) }]);
        log.audit('PDF JSON CALLING', `Invoice: ${tranId} | POST ${apiUrl} | Body: ${body}`);
        const response = https.post({
            url:  apiUrl,
            body: body,
            headers: {
                'Content-Type':         'application/json',
                'Authorization':        `Bearer ${bearerToken}`,
                'X-Pret-Document-Type': docType
            }
        });
        if (response.code >= 200 && response.code < 300) {
            log.audit('PDF JSON SENT', `Invoice: ${tranId} | Status: ${response.code}`);
        } else {
            log.error('PDF JSON FAILED', `Invoice: ${tranId} | Status: ${response.code} | Body: ${response.body}`);
        }
    }

    // Today as ddMMyy in Paris time — the server clock is US Pacific, which would stamp
    // French evening invoices with the previous day. Formatting with a timezone and parsing
    // back without one yields a Date whose local fields are the Paris wall-clock time.
    function parisDateDDMMYY() {
        let d = new Date();
        try {
            d = format.parse({
                value: format.format({ value: d, type: format.Type.DATETIME, timezone: format.Timezone.EUROPE_PARIS }),
                type:  format.Type.DATETIME
            });
        } catch (e) {
            log.audit('PDF DATE TZ CONVERSION FAILED', e.message);
        }
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getDate())}${pad(d.getMonth() + 1)}${String(d.getFullYear()).slice(-2)}`;
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    // HTML → plain text: <br>/<p> become spaces, other tags are dropped, common entities
    // decoded, whitespace collapsed. esc() is applied afterwards when writing the XML.
    function stripHtml(v) {
        return String(v ?? '')
            .replace(/<\s*(br|\/p|\/div|\/li)\b[^>]*>/gi, ' ')
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
            .replace(/&euro;/gi, '€')
            .replace(/&amp;/gi, '&')
            .replace(/\s+/g, ' ')
            .trim();
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

    // BT-71 / BT-71-1: returns { id, scheme } only for a well-formed identifier, else null.
    //   14 digits passing the Luhn check → SIRET, scheme 0009
    //   13 digits passing the GS1 mod-10 check → GLN, scheme 0088
    function deliveryLocationId(raw) {
        const v = String(raw || '').replace(/[\s.-]/g, '');
        if (/^\d{14}$/.test(v) && luhnValid(v)) return { id: v, scheme: '0009' };
        if (/^\d{13}$/.test(v) && gs1Valid(v))  return { id: v, scheme: '0088' };
        return null;
    }

    function luhnValid(d) {
        let sum = 0;
        for (let i = 0; i < d.length; i++) {
            let n = Number(d[d.length - 1 - i]);
            if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
            sum += n;
        }
        return sum % 10 === 0;
    }

    function gs1Valid(d) {
        let sum = 0;
        for (let i = 0; i < d.length - 1; i++) {
            sum += Number(d[d.length - 2 - i]) * (i % 2 === 0 ? 3 : 1);
        }
        return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]);
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
        // getSubrecord throws "Field mainaddress is not a subrecord field" when the subsidiary's
        // main address isn't populated — fall back to the NOT_SELLER_* placeholders in that case,
        // same defensive pattern as the customer billing address lookup above.
        let mainAddr = null;
        try {
            mainAddr = sub.getSubrecord({ fieldId: 'mainaddress' });
        } catch (e) {
            log.audit('UBL SELLER ADDRESS SUBRECORD READ FAILED', `Invoice: ${inv.getValue('tranid')} | Subsidiary: ${sub.id} | ${e.message}`);
        }
        const selAddr1     = (mainAddr && mainAddr.getValue('addr1'))   || 'NOT_SELLER_ADDR1';
        const selAddr2     = (mainAddr && mainAddr.getValue('addr2'))   || '';
        const selCity      = (mainAddr && mainAddr.getValue('city'))    || 'NOT_SELLER_CITY';
        const selZip       = (mainAddr && mainAddr.getValue('zip'))     || 'NOT_SELLER_ZIP';
        const selCountry   = (mainAddr && mainAddr.getValue('country')) || sub.getValue('country') || 'NOT_SELLER_COUNTRY';
        const selVat       = sub.getValue('federalidnumber')                          || 'NOT_SELLER_VAT';
        // Footer text is stored as HTML for the PDF template — Basware needs plain text
        const selLegalForm = stripHtml(sub.getValue('custrecord_pret_sub_invoice_footer_text')) || 'NOT_SELLER_LEGAL_FORM';
        const selContact   = sub.getValue('legalname')                                || 'NOT_SELLER_CONTACT';
        const selPhone     = sub.getValue('custrecord_pret_phone_number')             || 'NOT_SELLER_PHONE';
        const selEmail     = sub.getValue('custrecord_pay_remittance_contact')        || 'NOT_SELLER_EMAIL';
        const selIBAN      = sub.getValue('custrecord_pret_bank_account_iban')        || 'NOT_SELLER_IBAN';
        const selBankName  = sub.getValue('custrecord_pret_bank_name')                || 'NOT_SELLER_BANK_NAME';
        const selBIC       = sub.getValue('custrecord_pret_sort_code_bic')            || 'NOT_SELLER_BIC';
        const pmtInfoNote  = stripHtml(sub.getValue('custrecord_pret_payment_info'))  || '';

        // ── Customer ─────────────────────────────────────────────────────────
        const custSiren    = cust.getValue('custentity_pret_siren')                   || 'NOT_CUST_SIREN';
        const custSiret    = cust.getValue('custentity_pret_siret')                   || 'NOT_CUST_SIRET';
        const custName     = cust.getValue('companyname')                             || 'NOT_CUST_NAME';
        const custLegalName = stripHtml(cust.getValue('custentity_pret_company_legal_name')) || 'NOT_CUST_LEGAL_NAME';
        const custLegalForm = stripHtml(cust.getValue('custentity_pret_company_legal_form')) || 'NOT_CUST_LEGAL_FORM';
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
        let delAddressee = inv.getValue('shipaddressee')  || '';
        let delAddr1     = inv.getValue('shipaddr1')      || '';
        let delAddr2     = inv.getValue('shipaddr2')      || '';
        let delCity      = inv.getValue('shipcity')       || '';
        let delZip       = inv.getValue('shipzip')        || '';
        let delCountry   = inv.getValue('shipcountry')    || '';
        let delParty     = inv.getValue('shipattention')  || '';

        // Flattened ship* body fields are empty when shipoverride=F — read the shippingaddress
        // subrecord (same pattern as the billing-country lookup in afterSubmit)
        if (!delAddr1 || !delCity || !delZip || !delCountry) {
            try {
                const shipAddr = inv.getSubrecord({ fieldId: 'shippingaddress' });
                if (shipAddr) {
                    delAddressee = delAddressee || shipAddr.getValue({ fieldId: 'addressee' }) || '';
                    delAddr1     = delAddr1     || shipAddr.getValue({ fieldId: 'addr1' })     || '';
                    delAddr2     = delAddr2     || shipAddr.getValue({ fieldId: 'addr2' })     || '';
                    delCity      = delCity      || shipAddr.getValue({ fieldId: 'city' })      || '';
                    delZip       = delZip       || shipAddr.getValue({ fieldId: 'zip' })       || '';
                    delCountry   = delCountry   || shipAddr.getValue({ fieldId: 'country' })   || '';
                    delParty     = delParty     || shipAddr.getValue({ fieldId: 'attention' }) || '';
                }
            } catch (e) {
                log.audit('UBL SHIPPING ADDRESS SUBRECORD READ FAILED', `Invoice: ${inv.getValue('tranid')} | ${e.message}`);
            }
        }

        // Last resort: parse the formatted shipaddress text (attention, addressee, addr1, [addr2,]
        // zip+city, country). Only street/city/zip are taken from it — never the location ID.
        if (!delAddr1) {
            const rawAddr = (inv.getValue('shipaddress') || '').replace(/<br\s*\/?>/gi, '\n');
            const lines   = rawAddr.split('\n').map(l => l.trim()).filter(l => l);
            let zipIdx = -1;
            for (let j = lines.length - 1; j >= 0; j--) {
                const m = lines[j].match(/^(\d{5})\s+(.+)$/) || lines[j].match(/^(.+?)\s+(\d{5})$/);
                if (m) {
                    zipIdx  = j;
                    delZip  = delZip  || (/^\d{5}$/.test(m[1]) ? m[1] : m[2]);
                    delCity = delCity || (/^\d{5}$/.test(m[1]) ? m[2] : m[1]);
                    break;
                }
            }
            if (zipIdx > 0) {
                delAddr1 = lines[zipIdx - 1];
                if (zipIdx >= 2 && lines[zipIdx - 2] !== delAddressee && lines[zipIdx - 2] !== delParty) {
                    delAddr2 = delAddr1;
                    delAddr1 = lines[zipIdx - 2];
                }
            }
        }

        // BT-71 Deliver-to location identifier: only emitted for a real identifier, always with
        // its scheme (BR-FR-CO-10). A valid 14-digit SIRET → 0009; any other shipaddressee
        // value is sent with schemeID 0088, as advised by Basware.
        const delAddresseeTrim = String(delAddressee || '').trim();
        const delLoc = deliveryLocationId(delAddresseeTrim)
                    || (delAddresseeTrim ? { id: delAddresseeTrim, scheme: '0088' } : null);

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
            const taxCode = parseFloat(taxRate) > 0 ? 'S' : 'Z';   // TBC: E/AE (exempt/reverse charge) not yet derived
            const uom     = 'EA';  // TBC: derive from NetSuite UOM mapping

            const lineTax = parseFloat(inv.getSublistValue({ sublistId: 'item', fieldId: 'tax1amt', line: i }) || 0);
            lineExtTotal += parseFloat(amount);

            const key = `${taxCode}_${taxRate}`;
            if (!taxMap[key]) taxMap[key] = { code: taxCode, rate: taxRate, base: 0, tax: 0 };
            taxMap[key].base += parseFloat(amount);
            taxMap[key].tax  += lineTax;

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
        const subtotal        = num(inv.getValue('subtotal'));
        const total           = num(inv.getValue('total'));
        const amountRemaining = num(inv.getValue('amountremaining'));

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

        // Address group (BG-15) requires a country code (BT-80) — omit the whole group without one
        const delAddressXml = delCountry ? `
            <cac:Address>
                ${delAddr1 ? `<cbc:StreetName>${esc(delAddr1)}</cbc:StreetName>` : ''}
                ${delAddr2 ? `<cbc:AdditionalStreetName>${esc(delAddr2)}</cbc:AdditionalStreetName>` : ''}
                ${delCity  ? `<cbc:CityName>${esc(delCity)}</cbc:CityName>` : ''}
                ${delZip   ? `<cbc:PostalZone>${esc(delZip)}</cbc:PostalZone>` : ''}
                <cac:Country><cbc:IdentificationCode>${esc(delCountry)}</cbc:IdentificationCode></cac:Country>
            </cac:Address>` : '';

        const delLocationXml = (delLoc || delAddressXml) ? `
        <cac:DeliveryLocation>
            ${delLoc ? `<cbc:ID schemeID="${delLoc.scheme}">${esc(delLoc.id)}</cbc:ID>` : ''}${delAddressXml}
        </cac:DeliveryLocation>` : '';

        const deliveryBlock = (deliveryDate || delLocationXml) ? `
    <cac:Delivery>
        ${deliveryDate ? `<cbc:ActualDeliveryDate>${deliveryDate}</cbc:ActualDeliveryDate>` : ''}${delLocationXml}
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
        return `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
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
    <cbc:Note>#PMD#TBC</cbc:Note>
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
                <cbc:RegistrationName>${esc(custLegalName)}</cbc:RegistrationName>
                <cbc:CompanyID schemeID="0002">${esc(custSiren)}</cbc:CompanyID>
                <cbc:CompanyLegalForm>${esc(custLegalForm)}</cbc:CompanyLegalForm>
            </cac:PartyLegalEntity>
            <cac:Contact>
                <cbc:Name>${esc(custName)}</cbc:Name>
                <cbc:Telephone>${esc(custPhone)}</cbc:Telephone>
                <cbc:ElectronicMail>${esc(custEmail)}</cbc:ElectronicMail>
            </cac:Contact>
        </cac:Party>
    </cac:AccountingCustomerParty>${deliveryBlock}
    <cac:PaymentMeans>
        <cbc:PaymentMeansCode>ZZZ</cbc:PaymentMeansCode>
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
        <cbc:PayableAmount currencyID="${currency}">${amountRemaining}</cbc:PayableAmount>
    </cac:LegalMonetaryTotal>${linesXml}
</Invoice>`;
    }

    return { afterSubmit };
});
