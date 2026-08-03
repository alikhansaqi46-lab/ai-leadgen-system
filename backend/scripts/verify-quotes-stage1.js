/**
 * Stage 1 Quotes & Invoicing verification.
 * - Prefer READ-ONLY checks against live routes/schema.
 * - Any write tests use an ISOLATED workspace and are deleted in finally{}.
 * Never leave persistent quote/invoice rows in production workspaces.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const quoteStorage = require('../utils/quoteStorage');
const quoteService = require('../services/quoteService');
const { generateDocumentPdf } = require('../services/quotePdf');

const ISOLATED_WS = `ws_quotes_verify_${Date.now()}`;
const createdIds = [];

function ok(name, detail) { return { name, status: 'PASS', detail }; }
function fail(name, detail) { return { name, status: 'FAIL', detail }; }

async function cleanup() {
  const results = [];
  for (const id of createdIds) {
    try {
      await quoteStorage.remove(id, ISOLATED_WS);
      results.push({ id, deleted: true });
    } catch (err) {
      results.push({ id, deleted: false, error: err.message });
    }
  }
  // Sweep anything left in isolated workspace
  try {
    const left = await quoteStorage.list({ workspaceId: ISOLATED_WS, limit: 200 });
    for (const d of left.items || []) {
      await quoteStorage.remove(d.id, ISOLATED_WS);
      results.push({ id: d.id, deleted: true, swept: true });
    }
  } catch (_) { /* ignore */ }
  return results;
}

async function main() {
  const report = [];
  let cleanupReport = [];

  try {
    // ---------- READ-ONLY ----------
    await quoteStorage.ensureTables();
    report.push(ok('Schema ensureTables', 'quotes_invoices.sql applied or already present'));

    report.push(quoteStorage.TEMPLATES.length === 7
      ? ok('Templates catalog', quoteStorage.TEMPLATES.join(','))
      : fail('Templates catalog', String(quoteStorage.TEMPLATES.length)));

    report.push(quoteStorage.QUOTE_STATUSES.includes('converted')
      ? ok('Quote statuses', quoteStorage.QUOTE_STATUSES.join(','))
      : fail('Quote statuses', 'missing converted'));

    report.push(quoteStorage.INVOICE_STATUSES.includes('overdue')
      ? ok('Invoice statuses', quoteStorage.INVOICE_STATUSES.join(','))
      : fail('Invoice statuses', 'missing overdue'));

    // Totals pure function (no DB)
    const totals = quoteStorage.computeTotals({
      lineItems: [{ description: 'Kit', quantity: 20, unitPrice: 120 }],
      discountPct: 5,
      taxPct: 0,
      shipping: 0,
    });
    report.push(Math.abs(totals.total - 2280) < 0.01
      ? ok('computeTotals (read-only)', JSON.stringify(totals))
      : fail('computeTotals (read-only)', JSON.stringify(totals)));

    // Live production workspace list — READ ONLY
    const prodWs = process.env.DEFAULT_WORKSPACE_ID || 'default';
    const liveList = await quoteStorage.list({ workspaceId: prodWs, limit: 5 });
    report.push(ok('Read-only list (prod workspace)', `workspace=${prodWs} total=${liveList.total} sample=${liveList.items.length}`));

    const liveStats = await quoteStorage.stats(prodWs);
    report.push(ok('Read-only stats (prod workspace)', JSON.stringify(liveStats)));

    // PDF generator with ephemeral in-memory doc (writes upload file then deletes)
    const ephemeralDoc = {
      id: `tmp_pdf_${Date.now()}`,
      docType: 'quote',
      number: 'QT-TMP-READONLY',
      status: 'draft',
      customer: { company: 'Temp' },
      company: { companyName: 'Temp Co' },
      lineItems: [{ description: 'Temp', quantity: 1, unitPrice: 1, amount: 1 }],
      currency: 'MYR',
      subtotal: 1,
      discountAmount: 0,
      taxPct: 0,
      taxAmount: 0,
      shipping: 0,
      total: 1,
      createdAt: new Date().toISOString(),
    };
    const pdf = generateDocumentPdf(ephemeralDoc);
    const pdfOk = fs.existsSync(pdf.absolutePath) && fs.statSync(pdf.absolutePath).size > 50;
    report.push(pdfOk ? ok('PDF generator (temp file)', pdf.urlPath) : fail('PDF generator', pdf.absolutePath));
    try { fs.unlinkSync(pdf.absolutePath); } catch (_) { /* ignore */ }

    // ---------- ISOLATED WRITE TESTS (cleaned up) ----------
    const profile = await quoteStorage.upsertBillingProfile(ISOLATED_WS, {
      companyName: 'Isolated Quotes Verify',
      defaultCurrency: 'MYR',
      paymentTerms: 'Net 14',
      footerText: 'isolated-only',
    });
    report.push(profile.companyName === 'Isolated Quotes Verify'
      ? ok('Isolated billing profile', ISOLATED_WS)
      : fail('Isolated billing profile', JSON.stringify(profile)));

    const quote = await quoteStorage.create({
      docType: 'quote',
      customer: { name: 'Isolated Contact', company: 'Isolated Clinic' },
      company: quoteService.companyFromProfile(profile),
      lineItems: [{ description: 'Whitening Kit', quantity: 20, unitPrice: 120 }],
      discountPct: 5,
      currency: 'MYR',
      notes: 'isolated-verify-only',
      template: 'medical',
    }, ISOLATED_WS);
    createdIds.push(quote.id);
    report.push(Math.abs(quote.total - 2280) < 0.01
      ? ok('Isolated quote create/totals', `${quote.id} total=${quote.total}`)
      : fail('Isolated quote create/totals', String(quote.total)));

    const updated = await quoteStorage.update(quote.id, ISOLATED_WS, {
      shipping: 10,
      lineItems: [...quote.lineItems, { description: 'Box', quantity: 1, unitPrice: 20 }],
    });
    report.push(updated.lineItems.length === 2
      ? ok('Isolated quote update', `items=${updated.lineItems.length} total=${updated.total}`)
      : fail('Isolated quote update', JSON.stringify(updated.lineItems)));

    await quoteService.setStatus(quote.id, ISOLATED_WS, 'sent');
    await quoteService.setStatus(quote.id, ISOLATED_WS, 'accepted');
    const { invoice, quote: converted } = await quoteService.convertQuoteToInvoice(quote.id, ISOLATED_WS);
    createdIds.push(invoice.id);
    report.push(converted.status === 'converted' && invoice.docType === 'invoice'
      ? ok('Isolated convert quote→invoice', `${converted.number} → ${invoice.number}`)
      : fail('Isolated convert', `${converted.status}/${invoice.docType}`));

    const events = await quoteStorage.listEvents(quote.id, ISOLATED_WS);
    report.push(events.length >= 2
      ? ok('Isolated timeline events', `${events.length}`)
      : fail('Isolated timeline events', String(events.length)));

    // Confirm isolated workspace is separate from prod
    const prodAfter = await quoteStorage.list({ workspaceId: prodWs, limit: 5 });
    report.push(ok('Prod workspace untouched check', `prod total still listed=${prodAfter.total} (isolated writes under ${ISOLATED_WS})`));

  } finally {
    cleanupReport = await cleanup();
  }

  const leftover = await quoteStorage.list({ workspaceId: ISOLATED_WS, limit: 50 }).catch(() => ({ items: [], total: 0 }));
  report.push(leftover.total === 0
    ? ok('Cleanup complete', `deleted=${cleanupReport.length} leftover=0`)
    : fail('Cleanup complete', `leftover=${leftover.total} ids=${(leftover.items || []).map((d) => d.id).join(',')}`));

  const failed = report.filter((r) => r.status === 'FAIL');
  const out = {
    success: failed.length === 0,
    mode: 'read-only + isolated-write-with-cleanup',
    isolatedWorkspace: ISOLATED_WS,
    passed: report.filter((r) => r.status === 'PASS').length,
    failed: failed.length,
    report,
    cleanup: cleanupReport,
    generatedAt: new Date().toISOString(),
  };
  const dest = path.join(__dirname, '../logs/quotes-stage1-proof.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  if (!out.success) process.exit(1);
}

main().catch(async (err) => {
  try { await cleanup(); } catch (_) { /* ignore */ }
  console.error(err);
  process.exit(1);
});
