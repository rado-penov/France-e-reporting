/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 *
 * Builds a B2B Payments Report XML from saved search 'customsearch_pret_france_payments_b2b',
 * saves it to the File Cabinet and sends it via HTTPS API.
 *
 * Intended deployment schedule: runs on the 1st, 11th and 21st of every month. Since NetSuite's
 * scheduled-script recurrence UI cannot express "1st/11th/21st" directly, deploy this with a
 * Daily recurrence and let the script itself skip any day that isn't 1, 11 or 21 (see resolveWindow).
 *
 * Reporting window (based on "today"):
 *   today = 11  → trandate between the 1st  and the 10th of the current month (inclusive)
 *   today = 21  → trandate between the 11th and the 20th of the current month (inclusive)
 *   today = 1   → trandate between the 21st of the previous month and today, EXCLUDING today
 *                 (i.e. up to and including the last day of the previous month)
 *   any other day → script exits without generating a report
 *
 * The saved search itself has no date filter — the trandate window filter added at runtime here
 * is the sole date restriction applied to the results.
 *
 * Saved search columns expected (matched by custom label, not internal field ID):
 *   StartDate     — Accounting Period : Start Date (grouped)  → ReportPeriod/StartDate
 *   EndDate       — Accounting Period : End Date   (grouped)  → ReportPeriod/EndDate
 *   InvoiceID     — Invoice Document Number (grouped)         → PaymentsReport/Invoice/InvoiceID
 *   IssueDate     — Invoice Date (grouped)                    → PaymentsReport/Invoice/IssueDate
 *   PaymentDate   — Date (grouped)                            → PaymentsReport/Invoice/Payment/Date
 *   TaxItem       — Tax Item (grouped, not used in the output XML)
 *   TaxRate       — Tax Item : Rate (grouped)                 → SubTotals/TaxPercent
 *   CurrencyCode  — Currency (grouped)                        → SubTotals/CurrencyCode
 *   Amount        — Amount (summed)                           → SubTotals/Amount
 *
 * Each search result row maps 1:1 to one <Invoice> element (with a single nested <Payment>).
 *
 * Sender and Issuer blocks use fixed values: Sender is the Basware PDP, Issuer is Pret (France) SAS.
 *
 * Script Parameters (defined on the Script record in NetSuite):
 *   custscript_pret_api_url_b2b              Free-form text            — API endpoint URL
 *   custscript_pret_oauth_token_url_b2b      Free-form text            — OAuth2 token endpoint URL (client_credentials grant)
 *   custscript_pret_oauth_client_id_b2b      Free-form text            — OAuth2 client_id
 *   custscript_pret_oauth_client_secret_b2b  Free-form Text (Password) — OAuth2 client_secret
 *   custscript_pret_oauth_scope_b2b          Free-form text            — OAuth2 scope
 *   custscript_pret_api_doc_type_b2b         Free-form text            — Value sent as the X-Pret-Document-Type header
 *   custscript_pret_ubl_folder_b2b           Integer                   — File Cabinet folder ID for XML files
 *   custscript_pret_today_b2b             Free-form text — TEST ONLY. When set, the script behaves
 *                                         as if "today" were this date (enter in your NetSuite
 *                                         date format), so you can simulate the 1st/11th/21st runs.
 *                                         Leave blank in production.
 */
define(['N/search', 'N/file', 'N/https', 'N/runtime', 'N/format', 'N/log'],
(search, file, https, runtime, format, log) => {

    const SEARCH_ID = 'customsearch_pret_france_payments_b2b';

    // ── execute ──────────────────────────────────────────────────────────────
    function execute(context) {
        try {
            const script      = runtime.getCurrentScript();
            const apiUrl       = script.getParameter({ name: 'custscript_pret_api_url_b2b' });
            const tokenUrl     = script.getParameter({ name: 'custscript_pret_oauth_token_url_b2b' });
            const clientId     = script.getParameter({ name: 'custscript_pret_oauth_client_id_b2b' });
            const clientSecret = script.getParameter({ name: 'custscript_pret_oauth_client_secret_b2b' });
            const scope        = script.getParameter({ name: 'custscript_pret_oauth_scope_b2b' });
            const apiDocType   = script.getParameter({ name: 'custscript_pret_api_doc_type_b2b' });
            const folderId    = parseInt(script.getParameter({ name: 'custscript_pret_ubl_folder_b2b' }), 10);
            const todayParam  = script.getParameter({ name: 'custscript_pret_today_b2b' });

            if (!folderId || isNaN(folderId)) throw new Error('custscript_pret_ubl_folder_b2b parameter is not set on the deployment');

            const oauthConfigured = !!(tokenUrl && clientId && clientSecret && scope);
            log.audit('B2B PAYMENTS REPORT START', `Deployment: ${script.deploymentId} | url set: ${!!apiUrl} | oauth configured: ${oauthConfigured} | docType: ${apiDocType || '(empty)'} | folderId: ${folderId} | todayParam: ${todayParam || '(not set)'}`);

            const today = resolveToday(todayParam);
            log.debug('B2B PAYMENTS REPORT TODAY RESOLVED', `Today: ${fmtYYYYMMDD(today)} (day of month: ${today.getDate()})`);

            const window = resolveWindow(today);
            if (!window) {
                log.audit('B2B PAYMENTS REPORT SKIPPED', `Today (${fmtYYYYMMDD(today)}) is not the 1st, 11th or 21st — nothing to run`);
                return;
            }
            log.audit('B2B PAYMENTS REPORT WINDOW', `Today: ${fmtYYYYMMDD(today)} | Window: ${fmtYYYYMMDD(window.start)} - ${fmtYYYYMMDD(window.end)}`);

            log.audit('B2B PAYMENTS REPORT SEARCH START', `Search: ${SEARCH_ID} | Filter trandate within: ${toFilterDate(window.start)} - ${toFilterDate(window.end)}`);
            const payments = runSearch(window);
            log.audit('B2B PAYMENTS REPORT SEARCH RESULTS', `Rows returned: ${payments.length}`);
            if (payments.length === 0) {
                log.audit('B2B PAYMENTS REPORT SKIPPED', `No results for window ${fmtYYYYMMDD(window.start)} - ${fmtYYYYMMDD(window.end)}`);
                return;
            }
            payments.forEach((p, i) => log.debug('B2B PAYMENTS REPORT ROW', `#${i + 1} | Invoice: ${p.invoiceId} | IssueDate: ${p.issueDate} | Date: ${p.date} | TaxPercent: ${p.taxPercent} | Currency: ${p.currencyCode} | Amount: ${p.amount}`));

            const rptId = `RPT-${today.getFullYear()}-${pad2(today.getDate())}${pad2(today.getMonth() + 1)}`;
            log.audit('B2B PAYMENTS REPORT ID', `RPT ID: ${rptId}`);

            const xml = buildReportXml(rptId, payments);
            log.debug('B2B PAYMENTS REPORT XML BUILT', `Length: ${xml.length} chars`);

            const fileName = `${fmtYYYYMMDD(today)}_B2BPaymentsReport_${rptId}.xml`;
            log.audit('B2B PAYMENTS REPORT FILE SAVING', `File: ${fileName} | Folder: ${folderId}`);
            const xmlFile = file.create({
                name:     fileName,
                fileType: file.Type.XMLDOC,
                contents: xml,
                folder:   folderId
            });
            const fileId = xmlFile.save();
            log.audit('B2B PAYMENTS REPORT FILE SAVED', `File: ${fileName} | File ID: ${fileId}`);

            if (apiUrl && oauthConfigured && apiDocType) {
                try {
                    const bearerToken = getBearerToken(tokenUrl, clientId, clientSecret, scope);
                    log.audit('B2B PAYMENTS REPORT API CALLING', `POST ${apiUrl}`);
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
                        log.audit('B2B PAYMENTS REPORT API SENT', `Status: ${response.code}`);
                    } else {
                        log.error('B2B PAYMENTS REPORT API FAILED', `Status: ${response.code} | Body: ${response.body}`);
                    }
                } catch (apiErr) {
                    log.error('B2B PAYMENTS REPORT API FAILED', `Name: ${apiErr.name} | Message: ${apiErr.message} | Stack: ${apiErr.stack}`);
                }
            } else {
                log.error('B2B PAYMENTS REPORT API SKIPPED', `Missing parameters — url: ${!!apiUrl} | oauth configured: ${oauthConfigured} | docType: ${!!apiDocType}`);
            }

            log.audit('B2B PAYMENTS REPORT COMPLETE', `RPT ID: ${rptId} | File ID: ${fileId} | Invoices: ${payments.length}`);

        } catch (e) {
            log.error('B2B PAYMENTS REPORT FAILED', `${e.message}\n${e.stack}`);
        }
    }

    // ── date / window helpers ────────────────────────────────────────────────
    // custscript_pret_today_b2b is a Date-type parameter, so NetSuite hands back a Date object
    // directly. The string-parse branch is a defensive fallback in case it's ever redefined as text.
    function resolveToday(todayParam) {
        if (todayParam instanceof Date) return todayParam;
        if (todayParam) {
            try {
                return format.parse({ value: todayParam, type: format.Type.DATE });
            } catch (e) {
                log.error('B2B PAYMENTS REPORT TODAY PARAM INVALID', `Value: ${todayParam} | ${e.message} — falling back to real today`);
            }
        }
        return new Date();
    }

    // today=11 -> 1st-10th | today=21 -> 11th-20th | today=1 -> prev month 21st..end (excl. today) | else null
    function resolveWindow(today) {
        const y = today.getFullYear();
        const m = today.getMonth();
        const d = today.getDate();
        if (d === 11) return { start: new Date(y, m, 1),      end: new Date(y, m, 10) };
        if (d === 21) return { start: new Date(y, m, 11),     end: new Date(y, m, 20) };
        if (d === 1)  return { start: new Date(y, m - 1, 21), end: new Date(y, m, 0) };
        return null;
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function fmtYYYYMMDD(d) {
        return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
    }

    function toFilterDate(d) {
        return format.format({ value: d, type: format.Type.DATE });
    }

    // Saved-search date columns come back as text in the user's NetSuite date format —
    // parse with N/format (locale-aware) then re-render as YYYYMMDD.
    function searchDateToYYYYMMDD(str) {
        if (!str) return '';
        try {
            return fmtYYYYMMDD(format.parse({ value: str, type: format.Type.DATE }));
        } catch (e) {
            return String(str).replace(/\D/g, '');
        }
    }

    function cleanNumber(v) {
        return parseFloat(String(v || '0').replace(/[^0-9.-]/g, '')) || 0;
    }

    // ── saved search ─────────────────────────────────────────────────────────
    function runSearch(window) {
        const loadedSearch = search.load({ id: SEARCH_ID });
        loadedSearch.filters.push(search.createFilter({
            name:     'trandate',
            operator: search.Operator.WITHIN,
            values:   [toFilterDate(window.start), toFilterDate(window.end)]
        }));

        const labelMap = {};
        loadedSearch.columns.forEach(col => { if (col.label) labelMap[col.label] = col; });
        log.debug('B2B PAYMENTS REPORT SEARCH COLUMNS', `Labels found: ${Object.keys(labelMap).join(', ')}`);

        const required = ['StartDate', 'EndDate', 'InvoiceID', 'IssueDate', 'PaymentDate', 'TaxRate', 'CurrencyCode', 'Amount'];
        for (const label of required) {
            if (!labelMap[label]) throw new Error(`Saved search ${SEARCH_ID} is missing a column labeled "${label}"`);
        }

        const payments = [];
        const pagedData = loadedSearch.runPaged({ pageSize: 1000 });
        log.debug('B2B PAYMENTS REPORT SEARCH PAGED', `Total pages: ${pagedData.pageRanges.length} | Total count reported: ${pagedData.count}`);
        for (let p = 0; p < pagedData.pageRanges.length; p++) {
            const page = pagedData.fetch({ index: p });
            log.debug('B2B PAYMENTS REPORT PAGE FETCHED', `Page: ${p + 1}/${pagedData.pageRanges.length} | Rows: ${page.data.length}`);
            page.data.forEach(row => {
                payments.push({
                    reportStartDate: searchDateToYYYYMMDD(row.getValue(labelMap.StartDate)),
                    reportEndDate:   searchDateToYYYYMMDD(row.getValue(labelMap.EndDate)),
                    invoiceId:       row.getText(labelMap.InvoiceID) || row.getValue(labelMap.InvoiceID),
                    issueDate:       searchDateToYYYYMMDD(row.getValue(labelMap.IssueDate)),
                    date:            searchDateToYYYYMMDD(row.getValue(labelMap.PaymentDate)),
                    taxPercent:      cleanNumber(row.getValue(labelMap.TaxRate)),
                    currencyCode:    row.getText(labelMap.CurrencyCode) || row.getValue(labelMap.CurrencyCode),
                    amount:          cleanNumber(row.getValue(labelMap.Amount)).toFixed(2)
                });
            });
        }
        return payments;
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

    function nowTimestamp() {
        const d = new Date();
        return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    }

    // ── Report XML builder ───────────────────────────────────────────────────
    function buildReportXml(rptId, payments) {
        const first = payments[0];

        let invoicesXml = '';
        payments.forEach(p => {
            invoicesXml += `
        <Invoice>
            <InvoiceID>${esc(p.invoiceId)}</InvoiceID>
            <IssueDate>${p.issueDate}</IssueDate>
            <Payment>
                <Date>${p.date}</Date>
                <SubTotals>
                    <TaxPercent>${p.taxPercent}</TaxPercent>
                    <CurrencyCode>${esc(p.currencyCode)}</CurrencyCode>
                    <Amount>${p.amount}</Amount>
                </SubTotals>
            </Payment>
        </Invoice>`;
        });

        return `<?xml version="1.0" encoding="UTF-8"?>
<Report>
    <ReportDocument>
        <Id>${esc(rptId)}</Id>
        <Name>Quarterly Invoice Payments Report</Name>
        <IssueDateTime>
            <DateTimeString>${nowTimestamp()}</DateTimeString>
        </IssueDateTime>
        <TypeCode>IN</TypeCode>
        <References/>
        <Sender>
            <Id schemeId="0238">0145</Id>
            <Name>Basware Oyj</Name>
            <RoleCode>WK</RoleCode>
            <URIUniversalCommunication>
                <URIID>france.pdp@basware.com</URIID>
            </URIUniversalCommunication>
        </Sender>
        <Issuer>
            <Id schemeId="0002">533214003</Id>
            <Name>Pret (France) SAS</Name>
            <RoleCode>SE</RoleCode>
            <URIUniversalCommunication>
                <URIID>pretfranceaccounts@pret.com</URIID>
            </URIUniversalCommunication>
        </Issuer>
    </ReportDocument>

    <PaymentsReport>
        <ReportPeriod>
            <StartDate>${first.reportStartDate}</StartDate>
            <EndDate>${first.reportEndDate}</EndDate>
        </ReportPeriod>${invoicesXml}
    </PaymentsReport>
</Report>`;
    }

    return { execute };
});
