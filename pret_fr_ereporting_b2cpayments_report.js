/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 *
 * Builds a B2C Payments Report XML from saved search 'customsearch_pret_france_payments_report',
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
 *   PaymentDate   — Date (grouped)                            → Transactions/Payment/Date
 *   TaxItem       — Tax Item (grouped, not used in the output XML)
 *   TaxRate       — Tax Item : Rate (grouped)                 → SubTotals/TaxPercent
 *   CurrencyCode  — Currency (grouped)                        → SubTotals/CurrencyCode
 *   Amount        — Amount (summed)                           → SubTotals/Amount
 *
 * Each search result row maps 1:1 to one <Payment> element.
 *
 * Sender and Issuer blocks are both populated from the France subsidiary (internal ID 16) —
 * same VAT/Name/email in both, RoleCode stays SENDER for Sender and SE for Issuer.
 *
 * Script Parameters (defined on the Script record in NetSuite):
 *   custscript_pret_api_url_pr           Free-form text — API endpoint URL
 *   custscript_pret_api_function_key_pr  Free-form text — Value sent as the X-Function-Key header
 *   custscript_pret_api_doc_type_pr      Free-form text — Value sent as the x-pret-document-type header
 *   custscript_pret_ubl_folder_pr        Integer        — File Cabinet folder ID for XML files
 *   custscript_pret_today_pr             Free-form text — TEST ONLY. When set, the script behaves
 *                                         as if "today" were this date (enter in your NetSuite
 *                                         date format), so you can simulate the 1st/11th/21st runs.
 *                                         Leave blank in production.
 */
define(['N/search', 'N/file', 'N/https', 'N/runtime', 'N/record', 'N/format', 'N/log'],
(search, file, https, runtime, record, format, log) => {

    const FRANCE_SUBSIDIARY_ID = 16;
    const SEARCH_ID = 'customsearch_pret_france_payments_report';

    // ── execute ──────────────────────────────────────────────────────────────
    function execute(context) {
        try {
            const script      = runtime.getCurrentScript();
            const apiUrl      = script.getParameter({ name: 'custscript_pret_api_url_pr' });
            const apiKey      = script.getParameter({ name: 'custscript_pret_api_function_key_pr' });
            const apiDocType  = script.getParameter({ name: 'custscript_pret_api_doc_type_pr' });
            const folderId    = parseInt(script.getParameter({ name: 'custscript_pret_ubl_folder_pr' }), 10);
            const todayParam  = script.getParameter({ name: 'custscript_pret_today_pr' });

            if (!folderId || isNaN(folderId)) throw new Error('custscript_pret_ubl_folder_pr parameter is not set on the deployment');

            log.audit('PAYMENTS REPORT START', `Deployment: ${script.deploymentId} | url set: ${!!apiUrl} | functionKey set: ${!!apiKey} | docType: ${apiDocType || '(empty)'} | folderId: ${folderId} | todayParam: ${todayParam || '(not set)'}`);

            const today = resolveToday(todayParam);
            log.debug('PAYMENTS REPORT TODAY RESOLVED', `Today: ${fmtYYYYMMDD(today)} (day of month: ${today.getDate()})`);

            const window = resolveWindow(today);
            if (!window) {
                log.audit('PAYMENTS REPORT SKIPPED', `Today (${fmtYYYYMMDD(today)}) is not the 1st, 11th or 21st — nothing to run`);
                return;
            }
            log.audit('PAYMENTS REPORT WINDOW', `Today: ${fmtYYYYMMDD(today)} | Window: ${fmtYYYYMMDD(window.start)} - ${fmtYYYYMMDD(window.end)}`);

            log.audit('PAYMENTS REPORT SEARCH START', `Search: ${SEARCH_ID} | Filter trandate within: ${toFilterDate(window.start)} - ${toFilterDate(window.end)}`);
            const payments = runSearch(window);
            log.audit('PAYMENTS REPORT SEARCH RESULTS', `Rows returned: ${payments.length}`);
            if (payments.length === 0) {
                log.audit('PAYMENTS REPORT SKIPPED', `No results for window ${fmtYYYYMMDD(window.start)} - ${fmtYYYYMMDD(window.end)}`);
                return;
            }
            payments.forEach((p, i) => log.debug('PAYMENTS REPORT ROW', `#${i + 1} | Date: ${p.date} | TaxPercent: ${p.taxPercent} | Currency: ${p.currencyCode} | Amount: ${p.amount}`));

            const sub = record.load({ type: 'subsidiary', id: FRANCE_SUBSIDIARY_ID });
            log.audit('PAYMENTS REPORT SUBSIDIARY LOADED', `Subsidiary: ${FRANCE_SUBSIDIARY_ID} | VAT: ${sub.getValue('federalidnumber') || '(empty)'} | Name: ${sub.getValue('legalname') || '(empty)'}`);

            const rptId = `RPT-${today.getFullYear()}-${pad2(today.getDate())}${pad2(today.getMonth() + 1)}`;
            log.audit('PAYMENTS REPORT ID', `RPT ID: ${rptId}`);

            const xml = buildReportXml(rptId, sub, payments);
            log.debug('PAYMENTS REPORT XML BUILT', `Length: ${xml.length} chars`);

            const fileName = `${fmtYYYYMMDD(today)}_PaymentsReport_${rptId}.xml`;
            log.audit('PAYMENTS REPORT FILE SAVING', `File: ${fileName} | Folder: ${folderId}`);
            const xmlFile = file.create({
                name:     fileName,
                fileType: file.Type.XMLDOC,
                contents: xml,
                folder:   folderId
            });
            const fileId = xmlFile.save();
            log.audit('PAYMENTS REPORT FILE SAVED', `File: ${fileName} | File ID: ${fileId}`);

            if (apiUrl && apiKey && apiDocType) {
                try {
                    log.audit('PAYMENTS REPORT API CALLING', `POST ${apiUrl}`);
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
                        log.audit('PAYMENTS REPORT API SENT', `Status: ${response.code}`);
                    } else {
                        log.error('PAYMENTS REPORT API FAILED', `Status: ${response.code} | Body: ${response.body}`);
                    }
                } catch (apiErr) {
                    log.error('PAYMENTS REPORT API FAILED', `Name: ${apiErr.name} | Message: ${apiErr.message} | Stack: ${apiErr.stack}`);
                }
            } else {
                log.error('PAYMENTS REPORT API SKIPPED', `Missing parameters — url: ${!!apiUrl} | functionKey: ${!!apiKey} | docType: ${!!apiDocType}`);
            }

            log.audit('PAYMENTS REPORT COMPLETE', `RPT ID: ${rptId} | File ID: ${fileId} | Payments: ${payments.length}`);

        } catch (e) {
            log.error('PAYMENTS REPORT FAILED', `${e.message}\n${e.stack}`);
        }
    }

    // ── date / window helpers ────────────────────────────────────────────────
    // custscript_pret_today_pr is a Date-type parameter, so NetSuite hands back a Date object
    // directly. The string-parse branch is a defensive fallback in case it's ever redefined as text.
    function resolveToday(todayParam) {
        if (todayParam instanceof Date) return todayParam;
        if (todayParam) {
            try {
                return format.parse({ value: todayParam, type: format.Type.DATE });
            } catch (e) {
                log.error('PAYMENTS REPORT TODAY PARAM INVALID', `Value: ${todayParam} | ${e.message} — falling back to real today`);
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
        log.debug('PAYMENTS REPORT SEARCH COLUMNS', `Labels found: ${Object.keys(labelMap).join(', ')}`);

        const required = ['StartDate', 'EndDate', 'PaymentDate', 'TaxRate', 'CurrencyCode', 'Amount'];
        for (const label of required) {
            if (!labelMap[label]) throw new Error(`Saved search ${SEARCH_ID} is missing a column labeled "${label}"`);
        }

        const payments = [];
        const pagedData = loadedSearch.runPaged({ pageSize: 1000 });
        log.debug('PAYMENTS REPORT SEARCH PAGED', `Total pages: ${pagedData.pageRanges.length} | Total count reported: ${pagedData.count}`);
        for (let p = 0; p < pagedData.pageRanges.length; p++) {
            const page = pagedData.fetch({ index: p });
            log.debug('PAYMENTS REPORT PAGE FETCHED', `Page: ${p + 1}/${pagedData.pageRanges.length} | Rows: ${page.data.length}`);
            page.data.forEach(row => {
                payments.push({
                    reportStartDate: searchDateToYYYYMMDD(row.getValue(labelMap.StartDate)),
                    reportEndDate:   searchDateToYYYYMMDD(row.getValue(labelMap.EndDate)),
                    date:            searchDateToYYYYMMDD(row.getValue(labelMap.PaymentDate)),
                    taxPercent:      cleanNumber(row.getValue(labelMap.TaxRate)),
                    currencyCode:    row.getText(labelMap.CurrencyCode) || row.getValue(labelMap.CurrencyCode),
                    amount:          cleanNumber(row.getValue(labelMap.Amount)).toFixed(2)
                });
            });
        }
        return payments;
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
    function buildReportXml(rptId, sub, payments) {
        // Sender / Issuer both sourced from the France subsidiary (ID=16) — same underlying data,
        // RoleCode kept as SENDER for Sender and SE for Issuer per template.
        const vat   = sub.getValue('federalidnumber')            || 'NOT_VAT';
        const name  = sub.getValue('legalname')                  || 'NOT_NAME';
        const email = sub.getValue('custrecord_pay_remittance_contact') || 'NOT_EMAIL';

        const first = payments[0];

        let transactionsXml = '';
        payments.forEach(p => {
            transactionsXml += `
            <Payment>
                <Date>${p.date}</Date>
                <SubTotals>
                    <TaxPercent>${p.taxPercent}</TaxPercent>
                    <CurrencyCode>${esc(p.currencyCode)}</CurrencyCode>
                    <Amount>${p.amount}</Amount>
                </SubTotals>
            </Payment>`;
        });

        return `<?xml version="1.0" encoding="UTF-8"?>
<Report>
    <ReportDocument>
        <Id>${esc(rptId)}</Id>
        <Name>Payments Report</Name>
        <IssueDateTime>
            <DateTimeString>${nowTimestamp()}</DateTimeString>
        </IssueDateTime>
        <TypeCode>IN</TypeCode>
        <References/>
        <Sender>
            <Id schemeId="VAT">${esc(vat)}</Id>
            <Name>${esc(name)}</Name>
            <RoleCode>SENDER</RoleCode>
            <URIUniversalCommunication>
                <URIID>${esc(email)}</URIID>
            </URIUniversalCommunication>
        </Sender>
        <Issuer>
            <Id schemeId="VAT">${esc(vat)}</Id>
            <Name>${esc(name)}</Name>
            <RoleCode>SE</RoleCode>
            <URIUniversalCommunication>
                <URIID>${esc(email)}</URIID>
            </URIUniversalCommunication>
        </Issuer>
    </ReportDocument>

    <PaymentsReport>
        <ReportPeriod>
            <StartDate>${first.reportStartDate}</StartDate>
            <EndDate>${first.reportEndDate}</EndDate>
        </ReportPeriod>
        <Transactions>${transactionsXml}
        </Transactions>
    </PaymentsReport>
</Report>`;
    }

    return { execute };
});
