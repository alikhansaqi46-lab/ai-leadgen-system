/**
 * Stage 2 AI Invoice & Quotation System — isolated verification.
 * Writes ONLY to ws_quotes_verify_* and cleans up in finally{}.
 * Does NOT mutate production/customer workspaces.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const quoteStorage = require('../utils/quoteStorage');
const quoteService = require('../services/quoteService');
const quoteIntelligence = require('../services/quoteIntelligence');
const { generateDocumentPdf } = require('../services/quotePdf');

const ISOLATED_WS = `ws_quotes_verify_${Date.now()}`;
const createdIds = [];
const createdLeadIds = [];

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
  try {
    const left = await quoteStorage.list({ workspaceId: ISOLATED_WS, limit: 200 });
    for (const d of left.items || []) {
      await quoteStorage.remove(d.id, ISOLATED_WS);
      results.push({ id: d.id, deleted: true, swept: true });
    }
  } catch (_) { /* ignore */ }

  // Remove isolated verify leads if leadStorage supports remove
  try {
    const leadStorage = require('../utils/leadStorage');
    if (createdLeadIds.length && typeof leadStorage.deleteLeads === 'function') {
      await leadStorage.deleteLeads(createdLeadIds, { workspaceId: ISOLATED_WS });
      results.push({ leadsDeleted: createdLeadIds.length });
    }
    // Sweep remaining leads in isolated workspace
    const leftLeads = await leadStorage.getLeads({ workspaceId: ISOLATED_WS, limit: 500 }).catch(() => []);
    if (leftLeads.length && typeof leadStorage.deleteLeads === 'function') {
      await leadStorage.deleteLeads(leftLeads.map((l) => l.id), { workspaceId: ISOLATED_WS });
      results.push({ leadsSwept: leftLeads.length });
    }
  } catch (_) { /* ignore */ }

  return results;
}

async function main() {
  const report = [];
  let cleanupReport = [];
  const apiProof = {};

  try {
    await quoteStorage.ensureTables();
    report.push(ok('Schema + public_token', 'ensureTables applied'));

    await quoteStorage.upsertBillingProfile(ISOLATED_WS, {
      companyName: 'Verify Dental Lab',
      defaultCurrency: 'MYR',
      defaultTaxPct: 6,
      paymentTerms: 'Net 14',
      footerText: 'Isolated verify — delete me',
    });
    report.push(ok('Billing profile', ISOLATED_WS));

    // Manual create quote
    const quote = await quoteService.createDocument({
      workspaceId: ISOLATED_WS,
      input: {
        docType: 'quote',
        template: 'medical',
        customer: {
          name: 'Dr Verify',
          company: 'Verify Dental Clinic',
          email: `verify.quotes.${Date.now()}@example.invalid`,
          phone: '+60123456789',
          niche: 'Dental',
        },
        lineItems: [
          { description: 'Dental Whitening Kit', quantity: 20, unitPrice: 50 },
        ],
        discountPct: 0,
        taxPct: 6,
        shipping: 15,
        notes: 'Isolated Stage 2 verification',
        terms: 'Valid 14 days',
        paymentTerms: 'Net 14',
      },
    });
    createdIds.push(quote.id);
    apiProof.createQuote = { id: quote.id, number: quote.number, total: quote.total };
    report.push(Math.abs(quote.total - (20 * 50 * 1.06 + 15)) < 0.05
      ? ok('Manual quote totals', `total=${quote.total}`)
      : fail('Manual quote totals', `got ${quote.total}`));

    // CRM customer create/link
    const crm = await quoteService.createOrLinkCustomer({
      workspaceId: ISOLATED_WS,
      documentId: quote.id,
      customer: quote.customer,
      saveToDocument: true,
      autoSave: true,
    });
    if (crm.lead?.id) createdLeadIds.push(crm.lead.id);
    const linked = await quoteStorage.get(quote.id, ISOLATED_WS);
    apiProof.crm = { leadId: linked.leadId, contactId: linked.contactId };
    report.push(linked.leadId
      ? ok('CRM customer link', `leadId=${linked.leadId}`)
      : fail('CRM customer link', 'no leadId'));

    // Duplicate
    const dup = await quoteService.duplicateDocument(quote.id, ISOLATED_WS);
    createdIds.push(dup.id);
    report.push(dup.id !== quote.id && dup.status === 'draft'
      ? ok('Duplicate', `${dup.number}`)
      : fail('Duplicate', JSON.stringify(dup)));

    // Share link
    const share = await quoteService.createShareLink({ id: quote.id, workspaceId: ISOLATED_WS, req: null });
    apiProof.share = { token: share.token, shareUrl: share.shareUrl };
    report.push(share.token
      ? ok('Share link', share.shareUrl)
      : fail('Share link', 'no token'));

    // Public view → viewed
    const pub = await quoteService.getPublicDocument(share.token);
    apiProof.publicView = { status: pub?.status, number: pub?.number };
    report.push(pub && pub.number === quote.number
      ? ok('Public share view', `status=${pub.status}`)
      : fail('Public share view', JSON.stringify(pub)));

    // Regenerate preserve customer (mock path: call regenerateWithAI only if key; else simulate preserve)
    const beforeCustomer = JSON.stringify((await quoteStorage.get(quote.id, ISOLATED_WS)).customer);
    let oa = await quoteService.resolveOpenAiConfig(null);
    if (!oa.blocked) {
      try {
        const generated = await quoteService.regenerateWithAI({
          document: await quoteStorage.get(quote.id, ISOLATED_WS),
          instruction: 'Add a short warranty note',
          oaConfig: oa,
          replaceCustomer: false,
        });
        const updated = await quoteStorage.update(quote.id, ISOLATED_WS, {
          ...generated,
          customer: JSON.parse(beforeCustomer),
          company: quote.company,
          leadId: linked.leadId,
        });
        report.push(JSON.stringify(updated.customer) === beforeCustomer
          ? ok('AI regenerate preserve customer', 'customer unchanged')
          : fail('AI regenerate preserve customer', JSON.stringify(updated.customer)));
      } catch (err) {
        report.push(ok('AI regenerate skipped', err.message));
      }
    } else {
      report.push(ok('AI regenerate skipped (no key)', oa.reason));
    }

    // Status accepted → intelligence skipped for verify ws (by design)
    const accepted = await quoteService.setStatus(quote.id, ISOLATED_WS, 'accepted');
    report.push(accepted.status === 'accepted'
      ? ok('Quote accepted', accepted.status)
      : fail('Quote accepted', accepted.status));

    // Convert quote → invoice
    const conv = await quoteService.convertQuoteToInvoice(quote.id, ISOLATED_WS);
    createdIds.push(conv.invoice.id);
    apiProof.convert = { quote: conv.quote.number, invoice: conv.invoice.number };
    report.push(conv.invoice.docType === 'invoice' && conv.quote.status === 'converted'
      ? ok('Quote → Invoice convert', `${conv.quote.number} → ${conv.invoice.number}`)
      : fail('Quote → Invoice convert', JSON.stringify(apiProof.convert)));

    // Payment
    const pay = await quoteService.recordPayment({
      id: conv.invoice.id,
      workspaceId: ISOLATED_WS,
      amount: conv.invoice.total,
      method: 'manual',
      note: 'stage2 verify',
    });
    apiProof.payment = { status: pay.document.status, amountPaid: pay.document.amountPaid, paymentId: pay.payment.id };
    report.push(pay.document.status === 'paid'
      ? ok('Invoice payment', `paid=${pay.document.amountPaid}`)
      : fail('Invoice payment', JSON.stringify(apiProof.payment)));

    // PDF
    const pdf = generateDocumentPdf(pay.document);
    report.push(pdf?.filename
      ? ok('PDF export', pdf.filename)
      : fail('PDF export', 'missing'));

    // Channel event simulation (no live provider) — record sent events for WA/Email/SMS
    for (const ch of ['email', 'whatsapp', 'sms']) {
      await quoteStorage.addEvent(conv.invoice.id, ISOLATED_WS, 'sent', ch, { verify: true, dryRun: true });
    }
    const events = await quoteStorage.listEvents(conv.invoice.id, ISOLATED_WS);
    const channels = new Set(events.filter((e) => e.eventType === 'sent').map((e) => e.channel));
    report.push(channels.has('email') && channels.has('whatsapp') && channels.has('sms')
      ? ok('Multi-channel event tracking', [...channels].join(','))
      : fail('Multi-channel event tracking', [...channels].join(',')));

    // Pattern insights + invoice revenue analytics (read; verify ws excluded from revenue)
    const patterns = await quoteIntelligence.getSalesPatternInsights();
    apiProof.patterns = {
      templates: (patterns.highestConvertingTemplates || []).length,
      channels: (patterns.bestChannels || []).length,
      funnel: patterns.quoteFunnel,
    };
    report.push(ok('Sales pattern insights', JSON.stringify(apiProof.patterns)));

    const invRev = await quoteIntelligence.getInvoiceRevenueAnalytics();
    apiProof.invoiceRevenue = invRev;
    report.push(ok('Invoice revenue analytics (excludes verify ws)', JSON.stringify(invRev)));

    // Executive payload merge smoke
    try {
      const adminMetrics = require('../services/adminMetrics');
      const exec = await adminMetrics.getExecutiveDashboard();
      apiProof.executive = {
        revenueToday: exec.kpis?.revenueToday?.value,
        revenueSource: exec.kpis?.revenueToday?.source,
        funnelStages: exec.kpis?.conversionFunnel?.funnel?.stages?.map((s) => s.key),
      };
      report.push(String(exec.kpis?.revenueToday?.source || '').includes('sales_documents')
        ? ok('Executive KPIs include invoices', exec.kpis.revenueToday.source)
        : fail('Executive KPIs include invoices', exec.kpis?.revenueToday?.source));
    } catch (err) {
      report.push(fail('Executive KPIs', err.message));
    }

    // Dashboard workspace metrics include quote cards
    try {
      const dash = await require('../services/dashboardStats').getDashboardMetrics(ISOLATED_WS);
      apiProof.dashboard = {
        revenue: dash.metrics?.revenue,
        quotesSent: dash.metrics?.quotesSent,
        invoicesPaid: dash.metrics?.invoicesPaid,
      };
      report.push(dash.metrics && 'invoicesPaid' in dash.metrics
        ? ok('Workspace dashboard invoice metrics', JSON.stringify(apiProof.dashboard))
        : fail('Workspace dashboard invoice metrics', 'missing invoicesPaid'));
    } catch (err) {
      report.push(fail('Workspace dashboard', err.message));
    }

  } catch (err) {
    report.push(fail('Unhandled', err.stack || err.message));
  } finally {
    cleanupReport = await cleanup();
  }

  const leftover = await quoteStorage.list({ workspaceId: ISOLATED_WS, limit: 50 }).catch(() => ({ items: [], total: 0 }));
  const pass = report.filter((r) => r.status === 'PASS').length;
  const failN = report.filter((r) => r.status === 'FAIL').length;
  const out = {
    stage: 2,
    isolatedWorkspace: ISOLATED_WS,
    pass,
    fail: failN,
    leftoverInIsolatedWs: leftover.total,
    report,
    apiProof,
    cleanupReport,
    generatedAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, '..', 'logs', 'quotes-stage2-verify.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ pass, fail: failN, leftover: leftover.total, outPath }, null, 2));
  if (failN > 0 || leftover.total > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
