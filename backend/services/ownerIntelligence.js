/**
 * Owner AI Success Intelligence — monitors all customer workspaces for
 * meaningful business outcomes and builds a success / pattern library.
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const userStorage = require('../utils/userStorage');
const adminAudit = require('../utils/adminAudit');
const aiProvider = require('./aiProvider');
const openAiKeyService = require('./openAiKeyService');
const {
  computeAiScore,
  buildRecommendations,
  inferMessageQuality,
  inferTimingScore,
  isTestWorkspace,
} = require('./ownerIntelligenceScore');

const REVENUE_THRESHOLD = Number(process.env.OWNER_SUCCESS_REVENUE_MIN || 100);
const REPLY_RATE_MIN = Number(process.env.OWNER_SUCCESS_REPLY_RATE_MIN || 15);
const MIN_SENT_FOR_CAMPAIGN = Number(process.env.OWNER_SUCCESS_MIN_SENT || 8);

function driver() {
  return userStorage.resolveDriver();
}

async function ensureTables() {
  if (driver() !== 'postgres') return;
  const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'db', 'owner_intelligence.sql'), 'utf8');
  const parts = sql
    .split(';')
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter((s) => s.length > 0);
  for (const stmt of parts) {
    try {
      await query(stmt);
    } catch (err) {
      console.warn('[OwnerIntelligence] ensureTables stmt warning:', err.message);
    }
  }
  // Hard guarantee for columns used by library inserts (older installs)
  const alters = [
    'ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS offer TEXT',
    'ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS copy_style TEXT',
    "ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS prompts JSONB DEFAULT '[]'",
    "ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'",
    'ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS searchable TEXT',
    'ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS duplicated_from TEXT',
    "ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'",
    'ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS ai_score NUMERIC(4, 1) DEFAULT 0',
    'ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS score_label TEXT',
    'ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE',
    'ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE',
    'ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS ignored BOOLEAN DEFAULT FALSE',
    'ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT FALSE',
    "ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS recommendations JSONB DEFAULT '{}'",
    'ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()',
    'ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS ai_score NUMERIC(4, 1) DEFAULT 0',
    'ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS score_label TEXT',
    'ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE',
    'ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE',
    'ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS ignored BOOLEAN DEFAULT FALSE',
    'ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT FALSE',
    "ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS recommendations JSONB DEFAULT '{}'",
    'ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS reply_rate NUMERIC(8, 2) DEFAULT 0',
    'ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS lead_quality NUMERIC(8, 2) DEFAULT 0',
    `CREATE TABLE IF NOT EXISTS owner_launch_drafts (
      id TEXT PRIMARY KEY,
      library_id TEXT,
      success_event_id TEXT,
      source_workspace_id TEXT,
      target_workspace_id TEXT,
      channel TEXT NOT NULL,
      name TEXT,
      subject TEXT,
      body TEXT,
      settings JSONB DEFAULT '{}',
      status TEXT DEFAULT 'draft',
      launched_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  ];
  for (const a of alters) {
    try { await query(a); } catch (err) {
      console.warn('[OwnerIntelligence] alter warning:', err.message);
    }
  }
}

async function fingerprintExists(fp) {
  if (driver() === 'postgres') {
    try {
      const { rows } = await query('SELECT id FROM owner_success_events WHERE fingerprint = $1 LIMIT 1', [fp]);
      return !!rows[0];
    } catch (_) { return false; }
  }
  return false;
}

async function insertSuccessEvent(evt) {
  await ensureTables();
  if (driver() === 'postgres') {
    await query(
      `INSERT INTO owner_success_events
       (id, fingerprint, workspace_id, customer_email, customer_name, event_type, severity, title, summary,
        country, industry, campaign_name, revenue, lead_count, replies, meetings, deals, conversion_rate, channel, metrics, notification_id, created_at,
        ai_score, score_label, pinned, archived, ignored, is_test, recommendations, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,FALSE,FALSE,FALSE,$25,$26,$22)
       ON CONFLICT (fingerprint) DO NOTHING`,
      [evt.id, evt.fingerprint, evt.workspaceId, evt.customerEmail, evt.customerName, evt.eventType, evt.severity,
        evt.title, evt.summary, evt.country, evt.industry, evt.campaignName, evt.revenue, evt.leadCount,
        evt.replies, evt.meetings, evt.deals, evt.conversionRate, evt.channel, JSON.stringify(evt.metrics || {}),
        evt.notificationId || null, evt.createdAt,
        evt.aiScore || 0, evt.scoreLabel || null, !!evt.isTest,
        JSON.stringify(evt.recommendations || {})],
    );
  }
  return evt;
}

async function upsertCampaignLibrary(entry) {
  await ensureTables();
  if (driver() !== 'postgres') return entry;
  const searchable = [
    entry.name, entry.industry, entry.country, entry.channel, entry.offer,
    entry.copyStyle, entry.whyItWorked, ...(entry.tags || []),
  ].filter(Boolean).join(' ').toLowerCase();
  await query(
    `INSERT INTO owner_campaign_library
     (id, success_event_id, workspace_id, name, industry, country, channel, revenue, conversion_rate,
      why_it_worked, assets, sequences, funnel, timeline, offer, copy_style, prompts, tags,
      searchable, duplicated_from, status, created_at, updated_at,
      ai_score, score_label, pinned, archived, ignored, is_test, recommendations, reply_rate, lead_quality)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
             $24,$25,COALESCE($26,FALSE),COALESCE($27,FALSE),COALESCE($28,FALSE),COALESCE($29,FALSE),$30,$31,$32)
     ON CONFLICT (id) DO UPDATE SET
       why_it_worked = EXCLUDED.why_it_worked,
       assets = EXCLUDED.assets,
       sequences = EXCLUDED.sequences,
       funnel = EXCLUDED.funnel,
       timeline = EXCLUDED.timeline,
       offer = EXCLUDED.offer,
       copy_style = EXCLUDED.copy_style,
       prompts = EXCLUDED.prompts,
       tags = EXCLUDED.tags,
       searchable = EXCLUDED.searchable,
       ai_score = EXCLUDED.ai_score,
       score_label = EXCLUDED.score_label,
       recommendations = EXCLUDED.recommendations,
       reply_rate = EXCLUDED.reply_rate,
       lead_quality = EXCLUDED.lead_quality,
       is_test = EXCLUDED.is_test,
       updated_at = EXCLUDED.updated_at`,
    [entry.id, entry.successEventId, entry.workspaceId, entry.name, entry.industry, entry.country,
      entry.channel, entry.revenue, entry.conversionRate, entry.whyItWorked,
      JSON.stringify(entry.assets || {}), JSON.stringify(entry.sequences || {}),
      JSON.stringify(entry.funnel || {}), JSON.stringify(entry.timeline || []),
      entry.offer || null, entry.copyStyle || null, JSON.stringify(entry.prompts || []),
      entry.tags || [], searchable, entry.duplicatedFrom || null, entry.status || 'active',
      entry.createdAt, entry.updatedAt,
      entry.aiScore || 0, entry.scoreLabel || null,
      entry.pinned || false, entry.archived || false, entry.ignored || false, entry.isTest || false,
      JSON.stringify(entry.recommendations || {}),
      entry.replyRate || 0, entry.leadQuality || 0],
  );
  return entry;
}

async function enrichWorkspaceCreative(workspaceId) {
  const assets = await collectWorkspaceAssets(workspaceId);
  let winningMessages = [];
  let aiDrafts = [];
  let timing = null;
  try {
    const msg = await query(
      `SELECT channel, direction, source, LEFT(body, 320) AS body, created_at
       FROM messages WHERE workspace_id = $1 AND direction = 'outbound'
       ORDER BY created_at DESC LIMIT 12`,
      [workspaceId],
    );
    winningMessages = msg.rows;
    if (msg.rows.length) {
      const hours = msg.rows.map((r) => new Date(r.created_at).getHours()).filter((h) => Number.isFinite(h));
      if (hours.length) {
        const avg = Math.round(hours.reduce((a, b) => a + b, 0) / hours.length);
        timing = { avgSendHourUtc: avg, sampleSize: hours.length };
      }
    }
  } catch (_) { /* ignore */ }
  try {
    const d = await query(
      `SELECT channel, LEFT(body, 320) AS body, status, created_at
       FROM outreach_drafts WHERE workspace_id = $1
       ORDER BY created_at DESC LIMIT 12`,
      [workspaceId],
    );
    aiDrafts = d.rows;
  } catch (_) { /* ignore */ }

  const sample = [...winningMessages, ...aiDrafts].map((m) => m.body || '').join(' ');
  let copyStyle = 'direct';
  if (/free|bonus|limited|today|offer/i.test(sample)) copyStyle = 'offer-led';
  else if (/\?|curious|wondering|quick question/i.test(sample)) copyStyle = 'question-led';
  else if (/help|support|value|grow|improve/i.test(sample)) copyStyle = 'value-led';

  const prompts = aiDrafts.slice(0, 6).map((d) => ({
    channel: d.channel,
    promptPreview: d.body,
    at: d.created_at,
  }));

  return { assets, winningMessages, aiDrafts, timing, copyStyle, prompts };
}

async function loadWorkspaceSnapshots() {
  if (driver() !== 'postgres') return [];
  const { rows } = await query(`
    SELECT
      c.workspace_id,
      COUNT(*)::int AS campaign_rows,
      COUNT(*) FILTER (WHERE c.status = 'deal')::int AS deals,
      COUNT(*) FILTER (WHERE c.status = 'meeting')::int AS meetings,
      COUNT(*) FILTER (WHERE c.status IN ('replied','interested','meeting','deal'))::int AS replies,
      COUNT(*) FILTER (WHERE c.status <> 'new')::int AS sentish,
      COALESCE(SUM(c.revenue) FILTER (WHERE c.revenue IS NOT NULL), 0)::float AS revenue,
      MAX(c.updated_at) AS last_activity
    FROM campaigns c
    GROUP BY c.workspace_id
  `);

  const msg = await query(`
    SELECT workspace_id, channel, direction, COALESCE(status,'sent') AS status, COUNT(*)::int AS n
    FROM messages
    GROUP BY workspace_id, channel, direction, COALESCE(status,'sent')
  `).catch(() => ({ rows: [] }));

  // leads schema: niche + country (no category column in production)
  const leadMeta = await query(`
    SELECT workspace_id,
      MODE() WITHIN GROUP (ORDER BY NULLIF(niche,'')) AS industry,
      MODE() WITHIN GROUP (ORDER BY NULLIF(country,'')) AS country,
      COUNT(*)::int AS lead_count
    FROM leads
    GROUP BY workspace_id
  `).catch(() => ({ rows: [] }));

  // MODE() may not exist on all PG versions — fallback simple aggregates
  let leadRows = leadMeta.rows;
  if (!leadRows.length) {
    const alt = await query(`
      SELECT workspace_id,
        MAX(NULLIF(niche,'')) AS industry,
        MAX(NULLIF(country,'')) AS country,
        COUNT(*)::int AS lead_count
      FROM leads
      GROUP BY workspace_id
    `).catch(() => ({ rows: [] }));
    leadRows = alt.rows;
  }

  const scoreMeta = await query(`
    SELECT workspace_id,
      COALESCE(AVG(score),0)::float AS avg_score,
      COUNT(*) FILTER (WHERE score >= 70)::int AS high_quality
    FROM lead_scores
    GROUP BY workspace_id
  `).catch(() => ({ rows: [] }));

  // Quotes & Invoices lifecycle — every sales document becomes Owner Intelligence input
  const salesMeta = await query(`
    SELECT workspace_id,
      COUNT(*) FILTER (WHERE doc_type='quote')::int AS quotes_total,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status IN ('sent','viewed','negotiating','accepted','converted'))::int AS quotes_sent,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status IN ('sent','viewed','negotiating'))::int AS quotes_pending,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status='accepted')::int AS quotes_accepted,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status='rejected')::int AS quotes_rejected,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status='converted')::int AS quotes_converted,
      COUNT(*) FILTER (WHERE doc_type='invoice')::int AS invoices_total,
      COUNT(*) FILTER (WHERE doc_type='invoice' AND status IN ('sent','unpaid','overdue','partially_paid'))::int AS invoices_unpaid,
      COUNT(*) FILTER (WHERE doc_type='invoice' AND status='paid')::int AS invoices_paid,
      COUNT(*) FILTER (WHERE doc_type='invoice' AND status IN ('sent','unpaid','overdue','partially_paid') AND due_date IS NOT NULL AND due_date < NOW())::int AS invoices_overdue,
      COALESCE(SUM(total) FILTER (WHERE doc_type='quote' AND status IN ('sent','viewed','negotiating','accepted','converted')),0)::float AS quote_value,
      COALESCE(SUM(total) FILTER (WHERE doc_type='invoice'),0)::float AS invoice_value,
      COALESCE(SUM(amount_paid) FILTER (WHERE doc_type='invoice'),0)::float AS paid_value,
      COALESCE(SUM(total) FILTER (WHERE doc_type='quote' AND status IN ('accepted','converted')),0)::float AS accepted_value
    FROM sales_documents
    GROUP BY workspace_id
  `).catch(() => ({ rows: [] }));

  const msgMap = {};
  for (const r of msg.rows) {
    if (!msgMap[r.workspace_id]) {
      msgMap[r.workspace_id] = {
        waSent: 0, waIn: 0, emailSent: 0, emailIn: 0, smsSent: 0, smsIn: 0,
        emailOpened: 0, emailClicked: 0,
      };
    }
    const m = msgMap[r.workspace_id];
    const st = String(r.status || '').toLowerCase();
    if (r.channel === 'whatsapp' && r.direction === 'outbound') m.waSent += r.n;
    if (r.channel === 'whatsapp' && r.direction === 'inbound') m.waIn += r.n;
    if (r.channel === 'email' && r.direction === 'outbound') {
      m.emailSent += r.n;
      if (st === 'opened' || st === 'read') m.emailOpened += r.n;
      if (st === 'clicked') m.emailClicked += r.n;
    }
    if (r.channel === 'email' && r.direction === 'inbound') m.emailIn += r.n;
    if (r.channel === 'sms' && r.direction === 'outbound') m.smsSent += r.n;
    if (r.channel === 'sms' && r.direction === 'inbound') m.smsIn += r.n;
  }

  const leadMap = {};
  for (const r of leadRows) leadMap[r.workspace_id] = r;
  const scoreMap = {};
  for (const r of scoreMeta.rows) scoreMap[r.workspace_id] = r;
  const salesMap = {};
  for (const r of salesMeta.rows) salesMap[r.workspace_id] = r;

  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    deals: r.deals || 0,
    meetings: r.meetings || 0,
    replies: r.replies || 0,
    sentish: r.sentish || 0,
    revenue: Number(r.revenue) || 0,
    lastActivity: r.last_activity,
    messages: msgMap[r.workspace_id] || {
      waSent: 0, waIn: 0, emailSent: 0, emailIn: 0, smsSent: 0, smsIn: 0,
      emailOpened: 0, emailClicked: 0,
    },
    industry: leadMap[r.workspace_id]?.industry || null,
    country: leadMap[r.workspace_id]?.country || null,
    leadCount: leadMap[r.workspace_id]?.lead_count || 0,
    avgLeadScore: scoreMap[r.workspace_id]?.avg_score || 0,
    highQualityLeads: scoreMap[r.workspace_id]?.high_quality || 0,
    sales: salesMap[r.workspace_id] ? {
      quotesTotal: salesMap[r.workspace_id].quotes_total || 0,
      quotesSent: salesMap[r.workspace_id].quotes_sent || 0,
      quotesPending: salesMap[r.workspace_id].quotes_pending || 0,
      quotesAccepted: salesMap[r.workspace_id].quotes_accepted || 0,
      quotesRejected: salesMap[r.workspace_id].quotes_rejected || 0,
      quotesConverted: salesMap[r.workspace_id].quotes_converted || 0,
      invoicesTotal: salesMap[r.workspace_id].invoices_total || 0,
      invoicesUnpaid: salesMap[r.workspace_id].invoices_unpaid || 0,
      invoicesPaid: salesMap[r.workspace_id].invoices_paid || 0,
      invoicesOverdue: salesMap[r.workspace_id].invoices_overdue || 0,
      quoteValue: Number(salesMap[r.workspace_id].quote_value) || 0,
      invoiceValue: Number(salesMap[r.workspace_id].invoice_value) || 0,
      paidValue: Number(salesMap[r.workspace_id].paid_value) || 0,
      acceptedValue: Number(salesMap[r.workspace_id].accepted_value) || 0,
    } : null,
  }));
}

async function resolveCustomer(workspaceId) {
  const user = await userStorage.findById(workspaceId).catch(() => null);
  if (user) {
    return {
      email: user.email,
      name: user.full_name || user.fullName || user.business_name || user.businessName || user.email,
    };
  }
  return { email: null, name: workspaceId };
}

function buildCandidates(snap) {
  const out = [];
  const conv = snap.sentish > 0 ? Math.round((snap.deals / snap.sentish) * 1000) / 10 : 0;
  const replyConv = snap.sentish > 0 ? Math.round((snap.replies / snap.sentish) * 1000) / 10 : 0;
  const waReplyRate = snap.messages.waSent > 0
    ? Math.round((snap.messages.waIn / snap.messages.waSent) * 1000) / 10
    : 0;
  const emailReplyRate = snap.messages.emailSent > 0
    ? Math.round((snap.messages.emailIn / snap.messages.emailSent) * 1000) / 10
    : 0;

  if (snap.revenue >= REVENUE_THRESHOLD) {
    out.push({
      eventType: 'revenue_generated',
      title: '🔥 SUCCESS DETECTED — Customer generated revenue',
      campaignName: `${snap.industry || 'Multi-industry'} revenue campaign`,
      channel: snap.messages.waSent >= snap.messages.emailSent ? 'whatsapp' : 'email',
      conversionRate: conv,
      metrics: { revenue: snap.revenue, deals: snap.deals, meetings: snap.meetings, replies: snap.replies },
    });
  }
  if (snap.deals >= 1) {
    out.push({
      eventType: 'deal_won',
      title: '🔥 SUCCESS DETECTED — Deal won / sales completed',
      campaignName: `${snap.industry || 'Sales'} close campaign`,
      channel: 'multi',
      conversionRate: conv,
      metrics: { deals: snap.deals, revenue: snap.revenue, replyConv },
    });
  }
  if (snap.meetings >= 1) {
    out.push({
      eventType: 'appointments_booked',
      title: '🔥 SUCCESS DETECTED — Appointment booked',
      campaignName: 'Meeting conversion campaign',
      channel: 'multi',
      conversionRate: conv,
      metrics: { meetings: snap.meetings, replies: snap.replies },
    });
  }
  if (snap.messages.waSent >= MIN_SENT_FOR_CAMPAIGN && waReplyRate >= REPLY_RATE_MIN) {
    out.push({
      eventType: 'whatsapp_campaign_success',
      title: '🔥 SUCCESS DETECTED — High-performing WhatsApp campaign',
      campaignName: 'WhatsApp outreach',
      channel: 'whatsapp',
      conversionRate: waReplyRate,
      metrics: { sent: snap.messages.waSent, replies: snap.messages.waIn, replyRate: waReplyRate },
    });
  }
  if (snap.messages.emailSent >= MIN_SENT_FOR_CAMPAIGN && emailReplyRate >= REPLY_RATE_MIN) {
    out.push({
      eventType: 'email_campaign_success',
      title: '🔥 SUCCESS DETECTED — High-performing Email campaign',
      campaignName: 'Email outreach',
      channel: 'email',
      conversionRate: emailReplyRate,
      metrics: { sent: snap.messages.emailSent, replies: snap.messages.emailIn, replyRate: emailReplyRate },
    });
  }
  const smsReplyRate = snap.messages.smsSent > 0
    ? Math.round((snap.messages.smsIn / snap.messages.smsSent) * 1000) / 10
    : 0;
  if (snap.messages.smsSent >= MIN_SENT_FOR_CAMPAIGN && smsReplyRate >= REPLY_RATE_MIN) {
    out.push({
      eventType: 'sms_campaign_success',
      title: '🔥 SUCCESS DETECTED — High-performing SMS campaign',
      campaignName: 'SMS outreach',
      channel: 'sms',
      conversionRate: smsReplyRate,
      metrics: { sent: snap.messages.smsSent, replies: snap.messages.smsIn, replyRate: smsReplyRate },
    });
  }
  const openRate = snap.messages.emailSent > 0
    ? Math.round((snap.messages.emailOpened / snap.messages.emailSent) * 1000) / 10
    : 0;
  const clickRate = snap.messages.emailSent > 0
    ? Math.round((snap.messages.emailClicked / snap.messages.emailSent) * 1000) / 10
    : 0;
  if (snap.messages.emailSent >= MIN_SENT_FOR_CAMPAIGN && openRate >= 20) {
    out.push({
      eventType: 'high_email_open_rate',
      title: '🔥 SUCCESS DETECTED — High email open rate',
      campaignName: 'Email engagement',
      channel: 'email',
      conversionRate: openRate,
      metrics: { openRate, clickRate, sent: snap.messages.emailSent },
    });
  }
  if ((snap.highQualityLeads || 0) >= 5 && (snap.avgLeadScore || 0) >= 70) {
    out.push({
      eventType: 'high_quality_leads',
      title: '🔥 SUCCESS DETECTED — High-quality lead cohort',
      campaignName: `${snap.industry || 'General'} lead quality`,
      channel: 'leads',
      conversionRate: Math.round(snap.avgLeadScore || 0),
      metrics: { avgScore: snap.avgLeadScore, highQuality: snap.highQualityLeads, leadCount: snap.leadCount },
    });
  }
  if (conv >= 10 && snap.sentish >= MIN_SENT_FOR_CAMPAIGN) {
    out.push({
      eventType: 'high_conversion_campaign',
      title: '🔥 SUCCESS DETECTED — High conversion campaign',
      campaignName: `${snap.industry || 'General'} conversion engine`,
      channel: 'multi',
      conversionRate: conv,
      metrics: { conversionRate: conv, sent: snap.sentish, deals: snap.deals },
    });
  }
  if (replyConv >= REPLY_RATE_MIN && snap.sentish >= MIN_SENT_FOR_CAMPAIGN) {
    out.push({
      eventType: 'high_reply_rate',
      title: '🔥 SUCCESS DETECTED — High reply rate outreach',
      campaignName: 'Winning outreach sequence',
      channel: 'multi',
      conversionRate: replyConv,
      metrics: { replyRate: replyConv, sent: snap.sentish, replies: snap.replies },
    });
  }
  if ((snap.creative?.assets?.images || []).length >= 2 && (snap.deals >= 1 || waReplyRate >= REPLY_RATE_MIN || emailReplyRate >= REPLY_RATE_MIN)) {
    out.push({
      eventType: 'best_performing_creatives',
      title: '🔥 SUCCESS DETECTED — Best-performing campaign creatives',
      campaignName: 'Creative-led campaign',
      channel: snap.channel || 'multi',
      conversionRate: Math.max(conv, waReplyRate, emailReplyRate),
      metrics: { images: snap.creative.assets.images.length, documents: (snap.creative.assets.documents || []).length },
    });
  }
  if ((snap.creative?.prompts || []).length >= 2 && (snap.deals >= 1 || replyConv >= REPLY_RATE_MIN)) {
    out.push({
      eventType: 'best_performing_prompts',
      title: '🔥 SUCCESS DETECTED — Best-performing AI prompts / messages',
      campaignName: 'AI message winners',
      channel: 'ai',
      conversionRate: Math.max(conv, replyConv),
      metrics: { promptCount: snap.creative.prompts.length, style: snap.creative.copyStyle },
    });
  }

  // ---- Quotes & Invoices lifecycle (sales documents) ----
  const sales = snap.sales;
  if (sales) {
    if (sales.quotesAccepted >= 1) {
      out.push({
        eventType: 'quote_accepted',
        title: '🔥 SUCCESS DETECTED — Quotation accepted by customer',
        campaignName: `${snap.industry || 'Sales'} quotation pipeline`,
        channel: 'quotes',
        conversionRate: sales.quotesSent > 0 ? Math.round((sales.quotesAccepted / sales.quotesSent) * 1000) / 10 : 0,
        metrics: { sales },
      });
    }
    if (sales.quotesConverted >= 1) {
      out.push({
        eventType: 'quote_converted_to_invoice',
        title: '🔥 SUCCESS DETECTED — Quotation converted to invoice',
        campaignName: `${snap.industry || 'Sales'} quote→invoice engine`,
        channel: 'quotes',
        conversionRate: sales.quotesSent > 0 ? Math.round((sales.quotesConverted / sales.quotesSent) * 1000) / 10 : 0,
        metrics: { sales },
      });
    }
    if (sales.invoicesPaid >= 1) {
      out.push({
        eventType: 'invoice_paid',
        title: '🔥 SUCCESS DETECTED — Invoice paid',
        campaignName: `${snap.industry || 'Sales'} collections`,
        channel: 'invoices',
        conversionRate: sales.invoicesTotal > 0 ? Math.round((sales.invoicesPaid / sales.invoicesTotal) * 1000) / 10 : 0,
        metrics: { sales, paidValue: sales.paidValue },
      });
    }
    if (sales.invoicesOverdue >= 1) {
      out.push({
        eventType: 'invoice_overdue',
        severity: 'warning',
        title: '⚠ ATTENTION — Invoice overdue (follow-up needed)',
        campaignName: `${snap.industry || 'Sales'} overdue collections`,
        channel: 'invoices',
        conversionRate: 0,
        metrics: { sales, overdueCount: sales.invoicesOverdue },
      });
    }
    if (sales.quotesPending >= 3) {
      out.push({
        eventType: 'quotes_pending_followup',
        severity: 'warning',
        title: '⚠ ATTENTION — Multiple quotations awaiting customer response',
        campaignName: `${snap.industry || 'Sales'} pending quotations`,
        channel: 'quotes',
        conversionRate: 0,
        metrics: { sales, pendingCount: sales.quotesPending },
      });
    }
  }
  return out;
}

async function explainWhyItWorked(payload) {
  try {
    const ownerEmails = (process.env.SUPER_ADMIN_EMAILS || 'leadflow.my@gmail.com').split(',')[0].trim();
    const owner = await userStorage.findByEmail(ownerEmails);
    const oa = owner ? await openAiKeyService.getOpenAiConfig(owner.id) : null;
    if (!oa || oa.blocked) {
      return heuristicWhy(payload);
    }
    const result = await aiProvider.callOpenAI(
      [
        { role: 'system', content: 'You are a SaaS growth analyst. Return JSON {"why":"..."} explaining campaign success in 2-4 sentences.' },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      0.4,
      280,
      { ...oa, source: 'owner_intelligence', operation: 'success_explain', trackUsage: true },
    );
    return String(result.why || result.message || heuristicWhy(payload));
  } catch (_) {
    return heuristicWhy(payload);
  }
}

function heuristicWhy(payload) {
  const bits = [];
  if (payload.industry) bits.push(`Strong fit in ${payload.industry}`);
  if (payload.country) bits.push(`localized to ${payload.country}`);
  if (payload.channel === 'whatsapp') bits.push('WhatsApp reply velocity outperformed baseline');
  if (payload.channel === 'email') bits.push('Email engagement sustained through the sequence');
  if (payload.conversionRate) bits.push(`${payload.conversionRate}% conversion`);
  if (payload.revenue) bits.push(`$${payload.revenue} revenue closed`);
  return bits.length
    ? `${bits.join('; ')}. Pattern is worth cloning for similar niches.`
    : 'Customer achieved measurable pipeline outcomes across outreach channels.';
}

async function scanAndNotify() {
  await ensureTables();
  const snaps = await loadWorkspaceSnapshots();
  const created = [];
  const ownerEmail = (process.env.SUPER_ADMIN_EMAILS || 'leadflow.my@gmail.com')
    .split(',')[0].trim().toLowerCase();

  for (const snap of snaps) {
    const customer = await resolveCustomer(snap.workspaceId);
    if ((customer.email || '').toLowerCase() === ownerEmail) continue;

    const creative = await enrichWorkspaceCreative(snap.workspaceId);
    snap.creative = creative;

    const candidates = buildCandidates(snap);
    for (const c of candidates) {
      const day = new Date().toISOString().slice(0, 10);
      const fingerprint = `${snap.workspaceId}:${c.eventType}:${day}`;
      if (await fingerprintExists(fingerprint)) continue;

      const id = `ose_${uuidv4()}`;
      const dealValue = snap.revenue;
      const replyRate = Number(c.metrics?.replyRate ?? c.conversionRate) || 0;
      const leadQuality = Number(snap.avgLeadScore) || 0;
      const messageQuality = inferMessageQuality(c.metrics, creative);
      const timingScore = inferTimingScore(c.metrics, creative);
      const followUpSuccess = snap.meetings > 0 || snap.deals > 0 ? 0.8 : 0.2;
      const scored = computeAiScore({
        revenue: snap.revenue,
        conversionRate: c.conversionRate,
        replyRate,
        meetings: snap.meetings,
        deals: snap.deals,
        leadQuality,
        messageQuality,
        timingScore,
        followUpSuccess,
      });
      const isTest = isTestWorkspace(snap.workspaceId);

      const why = await explainWhyItWorked({
        industry: snap.industry,
        country: snap.country,
        channel: c.channel,
        conversionRate: c.conversionRate,
        revenue: snap.revenue,
        eventType: c.eventType,
        metrics: c.metrics,
        copyStyle: creative.copyStyle,
        timing: creative.timing,
        offer: `${snap.industry || 'Service'} outreach`,
      });

      const recommendations = buildRecommendations({
        aiScore: scored.aiScore,
        industry: snap.industry,
        country: snap.country,
        channel: c.channel,
        conversionRate: c.conversionRate,
        replyRate,
        revenue: snap.revenue,
        deals: snap.deals,
        timing: creative.timing,
        copyStyle: creative.copyStyle,
        whyItWorked: why,
      });

      const notifTitle = scored.aiScore >= 8
        ? `New High Performing Campaign Detected — ${scored.aiScore}/10 ${scored.scoreLabel}`
        : c.title;
      const notif = await adminAudit.pushNotification({
        severity: c.severity === 'warning' ? 'warning' : 'success',
        category: 'success',
        title: notifTitle,
        body: [
          'Open in AI Intelligence',
          customer.name || customer.email || snap.workspaceId,
          snap.country || '—',
          snap.industry || '—',
          c.campaignName,
          `Revenue $${snap.revenue}`,
          `Conv ${c.conversionRate}%`,
          `AI Score ${scored.aiScore}/10 (${scored.scoreLabel})`,
          `Workspace ${snap.workspaceId}`,
        ].join(' · '),
        source: id,
      });

      const evt = {
        id,
        fingerprint,
        workspaceId: snap.workspaceId,
        customerEmail: customer.email,
        customerName: customer.name,
        eventType: c.eventType,
        severity: c.severity === 'warning' ? 'warning' : 'success',
        title: c.title,
        summary: notif.body,
        country: snap.country,
        industry: snap.industry,
        campaignName: c.campaignName,
        revenue: snap.revenue,
        leadCount: snap.leadCount,
        replies: snap.replies,
        meetings: snap.meetings,
        deals: snap.deals,
        conversionRate: c.conversionRate,
        channel: c.channel,
        metrics: {
          ...c.metrics,
          dealValue,
          replyRate,
          leadQuality,
          wa: snap.messages,
          emailSent: snap.messages.emailSent,
          timing: creative.timing,
          copyStyle: creative.copyStyle,
          winningMessages: (creative.winningMessages || []).slice(0, 5),
          assets: {
            imageCount: (creative.assets.images || []).length,
            documentCount: (creative.assets.documents || []).length,
          },
        },
        notificationId: notif.id,
        createdAt: new Date().toISOString(),
        aiScore: scored.aiScore,
        scoreLabel: scored.scoreLabel,
        isTest,
        recommendations,
      };
      await insertSuccessEvent(evt);

      const tags = [c.eventType, c.channel, snap.industry, snap.country, creative.copyStyle, isTest ? 'test' : 'production']
        .filter(Boolean).map((t) => String(t).toLowerCase());

      const libId = `ocl_${id}`;
      await upsertCampaignLibrary({
        id: libId,
        successEventId: id,
        workspaceId: snap.workspaceId,
        name: c.campaignName,
        industry: snap.industry,
        country: snap.country,
        channel: c.channel,
        revenue: snap.revenue,
        conversionRate: c.conversionRate,
        whyItWorked: why,
        offer: `${snap.industry || 'General'} growth offer`,
        copyStyle: creative.copyStyle,
        prompts: creative.prompts,
        tags,
        aiScore: scored.aiScore,
        scoreLabel: scored.scoreLabel,
        isTest,
        recommendations,
        replyRate,
        leadQuality,
        assets: {
          ...creative.assets,
          note: 'Marketing assets collected from workspace media messages',
        },
        sequences: {
          email: (creative.winningMessages || []).filter((m) => m.channel === 'email').map((m) => m.body),
          whatsapp: (creative.winningMessages || []).filter((m) => m.channel === 'whatsapp').map((m) => m.body),
          aiMessages: (creative.aiDrafts || []).map((m) => m.body),
          winningMessages: (creative.winningMessages || []).slice(0, 8),
          timing: creative.timing,
        },
        funnel: {
          leads: snap.leadCount,
          sent: snap.sentish,
          replies: snap.replies,
          meetings: snap.meetings,
          deals: snap.deals,
          revenue: snap.revenue,
          dealValue,
          conversionRate: c.conversionRate,
        },
        timeline: [
          { at: snap.lastActivity, label: 'Latest campaign activity' },
          { at: evt.createdAt, label: 'Owner success event created' },
          ...(creative.winningMessages || []).slice(0, 4).map((m) => ({
            at: m.created_at,
            label: `Outbound ${m.channel}`,
          })),
        ],
        createdAt: evt.createdAt,
        updatedAt: evt.createdAt,
      });

      created.push(evt);
    }
  }

  return { scanned: snaps.length, created: created.length, events: created };
}

async function listSuccessEvents(limit = 50) {
  await ensureTables();
  if (driver() !== 'postgres') return [];
  const { rows } = await query(
    `SELECT * FROM owner_success_events
     WHERE COALESCE(archived,FALSE) = FALSE AND COALESCE(ignored,FALSE) = FALSE
     ORDER BY COALESCE(pinned,FALSE) DESC, COALESCE(ai_score,0) DESC NULLS LAST, created_at DESC
     LIMIT $1`,
    [Math.min(limit, 200)],
  );
  return rows.map(enrichEventRow);
}

function asJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

async function collectWorkspaceAssets(workspaceId) {
  const images = [];
  const documents = [];
  try {
    const media = await query(
      `SELECT channel, direction, source, LEFT(body, 240) AS body, created_at
       FROM messages
       WHERE workspace_id = $1
         AND (
           body ILIKE '%/uploads/%'
           OR body ILIKE '%.png%' OR body ILIKE '%.jpg%' OR body ILIKE '%.jpeg%'
           OR body ILIKE '%.webp%' OR body ILIKE '%.gif%'
           OR body ILIKE '%.pdf%' OR body ILIKE '%.docx%' OR body ILIKE '%.doc%'
         )
       ORDER BY created_at DESC LIMIT 30`,
      [workspaceId],
    );
    for (const m of media.rows) {
      const urlMatch = String(m.body || '').match(/https?:\/\/\S+|\/uploads\/[^\s)]+/i);
      const url = urlMatch ? urlMatch[0] : null;
      const entry = {
        channel: m.channel,
        type: m.source || 'message',
        url,
        preview: m.body,
        at: m.created_at,
      };
      if (/\.(png|jpe?g|webp|gif)(\b|$)/i.test(`${m.body || ''} ${url || ''}`) || /\/uploads\//i.test(url || '')) {
        images.push(entry);
      } else {
        documents.push(entry);
      }
    }
  } catch (_) { /* ignore */ }
  return { images, documents };
}

async function getCampaignIntelligence(successEventId) {
  await ensureTables();
  if (driver() !== 'postgres') return null;
  const { rows } = await query('SELECT * FROM owner_success_events WHERE id = $1 LIMIT 1', [successEventId]);
  const evt = rows[0];
  if (!evt) return null;

  let library = null;
  const lib = await query('SELECT * FROM owner_campaign_library WHERE success_event_id = $1 LIMIT 1', [successEventId]);
  library = lib.rows[0] || null;

  // Recent messages sample for sequences
  let sampleMessages = [];
  try {
    const msg = await query(
      `SELECT channel, direction, LEFT(body, 280) AS body, created_at, source
       FROM messages WHERE workspace_id = $1
       ORDER BY created_at DESC LIMIT 40`,
      [evt.workspace_id],
    );
    sampleMessages = msg.rows;
  } catch (_) { /* ignore */ }

  let drafts = [];
  try {
    const d = await query(
      `SELECT channel, LEFT(body, 280) AS body, status, created_at
       FROM outreach_drafts WHERE workspace_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [evt.workspace_id],
    );
    drafts = d.rows;
  } catch (_) { /* ignore */ }

  const liveAssets = await collectWorkspaceAssets(evt.workspace_id);
  const storedAssets = asJson(library?.assets, {});
  const assets = {
    images: [...(storedAssets.images || []), ...liveAssets.images].slice(0, 24),
    documents: [...(storedAssets.documents || []), ...liveAssets.documents].slice(0, 24),
    note: storedAssets.note || 'Marketing assets collected from workspace media messages.',
  };

  const funnel = asJson(library?.funnel, {
    leads: evt.lead_count,
    replies: evt.replies,
    meetings: evt.meetings,
    deals: evt.deals,
    revenue: Number(evt.revenue) || 0,
    conversionRate: Number(evt.conversion_rate) || 0,
  });
  const timeline = asJson(library?.timeline, []);
  const sequencesStored = asJson(library?.sequences, {});

  const enriched = enrichEventRow(evt);
  return {
    successEvent: enriched,
    library,
    campaignSummary: {
      name: evt.campaign_name,
      customer: evt.customer_name || evt.customer_email,
      industry: evt.industry,
      country: evt.country,
      channel: evt.channel,
      leadSource: 'workspace_campaigns_and_leads',
      revenue: Number(evt.revenue) || 0,
      leadCount: evt.lead_count,
      replies: evt.replies,
      meetings: evt.meetings,
      deals: evt.deals,
      conversionRate: Number(evt.conversion_rate) || 0,
      detectedAt: evt.created_at,
      aiScore: enriched.ai_score,
      scoreLabel: enriched.score_label,
      pinned: enriched.pinned,
      archived: enriched.archived,
      ignored: enriched.ignored,
      isTest: enriched.is_test,
      workspaceId: evt.workspace_id,
    },
    whyItWorked: library?.why_it_worked || null,
    recommendations: enriched.recommendations,
    funnel,
    assets,
    sequences: {
      ...sequencesStored,
      emailSequence: sequencesStored.email || sequencesStored.emailSequence || null,
      whatsappSequence: sequencesStored.whatsapp || sequencesStored.whatsappSequence || null,
      recentMessages: sampleMessages,
      aiDrafts: drafts,
    },
    timeline,
  };
}

async function getPatternInsights() {
  await ensureTables();
  if (driver() !== 'postgres') {
    return {
      highestConvertingIndustries: [],
      bestCountries: [],
      bestEmailCampaigns: [],
      bestWhatsappCampaigns: [],
      highestRevenueCampaigns: [],
      highestRoiCampaigns: [],
      fastestClosingCampaigns: [],
      architectureReady: true,
    };
  }

  const byIndustry = await query(`
    SELECT COALESCE(industry, 'Unknown') AS key,
      COUNT(*)::int AS wins,
      COALESCE(AVG(conversion_rate),0)::float AS avg_conversion,
      COALESCE(SUM(revenue),0)::float AS revenue
    FROM owner_success_events
    GROUP BY COALESCE(industry, 'Unknown')
    ORDER BY revenue DESC, wins DESC
    LIMIT 10
  `).catch(() => ({ rows: [] }));

  const byCountry = await query(`
    SELECT COALESCE(country, 'Unknown') AS key,
      COUNT(*)::int AS wins,
      COALESCE(AVG(conversion_rate),0)::float AS avg_conversion,
      COALESCE(SUM(revenue),0)::float AS revenue
    FROM owner_success_events
    GROUP BY COALESCE(country, 'Unknown')
    ORDER BY revenue DESC, wins DESC
    LIMIT 10
  `).catch(() => ({ rows: [] }));

  const wa = await query(`
    SELECT * FROM owner_success_events
    WHERE channel = 'whatsapp' OR event_type = 'whatsapp_campaign_success'
    ORDER BY conversion_rate DESC NULLS LAST, revenue DESC
    LIMIT 10
  `).catch(() => ({ rows: [] }));

  const email = await query(`
    SELECT * FROM owner_success_events
    WHERE channel = 'email' OR event_type = 'email_campaign_success'
    ORDER BY conversion_rate DESC NULLS LAST, revenue DESC
    LIMIT 10
  `).catch(() => ({ rows: [] }));

  const revenue = await query(`
    SELECT * FROM owner_success_events
    ORDER BY revenue DESC NULLS LAST
    LIMIT 10
  `).catch(() => ({ rows: [] }));

  const roi = await query(`
    SELECT *, CASE WHEN lead_count > 0 THEN revenue / lead_count ELSE revenue END AS roi_proxy
    FROM owner_success_events
    ORDER BY roi_proxy DESC NULLS LAST
    LIMIT 10
  `).catch(() => ({ rows: [] }));

  const fast = await query(`
    SELECT * FROM owner_success_events
    WHERE event_type IN ('deal_won','appointments_booked','revenue_generated')
    ORDER BY created_at DESC
    LIMIT 10
  `).catch(() => ({ rows: [] }));

  const styles = await query(`
    SELECT COALESCE(copy_style, 'unknown') AS key, COUNT(*)::int AS wins,
      COALESCE(AVG(conversion_rate),0)::float AS avg_conversion,
      COALESCE(SUM(revenue),0)::float AS revenue
    FROM owner_campaign_library
    GROUP BY COALESCE(copy_style, 'unknown')
    ORDER BY wins DESC
    LIMIT 10
  `).catch(() => ({ rows: [] }));

  let salesPatterns = null;
  try {
    salesPatterns = await require('./quoteIntelligence').getSalesPatternInsights();
  } catch (_) {
    salesPatterns = null;
  }

  return {
    highestConvertingIndustries: byIndustry.rows,
    bestCountries: byCountry.rows,
    bestEmailCampaigns: email.rows,
    bestWhatsappCampaigns: wa.rows,
    highestRevenueCampaigns: revenue.rows,
    highestRoiCampaigns: roi.rows,
    fastestClosingCampaigns: fast.rows,
    bestCopyStyles: styles.rows,
    salesDocuments: salesPatterns,
    highestConvertingQuotationStyles: salesPatterns?.highestConvertingTemplates || [],
    bestPricingPatterns: salesPatterns?.bestPricingPatterns || [],
    bestQuoteChannels: salesPatterns?.bestChannels || [],
    avgDealSize: salesPatterns?.avgDealSize || 0,
    avgSalesCycleDays: salesPatterns?.avgSalesCycleDays || 0,
    quoteWinLoss: salesPatterns?.winLoss || { accepted: 0, rejected: 0, paid: 0 },
    quoteFunnel: salesPatterns?.quoteFunnel || null,
    architectureReady: true,
    futureModules: [
      'revenue_leaderboard',
      'best_campaign_library',
      'best_performing_images',
      'best_performing_ai_prompts',
      'winning_outreach_templates',
      'industry_benchmarks',
      'country_benchmarks',
      'ai_campaign_recommendations',
      'quotation_style_learning',
      'invoice_conversion_funnel',
    ],
  };
}

async function getSuccessFeed(limit = 25) {
  const events = await listSuccessEvents(limit);
  return events.map((e) => {
    const metrics = asJson(e.metrics, {});
    return {
      id: e.id,
      title: e.title,
      customerName: e.customer_name || e.customer_email || e.workspace_id,
      customerEmail: e.customer_email,
      country: e.country,
      niche: e.industry,
      campaignType: e.campaign_name || e.event_type,
      eventType: e.event_type,
      revenue: Number(e.revenue) || 0,
      dealValue: Number(metrics.dealValue ?? e.revenue) || 0,
      leadCount: e.lead_count,
      replies: e.replies,
      conversions: e.deals,
      meetings: e.meetings,
      conversionRate: Number(e.conversion_rate) || 0,
      channel: e.channel,
      aiScore: e.ai_score,
      scoreLabel: e.score_label,
      pinned: e.pinned,
      isTest: e.is_test,
      recommendations: e.recommendations,
      winningMessages: metrics.winningMessages || [],
      assets: metrics.assets || {},
      timing: metrics.timing || null,
      copyStyle: metrics.copyStyle || null,
      createdAt: e.created_at,
      summary: e.summary,
      workspaceId: e.workspace_id,
    };
  });
}

async function getLibraryItem(id) {
  await ensureTables();
  if (driver() !== 'postgres') return null;
  const { rows } = await query('SELECT * FROM owner_campaign_library WHERE id = $1 LIMIT 1', [id]);
  const r = rows[0];
  if (!r) return null;
  return {
    ...r,
    assets: asJson(r.assets, {}),
    sequences: asJson(r.sequences, {}),
    funnel: asJson(r.funnel, {}),
    timeline: asJson(r.timeline, []),
    prompts: asJson(r.prompts, []),
    recommendations: asJson(r.recommendations, {}),
    pinned: !!r.pinned,
    archived: !!r.archived || r.status === 'archived',
    ignored: !!r.ignored,
    is_test: !!r.is_test || isTestWorkspace(r.workspace_id, r.tags),
    ai_score: Number(r.ai_score) || 0,
    score_label: r.score_label || scoreLabelSafe(Number(r.ai_score) || 0),
  };
}

async function duplicateLibraryItem(id, { name, adaptNotes } = {}) {
  const src = await getLibraryItem(id);
  if (!src) return null;
  const now = new Date().toISOString();
  const copy = {
    id: `ocl_${uuidv4()}`,
    successEventId: src.success_event_id,
    workspaceId: src.workspace_id,
    name: name || `${src.name} (reuse)`,
    industry: src.industry,
    country: src.country,
    channel: src.channel,
    revenue: Number(src.revenue) || 0,
    conversionRate: Number(src.conversion_rate) || 0,
    whyItWorked: adaptNotes
      ? `${src.why_it_worked || ''}\n\nAdaptation notes: ${adaptNotes}`
      : src.why_it_worked,
    assets: src.assets,
    sequences: src.sequences,
    funnel: src.funnel,
    timeline: [
      ...(Array.isArray(src.timeline) ? src.timeline : []),
      { at: now, label: 'Duplicated into reusable template' },
    ],
    offer: src.offer,
    copyStyle: src.copy_style,
    prompts: src.prompts,
    tags: [...(src.tags || []), 'reused', 'template'],
    duplicatedFrom: src.id,
    status: 'template',
    createdAt: now,
    updatedAt: now,
    aiScore: Number(src.ai_score) || 0,
    scoreLabel: src.score_label,
    isTest: !!src.is_test,
    recommendations: asJson(src.recommendations, {}),
    replyRate: Number(src.reply_rate) || 0,
    leadQuality: Number(src.lead_quality) || 0,
  };
  await upsertCampaignLibrary(copy);
  return getLibraryItem(copy.id);
}

function enrichEventRow(e) {
  const metrics = asJson(e.metrics, {});
  const recommendations = asJson(e.recommendations, {});
  let aiScore = Number(e.ai_score) || 0;
  let label = e.score_label;
  if (!aiScore) {
    const scored = computeAiScore({
      revenue: e.revenue,
      conversionRate: e.conversion_rate,
      replyRate: metrics.replyRate || e.conversion_rate,
      meetings: e.meetings,
      deals: e.deals,
      leadQuality: metrics.leadQuality || 0,
      messageQuality: inferMessageQuality(metrics),
      timingScore: inferTimingScore(metrics),
      followUpSuccess: (e.meetings > 0 || e.deals > 0) ? 0.8 : 0.2,
    });
    aiScore = scored.aiScore;
    label = scored.scoreLabel;
  }
  return {
    ...e,
    metrics,
    recommendations: Object.keys(recommendations).length
      ? recommendations
      : buildRecommendations({
        aiScore,
        industry: e.industry,
        country: e.country,
        channel: e.channel,
        conversionRate: e.conversion_rate,
        replyRate: metrics.replyRate || e.conversion_rate,
        revenue: e.revenue,
        deals: e.deals,
        timing: metrics.timing,
        copyStyle: metrics.copyStyle,
        whyItWorked: null,
      }),
    ai_score: aiScore,
    score_label: label || scoreLabelSafe(aiScore),
    pinned: !!e.pinned,
    archived: !!e.archived,
    ignored: !!e.ignored,
    is_test: !!e.is_test || isTestWorkspace(e.workspace_id),
  };
}

function scoreLabelSafe(score) {
  if (score >= 9) return 'Excellent';
  if (score >= 8) return 'Very Good';
  if (score >= 6.5) return 'Average';
  return 'Weak';
}

async function queryIntelligence(filters = {}) {
  await ensureTables();
  if (driver() !== 'postgres') {
    return { events: [], library: [], total: 0, page: 1, pageSize: 25 };
  }

  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(filters.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const status = String(filters.status || '');
  const showArchived = String(filters.showArchived || '') === 'true' || status === 'archived';
  const showIgnored = String(filters.showIgnored || '') === 'true' || status === 'ignored';
  const showTest = filters.showTest == null ? true : String(filters.showTest) !== 'false';
  const pinnedOnly = String(filters.pinned || '') === 'true' || status === 'pinned';

  const clauses = [];
  const params = [];
  if (!showArchived) clauses.push('COALESCE(archived,FALSE) = FALSE');
  if (!showIgnored) clauses.push('COALESCE(ignored,FALSE) = FALSE');
  if (!showTest) {
    clauses.push(`COALESCE(is_test,FALSE) = FALSE`);
    clauses.push(`workspace_id NOT LIKE 'ws_intel_demo_%'`);
    clauses.push(`LOWER(COALESCE(workspace_id,'')) NOT LIKE '%demo%'`);
    clauses.push(`LOWER(COALESCE(workspace_id,'')) NOT LIKE '%sandbox%'`);
  }
  if (pinnedOnly) clauses.push('COALESCE(pinned,FALSE) = TRUE');
  if (filters.q) {
    params.push(`%${String(filters.q).toLowerCase()}%`);
    clauses.push(`(LOWER(COALESCE(campaign_name,'')) LIKE $${params.length} OR LOWER(COALESCE(customer_name,'')) LIKE $${params.length} OR LOWER(COALESCE(industry,'')) LIKE $${params.length} OR LOWER(COALESCE(workspace_id,'')) LIKE $${params.length})`);
  }
  if (filters.industry) { params.push(filters.industry); clauses.push(`industry = $${params.length}`); }
  if (filters.country) { params.push(filters.country); clauses.push(`country = $${params.length}`); }
  if (filters.workspace) { params.push(filters.workspace); clauses.push(`workspace_id = $${params.length}`); }
  if (filters.channel) { params.push(filters.channel); clauses.push(`channel = $${params.length}`); }
  if (status === 'archived') clauses.push('COALESCE(archived,FALSE) = TRUE');
  if (status === 'ignored') clauses.push('COALESCE(ignored,FALSE) = TRUE');
  if (status === 'active') {
    clauses.push('COALESCE(archived,FALSE) = FALSE');
    clauses.push('COALESCE(ignored,FALSE) = FALSE');
  }
  if (filters.minRevenue != null && filters.minRevenue !== '') {
    params.push(Number(filters.minRevenue) || 0);
    clauses.push(`COALESCE(revenue,0) >= $${params.length}`);
  }
  if (filters.minConversion != null && filters.minConversion !== '') {
    params.push(Number(filters.minConversion) || 0);
    clauses.push(`COALESCE(conversion_rate,0) >= $${params.length}`);
  }
  if (filters.minScore != null && filters.minScore !== '') {
    params.push(Number(filters.minScore) || 0);
    clauses.push(`COALESCE(ai_score,0) >= $${params.length}`);
  }
  if (filters.minReplyRate != null && filters.minReplyRate !== '') {
    params.push(Number(filters.minReplyRate) || 0);
    clauses.push(`COALESCE((metrics->>'replyRate')::float, conversion_rate, 0) >= $${params.length}`);
  }
  if (filters.minAppointments != null && filters.minAppointments !== '') {
    params.push(Number(filters.minAppointments) || 0);
    clauses.push(`COALESCE(meetings,0) >= $${params.length}`);
  }
  if (filters.minLeadQuality != null && filters.minLeadQuality !== '') {
    params.push(Number(filters.minLeadQuality) || 0);
    clauses.push(`COALESCE((metrics->>'leadQuality')::float, 0) >= $${params.length}`);
  }
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    clauses.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    clauses.push(`created_at <= $${params.length}::timestamptz`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sort = String(filters.sort || 'score_desc');
  let orderBy = 'COALESCE(pinned,FALSE) DESC, COALESCE(ai_score,0) DESC NULLS LAST, created_at DESC';
  if (sort === 'revenue_desc') orderBy = 'COALESCE(pinned,FALSE) DESC, COALESCE(revenue,0) DESC, created_at DESC';
  if (sort === 'conversion_desc') orderBy = 'COALESCE(pinned,FALSE) DESC, COALESCE(conversion_rate,0) DESC, created_at DESC';
  if (sort === 'newest') orderBy = 'COALESCE(pinned,FALSE) DESC, created_at DESC';
  if (sort === 'oldest') orderBy = 'COALESCE(pinned,FALSE) DESC, created_at ASC';

  const countSql = `SELECT COUNT(*)::int AS n FROM owner_success_events ${where}`;
  const { rows: countRows } = await query(countSql, params).catch(() => ({ rows: [{ n: 0 }] }));
  const total = countRows[0]?.n || 0;

  params.push(pageSize);
  params.push(offset);
  const { rows } = await query(
    `SELECT * FROM owner_success_events ${where} ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  ).catch(() => ({ rows: [] }));

  const events = rows.map(enrichEventRow);

  // Library with same filter spirit
  const lib = await listCampaignLibrary({
    q: filters.q,
    industry: filters.industry,
    country: filters.country,
    channel: filters.channel,
    workspace: filters.workspace,
    showArchived,
    showIgnored,
    showTest,
    pinnedOnly,
    minRevenue: filters.minRevenue,
    minConversion: filters.minConversion,
    minScore: filters.minScore,
    sort,
    limit: pageSize,
    offset,
  });

  const libraryTotal = lib.total != null ? lib.total : (Array.isArray(lib.items) ? lib.items.length : 0);
  return {
    events,
    library: lib.items || lib,
    libraryTotal,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    libraryTotalPages: Math.max(1, Math.ceil(libraryTotal / pageSize)),
  };
}

async function listCampaignLibrary(opts = {}) {
  await ensureTables();
  if (driver() !== 'postgres') return { items: [], total: 0 };
  const {
    q, industry, country, channel, workspace,
    showArchived = false, showIgnored = false, showTest = true, pinnedOnly = false,
    minRevenue, minConversion, minScore, sort = 'score_desc',
    limit = 50, offset = 0,
  } = opts;

  const clauses = [];
  const params = [];
  if (!showArchived) {
    clauses.push("COALESCE(status,'active') <> 'archived'");
    clauses.push('COALESCE(archived,FALSE) = FALSE');
  }
  if (!showIgnored) clauses.push('COALESCE(ignored,FALSE) = FALSE');
  if (!showTest) {
    clauses.push('COALESCE(is_test,FALSE) = FALSE');
    clauses.push(`workspace_id NOT LIKE 'ws_intel_demo_%'`);
    clauses.push(`LOWER(COALESCE(workspace_id,'')) NOT LIKE '%demo%'`);
    clauses.push(`LOWER(COALESCE(workspace_id,'')) NOT LIKE '%sandbox%'`);
  }
  if (pinnedOnly) clauses.push('COALESCE(pinned,FALSE) = TRUE');
  if (q) {
    params.push(`%${String(q).toLowerCase()}%`);
    clauses.push(`searchable ILIKE $${params.length}`);
  }
  if (industry) { params.push(industry); clauses.push(`industry = $${params.length}`); }
  if (country) { params.push(country); clauses.push(`country = $${params.length}`); }
  if (channel) { params.push(channel); clauses.push(`channel = $${params.length}`); }
  if (workspace) { params.push(workspace); clauses.push(`workspace_id = $${params.length}`); }
  if (minRevenue != null && minRevenue !== '') {
    params.push(Number(minRevenue) || 0);
    clauses.push(`COALESCE(revenue,0) >= $${params.length}`);
  }
  if (minConversion != null && minConversion !== '') {
    params.push(Number(minConversion) || 0);
    clauses.push(`COALESCE(conversion_rate,0) >= $${params.length}`);
  }
  if (minScore != null && minScore !== '') {
    params.push(Number(minScore) || 0);
    clauses.push(`COALESCE(ai_score,0) >= $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  let orderBy = 'COALESCE(pinned,FALSE) DESC, COALESCE(ai_score,0) DESC NULLS LAST, revenue DESC NULLS LAST, created_at DESC';
  if (sort === 'revenue_desc') orderBy = 'COALESCE(pinned,FALSE) DESC, COALESCE(revenue,0) DESC, created_at DESC';
  if (sort === 'conversion_desc') orderBy = 'COALESCE(pinned,FALSE) DESC, COALESCE(conversion_rate,0) DESC, created_at DESC';
  if (sort === 'newest') orderBy = 'COALESCE(pinned,FALSE) DESC, created_at DESC';
  if (sort === 'oldest') orderBy = 'COALESCE(pinned,FALSE) DESC, created_at ASC';

  const countParams = [...params];
  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS n FROM owner_campaign_library ${where}`,
    countParams,
  ).catch(() => ({ rows: [{ n: 0 }] }));
  const total = countRows[0]?.n || 0;

  params.push(Math.min(Number(limit) || 50, 200));
  params.push(Number(offset) || 0);
  const { rows } = await query(
    `SELECT * FROM owner_campaign_library ${where}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  ).catch(() => ({ rows: [] }));

  const items = rows.map((r) => ({
    ...r,
    assets: asJson(r.assets, {}),
    sequences: asJson(r.sequences, {}),
    funnel: asJson(r.funnel, {}),
    timeline: asJson(r.timeline, []),
    prompts: asJson(r.prompts, []),
    recommendations: asJson(r.recommendations, {}),
    pinned: !!r.pinned,
    archived: !!r.archived || r.status === 'archived',
    ignored: !!r.ignored,
    is_test: !!r.is_test || isTestWorkspace(r.workspace_id, r.tags),
    ai_score: Number(r.ai_score) || 0,
    score_label: r.score_label || scoreLabelSafe(Number(r.ai_score) || 0),
  }));
  return { items, total };
}

async function updateSuccessLifecycle(id, action) {
  await ensureTables();
  const map = {
    pin: { pinned: true },
    unpin: { pinned: false },
    archive: { archived: true, status: 'archived' },
    unarchive: { archived: false },
    ignore: { ignored: true },
    unignore: { ignored: false },
  };
  if (action === 'delete') {
    await query('DELETE FROM owner_campaign_library WHERE success_event_id = $1', [id]).catch(() => null);
    await query('DELETE FROM owner_success_events WHERE id = $1', [id]);
    return { deleted: true, id };
  }
  const patch = map[action];
  if (!patch) throw new Error(`Unknown action: ${action}`);
  if (patch.pinned != null) {
    await query('UPDATE owner_success_events SET pinned = $2, updated_at = NOW() WHERE id = $1', [id, patch.pinned]);
    await query('UPDATE owner_campaign_library SET pinned = $2, updated_at = NOW() WHERE success_event_id = $1', [id, patch.pinned]).catch(() => null);
  }
  if (patch.archived != null) {
    await query('UPDATE owner_success_events SET archived = $2, updated_at = NOW() WHERE id = $1', [id, patch.archived]);
    await query(
      `UPDATE owner_campaign_library SET archived = $2, status = $3, updated_at = NOW() WHERE success_event_id = $1`,
      [id, patch.archived, patch.archived ? 'archived' : 'active'],
    ).catch(() => null);
  }
  if (patch.ignored != null) {
    await query('UPDATE owner_success_events SET ignored = $2, updated_at = NOW() WHERE id = $1', [id, patch.ignored]);
    await query('UPDATE owner_campaign_library SET ignored = $2, updated_at = NOW() WHERE success_event_id = $1', [id, patch.ignored]).catch(() => null);
  }
  const { rows } = await query('SELECT * FROM owner_success_events WHERE id = $1 LIMIT 1', [id]);
  return rows[0] ? enrichEventRow(rows[0]) : null;
}

async function updateLibraryLifecycle(id, action) {
  await ensureTables();
  if (action === 'delete') {
    await query('DELETE FROM owner_campaign_library WHERE id = $1', [id]);
    return { deleted: true, id };
  }
  if (action === 'pin') await query('UPDATE owner_campaign_library SET pinned = TRUE, updated_at = NOW() WHERE id = $1', [id]);
  if (action === 'unpin') await query('UPDATE owner_campaign_library SET pinned = FALSE, updated_at = NOW() WHERE id = $1', [id]);
  if (action === 'archive') await query(`UPDATE owner_campaign_library SET archived = TRUE, status = 'archived', updated_at = NOW() WHERE id = $1`, [id]);
  if (action === 'unarchive') await query(`UPDATE owner_campaign_library SET archived = FALSE, status = 'active', updated_at = NOW() WHERE id = $1`, [id]);
  if (action === 'ignore') await query('UPDATE owner_campaign_library SET ignored = TRUE, updated_at = NOW() WHERE id = $1', [id]);
  if (action === 'unignore') await query('UPDATE owner_campaign_library SET ignored = FALSE, updated_at = NOW() WHERE id = $1', [id]);
  return getLibraryItem(id);
}

async function deleteTestIntelligence() {
  await ensureTables();
  const delLib = await query(
    `DELETE FROM owner_campaign_library
     WHERE COALESCE(is_test,FALSE) = TRUE OR workspace_id LIKE 'ws_intel_demo_%'
     RETURNING id`,
  ).catch(() => ({ rows: [] }));
  const delEvt = await query(
    `DELETE FROM owner_success_events
     WHERE COALESCE(is_test,FALSE) = TRUE OR workspace_id LIKE 'ws_intel_demo_%'
     RETURNING id`,
  ).catch(() => ({ rows: [] }));
  return { deletedLibrary: delLib.rows.length, deletedEvents: delEvt.rows.length };
}

async function createLaunchDraft({
  libraryId, channel, targetWorkspaceId, name, subject, body, settings,
} = {}) {
  await ensureTables();
  const src = libraryId ? await getLibraryItem(libraryId) : null;
  if (libraryId && !src) throw new Error('Library item not found');
  const id = `old_${uuidv4()}`;
  const now = new Date().toISOString();
  const seq = asJson(src?.sequences, {});
  const defaultBody = body
    || (Array.isArray(seq.whatsapp) && seq.whatsapp[0])
    || (Array.isArray(seq.email) && seq.email[0])
    || (Array.isArray(seq.aiMessages) && seq.aiMessages[0])
    || src?.why_it_worked
    || '';
  await query(
    `INSERT INTO owner_launch_drafts
     (id, library_id, success_event_id, source_workspace_id, target_workspace_id, channel, name, subject, body, settings, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11,$11)`,
    [
      id,
      libraryId || null,
      src?.success_event_id || null,
      src?.workspace_id || null,
      targetWorkspaceId || null,
      channel || src?.channel || 'email',
      name || (src ? `${src.name} (launch)` : 'Launch draft'),
      subject || `${src?.industry || 'Growth'} outreach`,
      defaultBody,
      JSON.stringify(settings || {}),
      now,
    ],
  );
  return getLaunchDraft(id);
}

async function getLaunchDraft(id) {
  const { rows } = await query('SELECT * FROM owner_launch_drafts WHERE id = $1 LIMIT 1', [id]);
  const r = rows[0];
  if (!r) return null;
  return { ...r, settings: asJson(r.settings, {}) };
}

async function updateLaunchDraft(id, patch = {}) {
  const cur = await getLaunchDraft(id);
  if (!cur) return null;
  const next = {
    channel: patch.channel ?? cur.channel,
    target_workspace_id: patch.targetWorkspaceId ?? cur.target_workspace_id,
    name: patch.name ?? cur.name,
    subject: patch.subject ?? cur.subject,
    body: patch.body ?? cur.body,
    settings: patch.settings
      ? { ...(cur.settings || {}), ...patch.settings }
      : cur.settings,
  };
  await query(
    `UPDATE owner_launch_drafts
     SET channel = $2, target_workspace_id = $3, name = $4, subject = $5, body = $6, settings = $7, updated_at = NOW()
     WHERE id = $1`,
    [id, next.channel, next.target_workspace_id, next.name, next.subject, next.body, JSON.stringify(next.settings || {})],
  );
  return getLaunchDraft(id);
}

async function launchDraft(id) {
  const draft = await getLaunchDraft(id);
  if (!draft) throw new Error('Launch draft not found');
  if (!draft.target_workspace_id) throw new Error('Choose a target workspace before launch');
  if (!draft.channel) throw new Error('Choose a channel before launch');
  if (!draft.body) throw new Error('Message body is required');

  // Create a real outreach draft in the target workspace when possible
  let outreachId = null;
  try {
    outreachId = `draft_${uuidv4()}`;
    await query(
      `INSERT INTO outreach_drafts (id, workspace_id, lead_id, channel, kind, body, subject, status, created_at, updated_at)
       VALUES ($1,$2,'owner_launch',$3,'initial',$4,$5,'draft',NOW(),NOW())`,
      [outreachId, draft.target_workspace_id, draft.channel === 'multi' ? 'email' : draft.channel, draft.body, draft.subject || null],
    );
  } catch (err) {
    // fallback without lead_id constraint variations
    outreachId = null;
    console.warn('[OwnerIntelligence] launch outreach draft:', err.message);
  }

  await query(
    `UPDATE owner_launch_drafts
     SET status = 'launched', launched_at = NOW(), updated_at = NOW(),
         settings = COALESCE(settings,'{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [id, JSON.stringify({ outreachDraftId: outreachId, launchedBy: 'owner_console' })],
  );
  return getLaunchDraft(id);
}

async function listWorkspacesForLaunch() {
  const users = await userStorage.listUsers().catch(() => []);
  return users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.full_name || u.fullName || u.business_name || u.email,
    role: u.role,
  }));
}

async function listLaunchDrafts({ status, limit = 50 } = {}) {
  await ensureTables();
  if (driver() !== 'postgres') return [];
  const params = [];
  const clauses = [];
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  params.push(Math.min(Number(limit) || 50, 200));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM owner_launch_drafts ${where}
     ORDER BY COALESCE(launched_at, created_at) DESC
     LIMIT $${params.length}`,
    params,
  ).catch(() => ({ rows: [] }));
  return rows.map((r) => ({ ...r, settings: asJson(r.settings, {}) }));
}

async function getLaunchDraftOutcomes(id) {
  const draft = await getLaunchDraft(id);
  if (!draft) return null;
  const ws = draft.target_workspace_id;
  let metrics = {
    outbound: 0,
    inbound: 0,
    replies: 0,
    meetings: 0,
    deals: 0,
    revenue: 0,
    leads: 0,
  };
  if (ws && driver() === 'postgres') {
    const since = draft.launched_at || draft.created_at || null;
    try {
      const msg = await query(
        `SELECT
           COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound,
           COUNT(*) FILTER (WHERE direction = 'inbound')::int AS inbound
         FROM messages
         WHERE workspace_id = $1
           AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)`,
        [ws, since],
      );
      metrics.outbound = msg.rows[0]?.outbound || 0;
      metrics.inbound = msg.rows[0]?.inbound || 0;
      metrics.replies = metrics.inbound;
    } catch (_) { /* ignore */ }
    try {
      const camps = await query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('meeting','interested','replied'))::int AS meetings,
           COUNT(*) FILTER (WHERE status IN ('deal','won','closed'))::int AS deals,
           COALESCE(SUM(CASE WHEN status IN ('deal','won','closed') THEN COALESCE(revenue,0) ELSE 0 END),0)::float AS revenue
         FROM campaigns
         WHERE workspace_id = $1
           AND ($2::timestamptz IS NULL OR COALESCE(updated_at, created_at) >= $2::timestamptz)`,
        [ws, since],
      );
      metrics.meetings = camps.rows[0]?.meetings || 0;
      metrics.deals = camps.rows[0]?.deals || 0;
      metrics.revenue = camps.rows[0]?.revenue || 0;
    } catch (_) { /* ignore */ }
    try {
      const leads = await query(
        `SELECT COUNT(*)::int AS n FROM leads
         WHERE workspace_id = $1
           AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)`,
        [ws, since],
      );
      metrics.leads = leads.rows[0]?.n || 0;
    } catch (_) { /* ignore */ }
  }

  let source = null;
  if (draft.library_id) source = await getLibraryItem(draft.library_id);
  else if (draft.success_event_id) {
    const { rows } = await query('SELECT * FROM owner_success_events WHERE id = $1 LIMIT 1', [draft.success_event_id]).catch(() => ({ rows: [] }));
    source = rows[0] ? enrichEventRow(rows[0]) : null;
  }

  const sourceRevenue = Number(source?.revenue) || 0;
  const sourceConv = Number(source?.conversion_rate || source?.conversionRate) || 0;
  return {
    draft,
    source: source ? {
      id: source.id || source.success_event_id,
      name: source.name || source.campaign_name,
      industry: source.industry,
      country: source.country,
      channel: source.channel,
      revenue: sourceRevenue,
      conversionRate: sourceConv,
      aiScore: Number(source.ai_score || source.aiScore) || 0,
    } : null,
    metrics,
    comparison: {
      revenueDelta: metrics.revenue - sourceRevenue,
      replySignal: metrics.replies,
      dealSignal: metrics.deals,
      statusHint: draft.status !== 'launched'
        ? 'Draft not launched yet'
        : metrics.deals > 0
          ? 'Target workspace showing deal activity'
          : metrics.replies > 0
            ? 'Replies detected — monitor conversion'
            : 'Launched — awaiting pipeline activity',
    },
  };
}

async function recomputeScores({ limit = 500 } = {}) {
  await ensureTables();
  if (driver() !== 'postgres') return { updatedEvents: 0, updatedLibrary: 0 };
  const { rows } = await query(
    `SELECT * FROM owner_success_events
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.min(Number(limit) || 500, 2000)],
  ).catch(() => ({ rows: [] }));

  let updatedEvents = 0;
  let updatedLibrary = 0;
  for (const row of rows) {
    const metrics = asJson(row.metrics, {});
    const scored = computeAiScore({
      revenue: row.revenue,
      conversionRate: row.conversion_rate,
      replyRate: metrics.replyRate || row.conversion_rate,
      meetings: row.meetings,
      deals: row.deals,
      leadQuality: metrics.leadQuality || 0,
      messageQuality: inferMessageQuality(metrics),
      timingScore: inferTimingScore(metrics),
      followUpSuccess: (row.meetings > 0 || row.deals > 0) ? 0.8 : 0.2,
    });
    const recs = buildRecommendations({
      aiScore: scored.aiScore,
      industry: row.industry,
      country: row.country,
      channel: row.channel,
      conversionRate: row.conversion_rate,
      replyRate: metrics.replyRate || row.conversion_rate,
      revenue: row.revenue,
      deals: row.deals,
      timing: metrics.timing,
      copyStyle: metrics.copyStyle,
      whyItWorked: null,
    });
    await query(
      `UPDATE owner_success_events
       SET ai_score = $2, score_label = $3, recommendations = $4, is_test = $5, updated_at = NOW()
       WHERE id = $1`,
      [row.id, scored.aiScore, scored.scoreLabel, JSON.stringify(recs), isTestWorkspace(row.workspace_id)],
    );
    updatedEvents += 1;
    const libUp = await query(
      `UPDATE owner_campaign_library
       SET ai_score = $2, score_label = $3, recommendations = $4, is_test = $5,
           reply_rate = COALESCE($6, reply_rate), lead_quality = COALESCE($7, lead_quality), updated_at = NOW()
       WHERE success_event_id = $1
       RETURNING id`,
      [
        row.id,
        scored.aiScore,
        scored.scoreLabel,
        JSON.stringify(recs),
        isTestWorkspace(row.workspace_id),
        metrics.replyRate || null,
        metrics.leadQuality || null,
      ],
    ).catch(() => ({ rows: [] }));
    if (libUp.rows.length) updatedLibrary += 1;
  }
  return { updatedEvents, updatedLibrary, scanned: rows.length };
}

async function bulkUpdateSuccessLifecycle(ids, action) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!list.length) throw new Error('ids required');
  if (action === 'delete' && list.length > 50) throw new Error('Delete bulk limited to 50 ids');
  const results = [];
  for (const id of list) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await updateSuccessLifecycle(id, action));
  }
  return { action, count: results.length, results };
}

async function bulkUpdateLibraryLifecycle(ids, action) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!list.length) throw new Error('ids required');
  if (action === 'delete' && list.length > 50) throw new Error('Delete bulk limited to 50 ids');
  const results = [];
  for (const id of list) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await updateLibraryLifecycle(id, action));
  }
  return { action, count: results.length, results };
}

async function getIntelligenceFacets() {
  await ensureTables();
  if (driver() !== 'postgres') {
    return { industries: [], countries: [], workspaces: [], channels: [] };
  }
  const [ind, cty, ws, ch] = await Promise.all([
    query(`SELECT DISTINCT industry AS v FROM owner_success_events WHERE industry IS NOT NULL AND industry <> '' ORDER BY 1 LIMIT 200`).catch(() => ({ rows: [] })),
    query(`SELECT DISTINCT country AS v FROM owner_success_events WHERE country IS NOT NULL AND country <> '' ORDER BY 1 LIMIT 200`).catch(() => ({ rows: [] })),
    query(`SELECT DISTINCT workspace_id AS v FROM owner_success_events WHERE workspace_id IS NOT NULL ORDER BY 1 LIMIT 200`).catch(() => ({ rows: [] })),
    query(`SELECT DISTINCT channel AS v FROM owner_success_events WHERE channel IS NOT NULL AND channel <> '' ORDER BY 1 LIMIT 50`).catch(() => ({ rows: [] })),
  ]);
  return {
    industries: ind.rows.map((r) => r.v),
    countries: cty.rows.map((r) => r.v),
    workspaces: ws.rows.map((r) => r.v),
    channels: ch.rows.map((r) => r.v),
  };
}

module.exports = {
  scanAndNotify,
  listSuccessEvents,
  getCampaignIntelligence,
  getPatternInsights,
  getSuccessFeed,
  listCampaignLibrary,
  getLibraryItem,
  duplicateLibraryItem,
  ensureTables,
  queryIntelligence,
  updateSuccessLifecycle,
  updateLibraryLifecycle,
  deleteTestIntelligence,
  createLaunchDraft,
  getLaunchDraft,
  updateLaunchDraft,
  launchDraft,
  listWorkspacesForLaunch,
  listLaunchDrafts,
  getLaunchDraftOutcomes,
  recomputeScores,
  bulkUpdateSuccessLifecycle,
  bulkUpdateLibraryLifecycle,
  getIntelligenceFacets,
  enrichEventRow,
  insertSuccessEvent,
  fingerprintExists,
};
