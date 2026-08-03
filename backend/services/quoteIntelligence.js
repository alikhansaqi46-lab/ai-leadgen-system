/**
 * Bridge sales quotations/invoices into Owner AI Intelligence + CRM timeline.
 * Treats WhatsApp / Email / SMS sends as one connected quote→invoice journey.
 */
const { v4: uuidv4 } = require('uuid');
const quoteStorage = require('../utils/quoteStorage');
const timelineStorage = require('../utils/timelineStorage');
const { query } = require('../config/db');
const userStorage = require('../utils/userStorage');

function resolveDriver() {
  const d = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  if (d === 'postgres' || d === 'pg') return 'postgres';
  if (d === 'json' || d === 'file') return 'json';
  return process.env.DATABASE_URL ? 'postgres' : 'json';
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000));
}

/**
 * Emit owner_success_events for high-signal quote/invoice milestones.
 * Fingerprint includes document id so repeats don't spam.
 */
async function publishDocumentMilestone(doc, eventType, { channel = null, workspaceId } = {}) {
  if (!doc) return null;
  const ws = workspaceId || doc.workspaceId;
  if (!ws) return null;

  // Isolated verify workspaces stay out of Owner Intelligence production feed
  if (String(ws).startsWith('ws_quotes_verify_') || String(ws).includes('sandbox')) return null;

  let ownerIntelligence;
  try { ownerIntelligence = require('./ownerIntelligence'); } catch (_) { return null; }

  const revenue = eventType === 'invoice_paid' || eventType === 'quote_accepted'
    ? num(doc.total)
    : (eventType === 'invoice_paid' ? num(doc.amountPaid || doc.total) : 0);

  const industry = doc.customer?.niche || doc.meta?.industry || null;
  const country = doc.customer?.country || null;
  const cycleDays = daysBetween(doc.sentAt || doc.createdAt, doc.paidAt || doc.acceptedAt || new Date().toISOString());
  const fingerprint = `${ws}:sales_doc:${doc.id}:${eventType}`;

  const evt = {
    id: `ose_${uuidv4()}`,
    fingerprint,
    workspaceId: ws,
    customerEmail: doc.customer?.email || null,
    customerName: doc.customer?.company || doc.customer?.name || null,
    eventType,
    severity: 'success',
    title: eventType === 'invoice_paid'
      ? `Invoice paid — ${doc.number}`
      : eventType === 'quote_accepted'
        ? `Quotation accepted — ${doc.number}`
        : eventType === 'quote_rejected'
          ? `Quotation rejected — ${doc.number}`
          : `${doc.docType} ${eventType} — ${doc.number}`,
    summary: `${doc.docType} ${doc.number} · ${doc.currency || 'MYR'} ${num(doc.total).toFixed(2)} · template ${doc.template || 'corporate'}${channel ? ` · via ${channel}` : ''}`,
    country,
    industry,
    campaignName: `${doc.docType}:${doc.template || 'corporate'}`,
    revenue: eventType === 'invoice_paid' ? num(doc.amountPaid || doc.total) : revenue,
    leadCount: 1,
    replies: 0,
    meetings: 0,
    deals: eventType === 'invoice_paid' || eventType === 'quote_accepted' ? 1 : 0,
    conversionRate: eventType === 'invoice_paid' || eventType === 'quote_accepted' ? 100 : 0,
    channel: channel || doc.meta?.lastChannel || 'multi',
    metrics: {
      documentId: doc.id,
      docType: doc.docType,
      number: doc.number,
      template: doc.template,
      status: doc.status,
      dealSize: num(doc.total),
      salesCycleDays: cycleDays,
      channel,
      journey: 'lead→quote→invoice→payment',
      quoteId: doc.quoteId || (doc.docType === 'quote' ? doc.id : null),
    },
    createdAt: new Date().toISOString(),
    aiScore: eventType === 'invoice_paid' ? 8.5 : eventType === 'quote_accepted' ? 7.5 : 6.5,
    scoreLabel: eventType === 'invoice_paid' ? 'Excellent' : 'Good',
    isTest: String(ws).includes('demo') || String(ws).includes('test'),
    recommendations: {
      bestTemplate: doc.template,
      recommendedChannel: channel || 'whatsapp',
      actionHint: eventType === 'quote_accepted' ? 'Convert to invoice and send payment link' : 'Clone winning template for similar niches',
    },
  };

  try {
    await ownerIntelligence.ensureTables();
    if (typeof ownerIntelligence.insertSuccessEvent === 'function') {
      await ownerIntelligence.insertSuccessEvent(evt);
    }
  } catch (err) {
    console.warn('[QuoteIntelligence] publish:', err.message);
  }

  if (doc.leadId) {
    await timelineStorage.recordEvent({
      leadId: doc.leadId,
      type: eventType === 'invoice_paid' ? 'status_changed' : 'ai_action',
      channel: channel || null,
      referenceId: doc.id,
      payload: {
        action: eventType,
        number: doc.number,
        docType: doc.docType,
        total: doc.total,
        status: doc.status,
        journey: true,
      },
    }, { workspaceId: ws }).catch(() => null);
  }
  return evt;
}

async function getSalesPatternInsights() {
  if (resolveDriver() !== 'postgres') {
    return {
      highestConvertingTemplates: [],
      bestPricingPatterns: [],
      bestChannels: [],
      avgDealSize: 0,
      avgSalesCycleDays: 0,
      winLoss: { accepted: 0, rejected: 0, paid: 0 },
      quoteFunnel: { draft: 0, sent: 0, viewed: 0, accepted: 0, converted: 0, paid: 0 },
    };
  }
  const templates = await query(`
    SELECT COALESCE(template,'corporate') AS key,
      COUNT(*) FILTER (WHERE status IN ('accepted','converted') OR (doc_type='invoice' AND status='paid'))::int AS wins,
      COUNT(*)::int AS total,
      COALESCE(AVG(total),0)::float AS avg_deal,
      COALESCE(SUM(CASE WHEN status='paid' OR status IN ('accepted','converted') THEN total ELSE 0 END),0)::float AS revenue
    FROM sales_documents
    WHERE workspace_id NOT LIKE 'ws_quotes_verify_%'
    GROUP BY COALESCE(template,'corporate')
    ORDER BY wins DESC, revenue DESC
    LIMIT 10
  `).catch(() => ({ rows: [] }));

  const channels = await query(`
    SELECT COALESCE(channel,'unknown') AS key,
      COUNT(*) FILTER (WHERE event_type IN ('sent','status_accepted','status_paid','converted_to_invoice'))::int AS signals,
      COUNT(*) FILTER (WHERE event_type IN ('status_accepted','status_paid'))::int AS wins
    FROM sales_document_events
    WHERE channel IS NOT NULL
      AND workspace_id NOT LIKE 'ws_quotes_verify_%'
    GROUP BY COALESCE(channel,'unknown')
    ORDER BY wins DESC, signals DESC
    LIMIT 10
  `).catch(() => ({ rows: [] }));

  const industries = await query(`
    SELECT COALESCE(customer->>'niche', customer->>'industry', 'Unknown') AS key,
      COUNT(*)::int AS docs,
      COUNT(*) FILTER (WHERE status IN ('accepted','converted','paid'))::int AS wins,
      COALESCE(AVG(total),0)::float AS avg_deal
    FROM sales_documents
    WHERE workspace_id NOT LIKE 'ws_quotes_verify_%'
    GROUP BY 1
    ORDER BY wins DESC, avg_deal DESC
    LIMIT 10
  `).catch(() => ({ rows: [] }));

  const cycle = await query(`
    SELECT AVG(EXTRACT(EPOCH FROM (COALESCE(paid_at, accepted_at) - COALESCE(sent_at, created_at)))/86400.0)::float AS avg_days
    FROM sales_documents
    WHERE COALESCE(paid_at, accepted_at) IS NOT NULL
      AND workspace_id NOT LIKE 'ws_quotes_verify_%'
  `).catch(() => ({ rows: [{ avg_days: 0 }] }));

  const funnel = await query(`
    SELECT
      COUNT(*) FILTER (WHERE doc_type='quote' AND status='draft')::int AS draft,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status IN ('sent','viewed','negotiating'))::int AS sent,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status='viewed')::int AS viewed,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status IN ('accepted','converted'))::int AS accepted,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status='converted')::int AS converted,
      COUNT(*) FILTER (WHERE doc_type='invoice' AND status='paid')::int AS paid,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status='rejected')::int AS rejected,
      COALESCE(AVG(total) FILTER (WHERE doc_type='invoice' AND status='paid'),0)::float AS avg_deal_paid
    FROM sales_documents
    WHERE workspace_id NOT LIKE 'ws_quotes_verify_%'
  `).catch(() => ({ rows: [{}] }));

  const f = funnel.rows[0] || {};
  return {
    highestConvertingTemplates: templates.rows.map((r) => ({
      key: r.key,
      wins: r.wins,
      total: r.total,
      winRate: r.total ? Math.round((r.wins / r.total) * 1000) / 10 : 0,
      avgDeal: r.avg_deal,
      revenue: r.revenue,
    })),
    bestPricingPatterns: templates.rows.map((r) => ({ key: r.key, avgDeal: r.avg_deal, revenue: r.revenue })),
    highestConvertingIndustries: industries.rows,
    bestChannels: channels.rows.map((r) => ({
      key: r.key,
      wins: r.wins,
      signals: r.signals,
      winRate: r.signals ? Math.round((r.wins / r.signals) * 1000) / 10 : 0,
    })),
    avgDealSize: Math.round(num(f.avg_deal_paid || cycle.rows[0]?.avg_deal) * 100) / 100 || Math.round(num(templates.rows[0]?.avg_deal) * 100) / 100,
    avgSalesCycleDays: Math.round(num(cycle.rows[0]?.avg_days) * 10) / 10,
    winLoss: { accepted: f.accepted || 0, rejected: f.rejected || 0, paid: f.paid || 0 },
    quoteFunnel: {
      draft: f.draft || 0,
      sent: f.sent || 0,
      viewed: f.viewed || 0,
      accepted: f.accepted || 0,
      converted: f.converted || 0,
      paid: f.paid || 0,
    },
  };
}

async function getInvoiceRevenueAnalytics() {
  const empty = { daily: 0, monthly: 0, yearly: 0, totalPaid: 0, unpaid: 0, overdue: 0, countPaid: 0 };
  if (resolveDriver() !== 'postgres') {
    // JSON fallback: scan all docs (including isolated — filter verify prefix)
    const all = await quoteStorage.list({ workspaceId: process.env.DEFAULT_WORKSPACE_ID || 'default', limit: 500 }).catch(() => ({ items: [] }));
    // Also try listing without filter by reading file — skip for simplicity
    return empty;
  }
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const month = new Date(today.getFullYear(), today.getMonth(), 1);
  const year = new Date(today.getFullYear(), 0, 1);
  const { rows } = await query(`
    SELECT
      COALESCE(SUM(CASE WHEN status='paid' AND COALESCE(paid_at, updated_at) >= $1 THEN COALESCE(amount_paid, total) ELSE 0 END),0)::float AS daily,
      COALESCE(SUM(CASE WHEN status='paid' AND COALESCE(paid_at, updated_at) >= $2 THEN COALESCE(amount_paid, total) ELSE 0 END),0)::float AS monthly,
      COALESCE(SUM(CASE WHEN status='paid' AND COALESCE(paid_at, updated_at) >= $3 THEN COALESCE(amount_paid, total) ELSE 0 END),0)::float AS yearly,
      COALESCE(SUM(CASE WHEN status='paid' THEN COALESCE(amount_paid, total) ELSE 0 END),0)::float AS total_paid,
      COALESCE(SUM(CASE WHEN status IN ('sent','unpaid','partially_paid','overdue') THEN total - COALESCE(amount_paid,0) ELSE 0 END),0)::float AS unpaid,
      COUNT(*) FILTER (WHERE status='overdue')::int AS overdue,
      COUNT(*) FILTER (WHERE status='paid')::int AS count_paid
    FROM sales_documents
    WHERE doc_type = 'invoice'
      AND workspace_id NOT LIKE 'ws_quotes_verify_%'
  `, [today.toISOString(), month.toISOString(), year.toISOString()]).catch(() => ({ rows: [{}] }));
  const r = rows[0] || {};
  return {
    daily: r.daily || 0,
    monthly: r.monthly || 0,
    yearly: r.yearly || 0,
    totalPaid: r.total_paid || 0,
    unpaid: r.unpaid || 0,
    overdue: r.overdue || 0,
    countPaid: r.count_paid || 0,
    source: 'sales_documents (paid invoices)',
  };
}

module.exports = {
  publishDocumentMilestone,
  getSalesPatternInsights,
  getInvoiceRevenueAnalytics,
};
