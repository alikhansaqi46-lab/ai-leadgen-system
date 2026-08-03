/**
 * Platform-wide Super Admin metrics (cross-tenant).
 */

const { query } = require('../config/db');
const userStorage = require('../utils/userStorage');
const adminAudit = require('../utils/adminAudit');
const conversationStorage = require('../utils/conversationStorage');
const axios = require('axios');
const tls = require('tls');
const { URL } = require('url');

/** No hardcoded plan prices — amounts come from payment ledger. */

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfWeek(d = new Date()) {
  const x = startOfDay(d);
  const day = x.getDay();
  x.setDate(x.getDate() - day);
  return x;
}

function startOfMonth(d = new Date()) {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}

function startOfYear(d = new Date()) {
  const x = startOfDay(d);
  x.setMonth(0, 1);
  return x;
}

function pctChange(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p === 0) return c > 0 ? 100 : 0;
  return Math.round(((c - p) / p) * 1000) / 10;
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const ms = new Date(a).getTime() - new Date(b).getTime();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

async function listAllUsers() {
  if (typeof userStorage.listUsers === 'function') {
    return userStorage.listUsers();
  }
  return [];
}

function isPaidPlan(plan) {
  return ['starter', 'pro', 'agency'].includes(String(plan || '').toLowerCase());
}

function isActiveSub(u) {
  return String(u.subscription_status || u.subscriptionStatus || '').toLowerCase() === 'active';
}

function isTrial(u) {
  const status = String(u.subscription_status || u.subscriptionStatus || '').toLowerCase();
  const plan = String(u.subscription_plan || u.subscriptionPlan || '').toLowerCase();
  return status === 'pending' || plan === 'trial' || status === 'trialing';
}

async function getBusinessOverview() {
  const users = await listAllUsers();
  const now = new Date();
  const today = startOfDay(now);
  const week = startOfWeek(now);
  const month = startOfMonth(now);

  let activeSubscribers = 0;
  let expiredSubscribers = 0;
  let newToday = 0;
  let newWeek = 0;
  let newMonth = 0;
  let freeUsers = 0;
  let paidUsers = 0;
  let trialUsers = 0;
  let cancelledUsers = 0;

  for (const u of users) {
    const created = u.created_at || u.createdAt ? new Date(u.created_at || u.createdAt) : null;
    const status = String(u.subscription_status || u.subscriptionStatus || 'none').toLowerCase();
    const plan = String(u.subscription_plan || u.subscriptionPlan || '').toLowerCase();
    const expires = u.subscription_expires_at || u.subscriptionExpiresAt;

    if (status === 'active' && isPaidPlan(plan)) activeSubscribers += 1;
    if (status === 'active' && expires && new Date(expires) < now) expiredSubscribers += 1;
    if (status === 'cancelled' || status === 'canceled') cancelledUsers += 1;
    if (isTrial(u)) trialUsers += 1;

    if (isPaidPlan(plan) && status === 'active') paidUsers += 1;
    else if (u.role !== 'super_admin') freeUsers += 1;

    if (created) {
      if (created >= today) newToday += 1;
      if (created >= week) newWeek += 1;
      if (created >= month) newMonth += 1;
    }
  }

  return {
    totalUsers: users.length,
    totalCustomers: users.filter((u) => String(u.role || '').toLowerCase() !== 'super_admin').length,
    activeCustomers: activeSubscribers,
    activeSubscribers,
    expiredSubscribers,
    newCustomersToday: newToday,
    newSubscribersToday: newToday,
    newSubscribersThisWeek: newWeek,
    newSubscribersThisMonth: newMonth,
    freeUsers,
    paidUsers,
    trialUsers,
    cancelledUsers,
    // Churn / retention among customers who have (or had) paid subscription intent
    churnRate: round1(
      (activeSubscribers + cancelledUsers) > 0
        ? (cancelledUsers / (activeSubscribers + cancelledUsers)) * 100
        : 0,
    ),
    retentionRate: round1(
      (activeSubscribers + cancelledUsers) > 0
        ? (activeSubscribers / (activeSubscribers + cancelledUsers)) * 100
        : 100,
    ),
  };
}

async function getRevenueAnalytics() {
  const users = await listAllUsers();
  const payments = await adminAudit.listPaymentEvents(2000);
  const now = new Date();
  const today = startOfDay(now);
  const month = startOfMonth(now);

  // Derive plan prices ONLY from real payment events (latest positive amount per plan).
  const planPriceFromLedger = {};
  for (const p of payments) {
    const amount = Number(p.amount) || 0;
    const plan = String(p.plan_key || p.planKey || '').toLowerCase();
    const status = String(p.status || '').toLowerCase();
    const type = String(p.event_type || p.eventType || '').toLowerCase();
    if (!plan || amount <= 0) continue;
    if (status === 'failed' || status === 'refunded' || type.includes('fail') || type.includes('refund')) continue;
    const created = new Date(p.created_at || p.createdAt || 0).getTime();
    const prev = planPriceFromLedger[plan];
    if (!prev || created >= prev.at) {
      planPriceFromLedger[plan] = { amount, at: created };
    }
  }

  // Per-user recurring estimate: latest successful payment for that user, else plan ledger price.
  let mrr = 0;
  const mrrBreakdown = [];
  for (const u of users) {
    if (!isActiveSub(u)) continue;
    const uid = u.id;
    const plan = String(u.subscription_plan || u.subscriptionPlan || '').toLowerCase();
    const userPayments = payments
      .filter((p) => (p.user_id || p.userId) === uid && Number(p.amount) > 0)
      .sort((a, b) => new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0));
    const latestUserPay = userPayments[0];
    let amount = latestUserPay ? Number(latestUserPay.amount) || 0 : 0;
    if (!amount && plan && planPriceFromLedger[plan]) amount = planPriceFromLedger[plan].amount;
    if (amount > 0) {
      mrr += amount;
      mrrBreakdown.push({ userId: uid, email: u.email, plan, amount });
    }
  }

  let totalRevenue = 0;
  let monthlyRevenue = 0;
  let dailyRevenue = 0;
  let yearlyRevenue = 0;
  let previousMonthRevenue = 0;
  let renewals = 0;
  let failedPayments = 0;
  let pendingPayments = 0;
  let refunds = 0;
  const graphMap = {};
  const year = startOfYear(now);
  const prevMonthStart = startOfMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1));
  const prevMonthEnd = month;

  for (const p of payments) {
    const amount = Number(p.amount) || 0;
    const created = new Date(p.created_at || p.createdAt || 0);
    const type = String(p.event_type || p.eventType || '').toLowerCase();
    const status = String(p.status || '').toLowerCase();

    if (type.includes('refund') || status === 'refunded') {
      refunds += 1;
      continue;
    }
    if (type.includes('fail') || status === 'failed') {
      failedPayments += 1;
      continue;
    }
    if (type.includes('pending') || status === 'pending') {
      pendingPayments += 1;
    }
    if (type.includes('renew') || type.includes('payment.sale') || type.includes('subscription')) {
      if (amount > 0 || type.includes('renew')) renewals += 1;
    }
    if (amount > 0 && (status === 'completed' || status === 'success' || type.includes('completed') || type.includes('activated'))) {
      totalRevenue += amount;
      if (created >= year) yearlyRevenue += amount;
      if (created >= month) monthlyRevenue += amount;
      if (created >= today) dailyRevenue += amount;
      if (created >= prevMonthStart && created < prevMonthEnd) previousMonthRevenue += amount;
      const key = created.toISOString().slice(0, 10);
      graphMap[key] = (graphMap[key] || 0) + amount;
    }
  }

  const graph = [];
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    graph.push({ date: key, revenue: graphMap[key] || 0 });
  }

  const arr = Math.round(mrr * 12 * 100) / 100;

  return {
    totalRevenue,
    monthlyRevenue,
    dailyRevenue,
    yearlyRevenue,
    previousMonthRevenue,
    monthlyGrowthPct: pctChange(monthlyRevenue, previousMonthRevenue),
    mrr,
    arr,
    revenueGraph: graph,
    subscriptionRenewals: renewals,
    failedPayments,
    pendingPayments,
    refunds,
    estimated: false,
    pricingSource: 'payment_ledger',
    planPricesFromLedger: Object.fromEntries(
      Object.entries(planPriceFromLedger).map(([k, v]) => [k, v.amount]),
    ),
    mrrBreakdown,
  };
}

async function getLeadAnalytics() {
  try {
    if (userStorage.resolveDriver() === 'postgres') {
      const leads = await query(`SELECT COUNT(*)::int AS c FROM leads`);
      const camps = await query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('interested','meeting','deal'))::int AS qualified,
          COUNT(*) FILTER (WHERE status = 'meeting')::int AS meetings,
          COUNT(*) FILTER (WHERE status = 'deal')::int AS deals,
          COUNT(*)::int AS total
        FROM campaigns
      `);
      const totalLeads = leads.rows[0]?.c || 0;
      const qualified = camps.rows[0]?.qualified || 0;
      const meetings = camps.rows[0]?.meetings || 0;
      const deals = camps.rows[0]?.deals || 0;
      const campTotal = camps.rows[0]?.total || 0;
      return {
        leadsScraped: totalLeads,
        qualifiedLeads: qualified,
        conversionRate: campTotal > 0 ? Math.round((deals / campTotal) * 1000) / 10 : 0,
        appointmentsBooked: meetings,
        dealsWon: deals,
      };
    }
  } catch (err) {
    console.warn('[AdminMetrics] lead analytics:', err.message);
  }
  return {
    leadsScraped: 0,
    qualifiedLeads: 0,
    conversionRate: 0,
    appointmentsBooked: 0,
    dealsWon: 0,
  };
}

async function getChannelAnalytics() {
  const wa = {
    connectedNumbers: 0, campaignsSent: 0, delivered: 0, replies: 0, failed: 0, queued: 0,
    manualSent: 0, aiSent: 0, totalOutbound: 0,
  };
  const email = {
    sent: 0, delivered: 0, openRate: 0, clickRate: 0, bounceRate: 0, replies: 0,
    manualSent: 0, aiSent: 0, totalOutbound: 0,
  };
  const sms = {
    sent: 0, delivered: 0, replies: 0, failed: 0,
    manualSent: 0, aiSent: 0, totalOutbound: 0,
  };
  try {
    if (userStorage.resolveDriver() === 'postgres') {
      const waConn = await query(`
        SELECT COUNT(*)::int AS c FROM integrations
        WHERE provider = 'whatsapp' AND connected = TRUE
      `).catch(() => ({ rows: [{ c: 0 }] }));
      wa.connectedNumbers = waConn.rows[0]?.c || 0;

      const msg = await query(`
        SELECT channel, direction, COALESCE(status,'sent') AS status,
               COALESCE(source,'') AS source, COUNT(*)::int AS c
        FROM messages
        GROUP BY channel, direction, COALESCE(status,'sent'), COALESCE(source,'')
      `);
      for (const row of msg.rows) {
        const n = row.c || 0;
        const src = String(row.source || '').toLowerCase();
        const isAi = /ai|openai|auto|bot|draft/.test(src);
        const isManual = !isAi && (src === 'manual' || src === '' || src === 'outbound' || src === 'user');

        const bucket = row.channel === 'whatsapp' ? wa
          : row.channel === 'email' ? email
            : row.channel === 'sms' ? sms
              : null;
        if (!bucket) continue;

        if (row.direction === 'outbound') {
          bucket.totalOutbound = (bucket.totalOutbound || 0) + n;
          if (isAi) bucket.aiSent = (bucket.aiSent || 0) + n;
          else if (isManual) bucket.manualSent = (bucket.manualSent || 0) + n;
          else bucket.manualSent = (bucket.manualSent || 0) + n;

          if (row.channel === 'whatsapp') {
            wa.campaignsSent += n;
            const st = String(row.status).toLowerCase();
            if (st === 'delivered' || st === 'read') wa.delivered += n;
            if (st === 'failed' || st === 'undelivered') wa.failed += n;
            if (st === 'queued' || st === 'pending') wa.queued += n;
          }
          if (row.channel === 'email') {
            email.sent += n;
            const st = String(row.status).toLowerCase();
            if (st === 'delivered' || st === 'opened' || st === 'clicked' || st === 'read') email.delivered += n;
            if (st === 'opened' || st === 'read') email.openRate += n;
            if (st === 'clicked') email.clickRate += n;
            if (st === 'bounced' || st === 'bounce') email.bounceRate += n;
          }
          if (row.channel === 'sms') {
            sms.sent += n;
            const st = String(row.status).toLowerCase();
            if (st === 'delivered' || st === 'read') sms.delivered += n;
            if (st === 'failed' || st === 'undelivered') sms.failed += n;
          }
        } else {
          if (row.channel === 'whatsapp') wa.replies += n;
          if (row.channel === 'email') email.replies += n;
          if (row.channel === 'sms') sms.replies += n;
        }
      }
      if (email.sent > 0) {
        email.openRate = Math.round((email.openRate / email.sent) * 1000) / 10;
        email.clickRate = Math.round((email.clickRate / email.sent) * 1000) / 10;
        email.bounceRate = Math.round((email.bounceRate / email.sent) * 1000) / 10;
      }
    } else {
      const counts = await conversationStorage.getMessageCountsByChannel({ workspaceId: 'default' });
      wa.campaignsSent = counts.whatsapp?.sent || 0;
      wa.totalOutbound = wa.campaignsSent;
      wa.delivered = counts.whatsapp?.delivered || 0;
      wa.replies = counts.whatsapp?.replies || 0;
      wa.failed = counts.whatsapp?.failed || 0;
      email.sent = counts.email?.sent || 0;
      email.totalOutbound = email.sent;
      email.delivered = counts.email?.delivered || 0;
    }
  } catch (err) {
    console.warn('[AdminMetrics] channel analytics:', err.message);
  }
  return {
    whatsapp: wa,
    email,
    sms,
    totals: {
      totalOutbound: (wa.totalOutbound || 0) + (email.totalOutbound || 0) + (sms.totalOutbound || 0),
      manualSent: (wa.manualSent || 0) + (email.manualSent || 0) + (sms.manualSent || 0),
      aiSent: (wa.aiSent || 0) + (email.aiSent || 0) + (sms.aiSent || 0),
    },
  };
}

async function getAiUsage() {
  const users = await listAllUsers();
  let remainingCredits = 0;
  let usersOnMaster = 0;
  for (const u of users) {
    remainingCredits += Number(u.free_ai_messages_remaining ?? u.freeAiMessagesRemaining ?? 0) || 0;
    if ((u.openai_source || u.openaiSource || 'master') === 'master') usersOnMaster += 1;
  }

  let requestsToday = 0;
  let aiMessages = 0;
  let aiErrors = 0;
  try {
    if (userStorage.resolveDriver() === 'postgres') {
      const today = startOfDay().toISOString();
      const r = await query(`
        SELECT COUNT(*)::int AS c FROM messages
        WHERE direction = 'outbound' AND created_at >= $1
          AND (source ILIKE '%ai%' OR metadata::text ILIKE '%openai%' OR metadata::text ILIKE '%ai%')
      `, [today]).catch(() => ({ rows: [{ c: 0 }] }));
      requestsToday = r.rows[0]?.c || 0;
      const all = await query(`
        SELECT COUNT(*)::int AS c FROM messages
        WHERE direction = 'outbound'
          AND (source ILIKE '%ai%' OR metadata::text ILIKE '%openai%')
      `).catch(() => ({ rows: [{ c: 0 }] }));
      aiMessages = all.rows[0]?.c || 0;
    }
  } catch (_) { /* ignore */ }

  const errors = await adminAudit.listErrorLogs(200);
  aiErrors = errors.filter((e) => /openai|ai/i.test(String(e.source || '') + String(e.message || ''))).length;

  // Rough cost estimate: $0.002 per AI message (configurable)
  const costPerMsg = Number(process.env.ADMIN_AI_COST_PER_MSG || 0.002);
  return {
    remainingCredits,
    usersOnMaster,
    requestsPerDay: requestsToday,
    aiMessages,
    aiErrors,
    estimatedCostUsd: Math.round(aiMessages * costPerMsg * 100) / 100,
    tokenUsageNote: 'Token-level usage requires OpenAI org usage API; showing message-level estimates from DB.',
  };
}

async function probeUrl(url, timeout = 5000) {
  if (!url) return { status: 'unconfigured', latencyMs: null, detail: 'Not configured' };
  const started = Date.now();
  try {
    const res = await axios.get(url, { timeout, validateStatus: () => true });
    const ok = res.status >= 200 && res.status < 400;
    return {
      status: ok ? 'online' : 'degraded',
      latencyMs: Date.now() - started,
      detail: ok ? `HTTP ${res.status}` : `HTTP ${res.status}`,
    };
  } catch (err) {
    return { status: 'offline', latencyMs: Date.now() - started, detail: err.message };
  }
}

async function probeSsl(hostname) {
  if (!hostname) return { status: 'unconfigured', detail: 'No hostname' };
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, rejectUnauthorized: true }, () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
      const daysLeft = validTo ? Math.ceil((validTo.getTime() - Date.now()) / 86400000) : null;
      socket.end();
      if (daysLeft != null && daysLeft < 0) {
        resolve({ status: 'offline', latencyMs: Date.now() - started, detail: 'Certificate expired' });
      } else if (daysLeft != null && daysLeft < 14) {
        resolve({ status: 'degraded', latencyMs: Date.now() - started, detail: `Cert expires in ${daysLeft}d` });
      } else {
        resolve({ status: 'online', latencyMs: Date.now() - started, detail: validTo ? `Valid until ${validTo.toISOString().slice(0, 10)}` : 'TLS handshake OK' });
      }
    });
    socket.setTimeout(8000, () => {
      socket.destroy();
      resolve({ status: 'offline', latencyMs: Date.now() - started, detail: 'TLS timeout' });
    });
    socket.on('error', (err) => {
      resolve({ status: 'offline', latencyMs: Date.now() - started, detail: err.message });
    });
  });
}

async function probeSmtp() {
  const user = process.env.EMAIL_USER || process.env.SMTP_USER;
  const pass = process.env.EMAIL_PASS || process.env.SMTP_PASS;
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 465);
  if (!user || !pass) {
    return { status: 'unconfigured', detail: 'EMAIL_USER / SMTP credentials not set' };
  }
  try {
    const nodemailer = require('nodemailer');
    const { getTlsOptions } = require('../config/tls');
    const started = Date.now();
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      tls: getTlsOptions(),
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 8000,
    });
    await transporter.verify();
    return { status: 'online', latencyMs: Date.now() - started, detail: `SMTP handshake OK (${host})` };
  } catch (err) {
    return { status: 'offline', detail: err.message };
  }
}

async function probeTwilio() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    return { status: 'unconfigured', detail: 'Twilio env missing' };
  }
  const started = Date.now();
  try {
    const res = await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      auth: { username: sid, password: token },
      timeout: 8000,
      validateStatus: () => true,
    });
    if (res.status === 200) {
      return { status: 'online', latencyMs: Date.now() - started, detail: `Account ${res.data?.status || 'active'}` };
    }
    return { status: 'offline', latencyMs: Date.now() - started, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { status: 'offline', latencyMs: Date.now() - started, detail: err.message };
  }
}

async function getSystemHealth() {
  const checks = {};

  // OpenAI
  const oaKey = process.env.OPENAI_API_KEY || process.env.MASTER_OPENAI_API_KEY;
  if (!oaKey) checks.openai = { status: 'unconfigured', detail: 'OPENAI_API_KEY missing' };
  else {
    try {
      const started = Date.now();
      const res = await axios.get('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${oaKey}` },
        timeout: 8000,
        validateStatus: () => true,
      });
      checks.openai = res.status === 200
        ? { status: 'online', latencyMs: Date.now() - started, detail: 'Models API OK' }
        : { status: 'offline', latencyMs: Date.now() - started, detail: `HTTP ${res.status}` };
    } catch (err) {
      checks.openai = { status: 'offline', detail: err.message };
    }
  }

  // SerpAPI — require HTTP 200
  const serp = process.env.SERP_API_KEY || process.env.SERPAPI_KEY;
  if (!serp) checks.serpapi = { status: 'unconfigured', detail: 'SERP_API_KEY missing' };
  else {
    const started = Date.now();
    try {
      const res = await axios.get(`https://serpapi.com/account?api_key=${serp}`, {
        timeout: 8000,
        validateStatus: () => true,
      });
      checks.serpapi = res.status === 200
        ? { status: 'online', latencyMs: Date.now() - started, detail: 'Account API OK' }
        : { status: 'offline', latencyMs: Date.now() - started, detail: `HTTP ${res.status}` };
    } catch (err) {
      checks.serpapi = { status: 'offline', detail: err.message };
    }
  }

  // WhatsApp transport health (Meta Cloud API)
  try {
    const whatsappTransport = require('./whatsappTransport');
    const defaultWs = process.env.DEFAULT_WORKSPACE_ID || 'default';
    const creds = whatsappTransport.resolveCredentials(defaultWs);
    if (creds.token && creds.phoneNumberId) {
      const started = Date.now();
      const res = await axios.get(`https://graph.facebook.com/v22.0/${creds.phoneNumberId}`, {
        headers: { Authorization: `Bearer ${creds.token}` },
        timeout: 8000,
        validateStatus: () => true,
      });
      checks.whatsapp = res.status === 200
        ? { status: 'online', latencyMs: Date.now() - started, detail: `Meta Cloud API OK (${creds.source} credentials)` }
        : { status: 'offline', latencyMs: Date.now() - started, detail: `Meta Graph API HTTP ${res.status}` };
    } else {
      checks.whatsapp = { status: 'unconfigured', detail: 'WhatsApp Cloud API credentials not set (workspace or env)' };
    }
  } catch (err) {
    checks.whatsapp = { status: 'offline', detail: err.message };
  }

  checks.emailSmtp = await probeSmtp();
  checks.twilioSms = await probeTwilio();

  // Supabase / DB
  try {
    const started = Date.now();
    if (userStorage.resolveDriver() === 'postgres') {
      await query('SELECT 1 AS ok');
      checks.supabase = { status: 'online', latencyMs: Date.now() - started, detail: 'Postgres query OK' };
    } else {
      checks.supabase = { status: 'degraded', detail: 'Using JSON storage driver' };
    }
  } catch (err) {
    checks.supabase = { status: 'offline', detail: err.message };
  }

  // Render — ONLY when RENDER_HEALTH_URL is explicitly set (never fall back to localhost API_BASE_URL)
  const renderUrl = process.env.RENDER_HEALTH_URL;
  if (!renderUrl) {
    checks.render = { status: 'unconfigured', detail: 'RENDER_HEALTH_URL not set — not probing localhost' };
  } else {
    checks.render = await probeUrl(String(renderUrl).replace(/\/$/, ''));
  }

  // Hostinger — only explicit URL
  const hostingerUrl = process.env.HOSTINGER_HEALTH_URL;
  checks.hostinger = hostingerUrl
    ? await probeUrl(String(hostingerUrl).replace(/\/$/, ''))
    : { status: 'unconfigured', detail: 'HOSTINGER_HEALTH_URL not set' };

  // Domain / frontend reachability
  const frontendUrl = process.env.FRONTEND_URL || process.env.APP_URL || process.env.REACT_APP_APP_URL;
  const domainUrl = process.env.DOMAIN_HEALTH_URL || frontendUrl;
  checks.domain = domainUrl
    ? await probeUrl(domainUrl)
    : { status: 'unconfigured', detail: 'FRONTEND_URL / DOMAIN_HEALTH_URL not set' };
  checks.frontend = checks.domain;

  // SSL certificate validation for domain host
  try {
    if (domainUrl && String(domainUrl).startsWith('https')) {
      const host = new URL(domainUrl).hostname;
      checks.ssl = await probeSsl(host);
    } else if (domainUrl) {
      checks.ssl = { status: 'warning', detail: 'Endpoint is not HTTPS' };
    } else {
      checks.ssl = { status: 'unconfigured', detail: 'FRONTEND_URL / DOMAIN_HEALTH_URL not set' };
    }
  } catch (err) {
    checks.ssl = { status: 'offline', detail: err.message };
  }

  // Backend process + local health endpoint
  checks.backend = { status: 'online', detail: `API process uptime ${Math.round(process.uptime())}s` };
  checks.process = {
    status: 'online',
    detail: `uptime ${Math.round(process.uptime())}s`,
    latencyMs: null,
  };

  return { generatedAt: new Date().toISOString(), checks };
}

async function getExpiryMonitoring() {
  const items = await adminAudit.listExpiryItems();
  const now = new Date();
  const enriched = items.map((it) => {
    const expiresAt = it.expires_at || it.expiresAt;
    const remainingDays = expiresAt ? daysBetween(expiresAt, now) : null;
    const warnDays = it.warn_days ?? it.warnDays ?? 14;
    let level = 'ok';
    if (remainingDays != null) {
      if (remainingDays < 0) level = 'expired';
      else if (remainingDays <= warnDays) level = 'warning';
    }
    return {
      id: it.id,
      name: it.name,
      category: it.category,
      expiresAt,
      remainingDays,
      warnDays,
      notes: it.notes,
      level,
    };
  });

  // Seed env-derived hints (read-only, not persisted unless owner saves)
  const hints = [];
  if (process.env.OPENAI_CREDIT_EXPIRES_AT) {
    hints.push({
      id: 'env_openai',
      name: 'OpenAI Credits',
      category: 'openai',
      expiresAt: process.env.OPENAI_CREDIT_EXPIRES_AT,
      remainingDays: daysBetween(process.env.OPENAI_CREDIT_EXPIRES_AT, now),
      warnDays: 14,
      notes: 'From OPENAI_CREDIT_EXPIRES_AT',
      level: 'ok',
    });
  }
  enriched.push(...hints.map((h) => {
    let level = 'ok';
    if (h.remainingDays != null) {
      if (h.remainingDays < 0) level = 'expired';
      else if (h.remainingDays <= h.warnDays) level = 'warning';
    }
    return { ...h, level };
  }));

  const warnings = enriched.filter((e) => e.level === 'warning' || e.level === 'expired');
  return { items: enriched, warnings };
}

async function getLiveActivity(limit = 40) {
  const events = await adminAudit.listAuthEvents(limit);
  let liveOnlineUsers = [];
  try {
    const sessionService = require('./sessionService');
    const sessions = await sessionService.listOnlineSessions(5);
    liveOnlineUsers = sessions.map((s) => ({
      id: s.user_id,
      email: s.email,
      fullName: null,
      lastLoginAt: s.last_seen_at,
      lastSeenAt: s.last_seen_at,
      lastLoginIp: s.ip,
      lastLoginUserAgent: s.user_agent,
      sessionId: s.id,
      source: 'session',
    }));
    // Enrich names from users
    const users = await listAllUsers();
    const byId = Object.fromEntries(users.map((u) => [u.id, u]));
    liveOnlineUsers = liveOnlineUsers.map((o) => {
      const u = byId[o.id];
      return {
        ...o,
        fullName: u?.full_name || u?.fullName || null,
        email: o.email || u?.email || null,
      };
    });
  } catch (err) {
    console.warn('[AdminMetrics] session online fallback:', err.message);
    const users = await listAllUsers();
    const onlineCutoff = Date.now() - 5 * 60 * 1000;
    liveOnlineUsers = users.filter((u) => {
      const t = u.last_login_at || u.lastLoginAt;
      return t && new Date(t).getTime() >= onlineCutoff;
    }).map((u) => ({
      id: u.id,
      email: u.email,
      fullName: u.full_name || u.fullName,
      lastLoginAt: u.last_login_at || u.lastLoginAt,
      lastLoginIp: u.last_login_ip || u.lastLoginIp,
      lastLoginUserAgent: u.last_login_user_agent || u.lastLoginUserAgent,
      source: 'last_login_fallback',
    }));
  }

  return {
    liveOnlineUsers,
    onlineCount: liveOnlineUsers.length,
    loginHistory: events.map((e) => ({
      id: e.id,
      email: e.email,
      userId: e.user_id || e.userId,
      eventType: e.event_type || e.eventType,
      success: e.success,
      ip: e.ip,
      userAgent: e.user_agent || e.userAgent,
      country: e.country,
      createdAt: e.created_at || e.createdAt,
    })),
  };
}

async function buildNotificationsFromState() {
  const health = await getSystemHealth();
  const expiry = await getExpiryMonitoring();
  const revenue = await getRevenueAnalytics();
  const generated = [];

  for (const [key, val] of Object.entries(health.checks || {})) {
    if (val.status === 'offline') {
      generated.push({
        severity: 'critical',
        category: 'system',
        title: `${key} is offline`,
        body: val.detail || '',
        source: key,
      });
    } else if (val.status === 'degraded' || val.status === 'warning') {
      generated.push({
        severity: 'warning',
        category: 'system',
        title: `${key} needs attention`,
        body: val.detail || '',
        source: key,
      });
    }
  }

  for (const w of expiry.warnings) {
    generated.push({
      severity: w.level === 'expired' ? 'critical' : 'warning',
      category: 'expiry',
      title: `${w.name} ${w.level === 'expired' ? 'expired' : 'expiring soon'}`,
      body: w.remainingDays != null ? `${w.remainingDays} days remaining` : w.notes,
      source: w.id,
    });
  }

  if (revenue.failedPayments > 0) {
    generated.push({
      severity: 'warning',
      category: 'billing',
      title: `${revenue.failedPayments} failed payment(s)`,
      body: 'Review payment events in Revenue',
      source: 'payments',
    });
  }

  return generated;
}

async function getCampaignRunMetrics() {
  const empty = {
    runningCampaigns: 0,
    completedCampaigns: 0,
    failedCampaigns: 0,
    automationRunsRunning: 0,
    automationRunsSucceeded: 0,
    automationRunsFailed: 0,
    source: 'campaigns+automation_runs',
  };
  try {
    if (userStorage.resolveDriver() !== 'postgres') return empty;
    const camps = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('sent','replied','interested','meeting'))::int AS running,
        COUNT(*) FILTER (WHERE status = 'deal')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'lost')::int AS failed,
        COUNT(*)::int AS total
      FROM campaigns
    `).catch(() => ({ rows: [{}] }));
    const runs = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('pending','running'))::int AS running,
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM automation_runs
    `).catch(() => ({ rows: [{}] }));
    return {
      runningCampaigns: camps.rows[0]?.running || 0,
      completedCampaigns: camps.rows[0]?.completed || 0,
      failedCampaigns: camps.rows[0]?.failed || 0,
      totalCampaigns: camps.rows[0]?.total || 0,
      automationRunsRunning: runs.rows[0]?.running || 0,
      automationRunsSucceeded: runs.rows[0]?.succeeded || 0,
      automationRunsFailed: runs.rows[0]?.failed || 0,
      source: 'campaigns+automation_runs',
      definitions: {
        running: "campaigns.status IN ('sent','replied','interested','meeting')",
        completed: "campaigns.status = 'deal'",
        failed: "campaigns.status = 'lost'",
      },
    };
  } catch (err) {
    console.warn('[AdminMetrics] campaign runs:', err.message);
    return empty;
  }
}

async function getIntelligenceWinMetrics() {
  const empty = { totalAiWins: 0, avgAiScore: 0, pinnedWins: 0, sourceWinsToday: 0 };
  try {
    if (userStorage.resolveDriver() !== 'postgres') return empty;
    const today = startOfDay().toISOString();
    const r = await query(`
      SELECT
        COUNT(*)::int AS total,
        COALESCE(AVG(NULLIF(ai_score,0)),0)::float AS avg_score,
        COUNT(*) FILTER (WHERE COALESCE(pinned,FALSE) = TRUE)::int AS pinned,
        COUNT(*) FILTER (WHERE created_at >= $1)::int AS today
      FROM owner_success_events
      WHERE COALESCE(ignored,FALSE) = FALSE
    `, [today]).catch(() => ({ rows: [{}] }));
    return {
      totalAiWins: r.rows[0]?.total || 0,
      avgAiScore: round1(r.rows[0]?.avg_score || 0),
      pinnedWins: r.rows[0]?.pinned || 0,
      aiWinsToday: r.rows[0]?.today || 0,
      source: 'owner_success_events',
    };
  } catch (err) {
    console.warn('[AdminMetrics] intel wins:', err.message);
    return empty;
  }
}

/**
 * Unified Executive Dashboard — all 20 owner KPIs from live platform data.
 * Pass `parts` to reuse already-fetched metrics (avoids double health probes).
 */
function buildExecutivePayload({
  business, revenue, leads, channels, ai, health, campaigns, wins, invoiceRevenue, salesPatterns,
}) {
  const totalReplies = (channels.whatsapp?.replies || 0)
    + (channels.email?.replies || 0)
    + (channels.sms?.replies || 0);
  const aiMessagesSent = channels.totals?.aiSent || ai?.aiMessages || 0;

  const inv = invoiceRevenue || { daily: 0, monthly: 0, yearly: 0, totalPaid: 0 };
  const quoteFunnel = salesPatterns?.quoteFunnel || {};
  const saasDaily = revenue.dailyRevenue || 0;
  const saasMonthly = revenue.monthlyRevenue || 0;
  const saasYearly = revenue.yearlyRevenue || 0;
  const combinedDaily = Math.round((saasDaily + (inv.daily || 0)) * 100) / 100;
  const combinedMonthly = Math.round((saasMonthly + (inv.monthly || 0)) * 100) / 100;
  const combinedYearly = Math.round((saasYearly + (inv.yearly || 0)) * 100) / 100;

  const funnel = {
    scraped: leads.leadsScraped || 0,
    qualified: leads.qualifiedLeads || 0,
    meetings: leads.appointmentsBooked || 0,
    deals: leads.dealsWon || 0,
    quotesSent: quoteFunnel.sent || 0,
    quotesAccepted: quoteFunnel.accepted || 0,
    invoicesPaid: quoteFunnel.paid || 0,
    stages: [
      { key: 'scraped', label: 'Leads Scraped', value: leads.leadsScraped || 0 },
      { key: 'qualified', label: 'Qualified', value: leads.qualifiedLeads || 0 },
      { key: 'quotes', label: 'Quotes Sent', value: quoteFunnel.sent || 0 },
      { key: 'accepted', label: 'Quotes Accepted', value: quoteFunnel.accepted || 0 },
      { key: 'meetings', label: 'Meetings Booked', value: leads.appointmentsBooked || 0 },
      { key: 'paid', label: 'Invoices Paid', value: quoteFunnel.paid || 0 },
      { key: 'deals', label: 'Deals Closed', value: leads.dealsWon || 0 },
    ],
  };

  const checks = health?.checks || {};
  const openaiOk = checks.openai?.status === 'online' ? 25 : checks.openai?.status === 'degraded' ? 12 : 0;
  const dbOk = checks.supabase?.status === 'online' ? 15 : 0;
  const replyRate = aiMessagesSent > 0
    ? Math.min(100, (totalReplies / aiMessagesSent) * 100)
    : 0;
  const replyScore = Math.min(25, Math.round(replyRate * 0.25));
  const convScore = Math.min(20, Math.round((leads.conversionRate || 0) * 0.2));
  const winScore = Math.min(15, Math.round((wins?.avgAiScore || 0) * 1.5));
  const overallAiHealthScore = Math.min(100, openaiOk + dbOk + replyScore + convScore + winScore);

  const kpis = {
    revenueToday: {
      value: combinedDaily,
      label: 'Total Revenue Today',
      source: 'admin_payment_events + sales_documents (paid invoices)',
      saas: saasDaily,
      invoices: inv.daily || 0,
      growthPct: null,
    },
    revenueMonth: {
      value: combinedMonthly,
      label: 'Total Revenue This Month',
      source: 'admin_payment_events + sales_documents (paid invoices)',
      saas: saasMonthly,
      invoices: inv.monthly || 0,
      growthPct: revenue.monthlyGrowthPct,
    },
    revenueYear: {
      value: combinedYearly,
      label: 'Total Revenue This Year',
      source: 'admin_payment_events + sales_documents (paid invoices)',
      saas: saasYearly,
      invoices: inv.yearly || 0,
      growthPct: null,
    },
    mrr: {
      value: revenue.mrr || 0,
      label: 'Monthly Recurring Revenue (MRR)',
      source: 'users.subscription_status + admin_payment_events',
      growthPct: null,
    },
    arr: {
      value: revenue.arr != null ? revenue.arr : Math.round((revenue.mrr || 0) * 12 * 100) / 100,
      label: 'Annual Recurring Revenue (ARR)',
      source: 'MRR × 12',
      growthPct: null,
    },
    activeCustomers: {
      value: business.activeCustomers ?? business.activeSubscribers ?? 0,
      label: 'Active Customers',
      source: 'users (paid + active)',
      growthPct: null,
    },
    totalCustomers: {
      value: business.totalCustomers ?? business.totalUsers ?? 0,
      label: 'Total Customers',
      source: 'users (non-super_admin)',
      growthPct: null,
    },
    newCustomersToday: {
      value: business.newCustomersToday ?? business.newSubscribersToday ?? 0,
      label: 'New Customers Today',
      source: 'users.created_at',
      growthPct: null,
    },
    churnRate: {
      value: business.churnRate ?? 0,
      label: 'Churn Rate',
      source: 'cancelled / (active + cancelled)',
      unit: '%',
      growthPct: null,
    },
    retentionRate: {
      value: business.retentionRate ?? 100,
      label: 'Customer Retention Rate',
      source: 'active / (active + cancelled)',
      unit: '%',
      growthPct: null,
    },
    totalAiWins: {
      value: wins?.totalAiWins || 0,
      label: 'Total AI Wins',
      source: 'owner_success_events',
      growthPct: null,
      trend: `+${wins?.aiWinsToday || 0} today`,
    },
    runningCampaigns: {
      value: campaigns?.runningCampaigns || 0,
      label: 'Running Campaigns',
      source: campaigns?.definitions?.running || 'campaigns',
      growthPct: null,
    },
    completedCampaigns: {
      value: campaigns?.completedCampaigns || 0,
      label: 'Completed Campaigns',
      source: campaigns?.definitions?.completed || 'campaigns',
      growthPct: null,
    },
    failedCampaigns: {
      value: campaigns?.failedCampaigns || 0,
      label: 'Failed Campaigns',
      source: campaigns?.definitions?.failed || 'campaigns',
      growthPct: null,
    },
    aiMessagesSent: {
      value: aiMessagesSent,
      label: 'Total AI Messages Sent',
      source: 'messages (AI source heuristic)',
      growthPct: null,
    },
    totalReplies: {
      value: totalReplies,
      label: 'Total Replies',
      source: 'messages.direction=inbound',
      growthPct: null,
    },
    meetingsBooked: {
      value: leads.appointmentsBooked || 0,
      label: 'Meetings Booked',
      source: "campaigns.status='meeting'",
      growthPct: null,
    },
    dealsClosed: {
      value: leads.dealsWon || 0,
      label: 'Deals Closed',
      source: "campaigns.status='deal'",
      growthPct: null,
    },
    conversionFunnel: {
      value: leads.conversionRate || 0,
      label: 'Conversion Funnel',
      source: 'leads + campaigns + sales_documents (quote→invoice)',
      unit: '%',
      funnel,
      growthPct: null,
    },
    overallAiHealthScore: {
      value: overallAiHealthScore,
      label: 'Overall AI Health Score',
      source: 'openai probe + reply rate + conversion + avg AI win score',
      unit: '/100',
      breakdown: {
        openaiProbe: openaiOk,
        database: dbOk,
        replySignal: replyScore,
        conversion: convScore,
        winQuality: winScore,
        avgAiScore: wins?.avgAiScore || 0,
      },
      growthPct: null,
    },
  };

  return {
    generatedAt: new Date().toISOString(),
    kpis,
    charts: {
      revenue30d: (revenue.revenueGraph || []).map((g) => ({ label: g.date, value: g.revenue })),
      funnel: funnel.stages,
      campaignMix: [
        { label: 'Running', value: campaigns?.runningCampaigns || 0, color: '#38bdf8' },
        { label: 'Completed', value: campaigns?.completedCampaigns || 0, color: '#34d399' },
        { label: 'Failed', value: campaigns?.failedCampaigns || 0, color: '#fb7185' },
      ],
      customerMix: [
        { label: 'Active', value: business.activeSubscribers || 0, color: '#34d399' },
        { label: 'Trial', value: business.trialUsers || 0, color: '#fbbf24' },
        { label: 'Cancelled', value: business.cancelledUsers || 0, color: '#fb7185' },
        { label: 'Free', value: business.freeUsers || 0, color: '#94a3b8' },
      ],
    },
    raw: { business, revenue, leads, channels, ai, campaigns, wins, invoiceRevenue: inv, salesPatterns },
  };
}

async function getExecutiveDashboard(parts = null) {
  if (parts) return buildExecutivePayload(parts);
  const quoteIntelligence = require('./quoteIntelligence');
  const [business, revenue, leads, channels, ai, health, campaigns, wins, invoiceRevenue, salesPatterns] = await Promise.all([
    getBusinessOverview(),
    getRevenueAnalytics(),
    getLeadAnalytics(),
    getChannelAnalytics(),
    getAiUsage(),
    getSystemHealth(),
    getCampaignRunMetrics(),
    getIntelligenceWinMetrics(),
    quoteIntelligence.getInvoiceRevenueAnalytics().catch(() => ({ daily: 0, monthly: 0, yearly: 0 })),
    quoteIntelligence.getSalesPatternInsights().catch(() => null),
  ]);
  return buildExecutivePayload({
    business, revenue, leads, channels, ai, health, campaigns, wins, invoiceRevenue, salesPatterns,
  });
}

module.exports = {
  getBusinessOverview,
  getRevenueAnalytics,
  getLeadAnalytics,
  getChannelAnalytics,
  getAiUsage,
  getSystemHealth,
  getExpiryMonitoring,
  getLiveActivity,
  buildNotificationsFromState,
  listAllUsers,
  getCampaignRunMetrics,
  getIntelligenceWinMetrics,
  getExecutiveDashboard,
  buildExecutivePayload,
};
