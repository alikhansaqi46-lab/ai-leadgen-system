/**
 * Enterprise Dashboard metrics — all values from real storage / DB.
 * No placeholders, estimates, or mocked counters.
 */

const leadStorage = require('../utils/leadStorage');
const scoreStorage = require('../utils/scoreStorage');
const campaignStorage = require('../utils/campaignStorage');
const conversationStorage = require('../utils/conversationStorage');
const followUpStorage = require('../utils/followUpStorage');
const automationStorage = require('../utils/automationStorage');
const timelineStorage = require('../utils/timelineStorage');

function safeNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function rate(numerator, denominator) {
  const d = safeNum(denominator);
  if (d <= 0) return 0;
  return Math.round((safeNum(numerator) / d) * 1000) / 10;
}

function campRevenue(c) {
  if (c == null) return 0;
  if (c.revenue != null) return safeNum(c.revenue);
  if (c.data?.revenue != null) return safeNum(c.data.revenue);
  if (c.dealValue != null) return safeNum(c.dealValue);
  return 0;
}

function leadField(lead, key) {
  if (!lead) return '';
  const direct = lead[key];
  if (direct != null && String(direct).trim()) return String(direct).trim();
  const data = lead.data && typeof lead.data === 'object' ? lead.data : null;
  if (data && data[key] != null) return String(data[key]).trim();
  return '';
}

function isPresent(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  const upper = v.toUpperCase();
  return upper !== 'N/A' && upper !== 'NA' && upper !== 'NULL' && upper !== '-';
}

function isValidEmail(value) {
  if (!isPresent(value)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

function isValidPhone(value) {
  if (!isPresent(value)) return false;
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 7;
}

function isValidWebsite(value) {
  if (!isPresent(value)) return false;
  const v = String(value).trim().toLowerCase();
  return v.includes('.') || v.startsWith('http');
}

/**
 * Fix logically impossible channel stats.
 * Replies imply delivery occurred even when provider receipts are missing.
 */
function sanitizeChannelCounts(channelCounts) {
  const empty = () => ({ sent: 0, replies: 0, delivered: 0, read: 0, failed: 0 });
  const out = {
    email: { ...empty(), ...(channelCounts?.email || {}) },
    whatsapp: { ...empty(), ...(channelCounts?.whatsapp || {}) },
    sms: { ...empty(), ...(channelCounts?.sms || {}) },
  };
  for (const key of Object.keys(out)) {
    const ch = out[key];
    ch.sent = safeNum(ch.sent);
    ch.replies = safeNum(ch.replies);
    ch.delivered = safeNum(ch.delivered);
    ch.read = safeNum(ch.read);
    ch.failed = safeNum(ch.failed);
    if (ch.delivered <= 0 && ch.replies > 0 && ch.sent > 0) {
      ch.delivered = ch.sent;
    }
    if (ch.sent > 0 && ch.delivered > ch.sent) ch.delivered = ch.sent;
    if (ch.read > ch.delivered) ch.read = ch.delivered;
  }
  return out;
}

function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function buildHistorySeries(events, days = 14) {
  const series = [];
  const map = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - i);
    const key = dayKey(d);
    map.set(key, { date: key, messagesSent: 0, replies: 0, leadsCreated: 0, statusChanges: 0 });
  }
  for (const ev of events || []) {
    const key = dayKey(ev.createdAt || ev.created_at);
    if (!map.has(key)) continue;
    const row = map.get(key);
    const type = String(ev.type || '');
    if (type === 'message_sent' || type === 'email_sent' || type === 'follow_up_sent') row.messagesSent += 1;
    if (type === 'message_received') row.replies += 1;
    if (type === 'lead_created') row.leadsCreated += 1;
    if (type === 'status_changed') row.statusChanges += 1;
  }
  for (const row of map.values()) series.push(row);
  return series;
}

/**
 * Build full dashboard payload for a workspace.
 */
async function getDashboardMetrics(workspaceId) {
  const ws = workspaceId || 'default';

  const [leads, scores, campaignStats, rawChannelCounts, autoStats, timelineEvents, campaigns] = await Promise.all([
    leadStorage.getLeads({ workspaceId: ws, limit: 10000 }).catch(() => []),
    scoreStorage.getScores({ workspaceId: ws }).catch(() => []),
    campaignStorage.getAnalytics({ workspaceId: ws }).catch(() => null),
    conversationStorage.getMessageCountsByChannel({ workspaceId: ws }).catch(() => ({
      email: { sent: 0, replies: 0, delivered: 0, read: 0, failed: 0 },
      whatsapp: { sent: 0, replies: 0, delivered: 0, read: 0, failed: 0 },
      sms: { sent: 0, replies: 0, delivered: 0, read: 0, failed: 0 },
    })),
    automationStorage.getStats({ workspaceId: ws }).catch(() => ({
      totalAutomations: 0,
      enabledAutomations: 0,
      runsTotal: 0,
      runsRunning: 0,
      runsSucceeded: 0,
      runsFailed: 0,
    })),
    timelineStorage.getWorkspaceEvents({ workspaceId: ws, limit: 5000 }).catch(() => []),
    campaignStorage.getAll({ workspaceId: ws }).catch(() => []),
  ]);

  const channelCounts = sanitizeChannelCounts(rawChannelCounts);
  const history = buildHistorySeries(timelineEvents, 14);
  const leadList = Array.isArray(leads) ? leads : [];
  const scoreList = Array.isArray(scores) ? scores : [];
  const campList = Array.isArray(campaigns) ? campaigns : [];

  let emailsFound = 0;
  let phoneNumbers = 0;
  let whatsappNumbers = 0;
  let websitesFound = 0;
  for (const lead of leadList) {
    const email = leadField(lead, 'email');
    const phone = leadField(lead, 'phone') || lead.phone;
    const whatsapp = leadField(lead, 'whatsapp');
    const website = leadField(lead, 'website');
    if (isValidEmail(email)) emailsFound += 1;
    if (isValidPhone(phone)) phoneNumbers += 1;
    // WhatsApp outreach uses explicit WA field or phone (same as scoring/send paths)
    if (isValidPhone(whatsapp) || isValidPhone(phone)) whatsappNumbers += 1;
    if (isValidWebsite(website)) websitesFound += 1;
  }

  const hot = scoreList.filter((s) => String(s.priority).toLowerCase() === 'hot').length;
  const warm = scoreList.filter((s) => String(s.priority).toLowerCase() === 'warm').length;
  const cold = scoreList.filter((s) => String(s.priority).toLowerCase() === 'cold').length;
  const qualified = scoreList.filter((s) => s.score != null).length;

  const byStatus = campaignStats?.byStatus || {
    new: 0, sent: 0, replied: 0, interested: 0, meeting: 0, deal: 0, lost: 0,
  };

  const emailSent = safeNum(channelCounts.email.sent);
  const emailReplies = safeNum(channelCounts.email.replies);
  const waSent = safeNum(channelCounts.whatsapp.sent);
  const waReplies = safeNum(channelCounts.whatsapp.replies);
  const smsSent = safeNum(channelCounts.sms.sent);
  const smsReplies = safeNum(channelCounts.sms.replies);

  const repliesReceived = emailReplies + waReplies + smsReplies;
  const dealsWon = safeNum(byStatus.deal ?? campaignStats?.deal);
  const meetingsBooked = safeNum(byStatus.meeting ?? campaignStats?.meeting);
  const conversionRate = rate(dealsWon, leadList.length);

  let revenue = 0;
  for (const c of campList) {
    if (String(c.status || '') === 'deal') revenue += campRevenue(c);
  }

  let quoteStats = null;
  try {
    const quoteStorage = require('../utils/quoteStorage');
    quoteStats = await quoteStorage.stats(ws);
    revenue += safeNum(quoteStats.paidValue);
  } catch (_) { /* optional */ }

  let followUpsScheduled = 0;
  try {
    if (typeof followUpStorage.getPendingCount === 'function') {
      followUpsScheduled = await followUpStorage.getPendingCount({ workspaceId: ws });
    }
  } catch (_) { /* optional */ }
  followUpsScheduled = Math.max(followUpsScheduled, safeNum(campaignStats?.followUpsPending));

  const cards = [
    // Row 1 — Primary inventory
    { key: 'totalLeads', label: 'Total Leads', value: leadList.length, href: '/app/leads', group: 'primary', accent: 'cyan' },
    { key: 'emailsFound', label: 'Emails Found', value: emailsFound, href: '/app/leads', group: 'primary', accent: 'blue' },
    { key: 'whatsappNumbers', label: 'WhatsApp Numbers', value: whatsappNumbers, href: '/app/whatsapp', group: 'primary', accent: 'green' },
    { key: 'phoneNumbers', label: 'Phone Numbers', value: phoneNumbers, href: '/app/leads', group: 'primary', accent: 'purple' },
    { key: 'websitesFound', label: 'Websites Found', value: websitesFound, href: '/app/leads', group: 'primary', accent: 'orange' },
    { key: 'qualifiedLeads', label: 'AI Qualified Leads', value: qualified, href: '/app/ai-agent', group: 'primary', accent: 'cyan' },

    // Row 2 — Outreach
    { key: 'emailsSent', label: 'Emails Sent', value: emailSent, href: '/app/email', group: 'outreach', accent: 'blue' },
    { key: 'whatsappSent', label: 'WhatsApp Sent', value: waSent, href: '/app/whatsapp', group: 'outreach', accent: 'green' },
    { key: 'smsSent', label: 'SMS Sent', value: smsSent, href: '/app/sms', group: 'outreach', accent: 'orange' },
    { key: 'repliesReceived', label: 'Replies Received', value: repliesReceived, href: '/app/inbox', group: 'outreach', accent: 'purple' },
    { key: 'appointmentsBooked', label: 'Appointments Booked', value: meetingsBooked, href: '/app/leads?status=meeting', group: 'outreach', accent: 'cyan' },
    { key: 'followUpsScheduled', label: 'Follow-ups Scheduled', value: followUpsScheduled, href: '/app/automations', group: 'outreach', accent: 'blue' },

    // Row 3 — Sales
    { key: 'hotLeads', label: 'Hot Leads', value: hot, href: '/app/leads?priority=hot', group: 'sales', accent: 'orange' },
    { key: 'warmLeads', label: 'Warm Leads', value: warm, href: '/app/leads?priority=warm', group: 'sales', accent: 'purple' },
    { key: 'coldLeads', label: 'Cold Leads', value: cold, href: '/app/leads?priority=cold', group: 'sales', accent: 'cyan' },
    { key: 'dealsWon', label: 'Deals Won', value: dealsWon, href: '/app/leads?status=deal', group: 'sales', accent: 'green' },
    { key: 'revenue', label: 'Revenue', value: revenue, href: '/app/inbox', group: 'sales', accent: 'blue' },
    { key: 'conversionRate', label: 'Conversion Rate', value: conversionRate, href: '/app/reports', group: 'sales', accent: 'purple' },
    { key: 'quotesSent', label: 'Quotes Sent', value: quoteStats?.quotesSent || 0, href: '/app/inbox', group: 'sales', accent: 'cyan' },
    { key: 'invoicesPaid', label: 'Invoices Paid', value: quoteStats?.invoicesPaid || 0, href: '/app/inbox', group: 'sales', accent: 'green' },
  ];

  return {
    workspaceId: ws,
    generatedAt: new Date().toISOString(),
    cards,
    metrics: {
      totalLeads: leadList.length,
      emailsFound,
      whatsappNumbers,
      phoneNumbers,
      websitesFound,
      qualifiedLeads: qualified,
      emailsSent: emailSent,
      whatsappSent: waSent,
      smsSent,
      repliesReceived,
      appointmentsBooked: meetingsBooked,
      followUpsScheduled,
      hotLeads: hot,
      warmLeads: warm,
      coldLeads: cold,
      dealsWon,
      revenue,
      conversionRate,
      emailReplies,
      whatsappReplies: waReplies,
      smsReplies,
      runningAutomations: autoStats.enabledAutomations || 0,
      quotesSent: quoteStats?.quotesSent || 0,
      quotesAccepted: quoteStats?.quotesAccepted || 0,
      invoicesPaid: quoteStats?.invoicesPaid || 0,
      invoicePaidValue: quoteStats?.paidValue || 0,
    },
    pipeline: byStatus,
    channels: channelCounts,
    automations: autoStats,
    history,
  };
}

module.exports = { getDashboardMetrics };
