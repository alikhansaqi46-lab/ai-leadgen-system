/**
 * Executive KPI verification — compares API values to DB/ledger sources.
 * Non-destructive. Writes proof JSON only.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const adminMetrics = require('../services/adminMetrics');
const { query } = require('../config/db');
const userStorage = require('../utils/userStorage');
const adminAudit = require('../utils/adminAudit');

function assertClose(label, a, b, tol = 0.01) {
  const ok = Math.abs(Number(a) - Number(b)) <= tol;
  return { label, expected: b, actual: a, ok };
}

async function main() {
  const exec = await adminMetrics.getExecutiveDashboard();
  const k = exec.kpis;
  const checks = [];

  const users = await userStorage.listUsers();
  const payments = await adminAudit.listPaymentEvents(2000);
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const month = new Date(today); month.setDate(1);
  const year = new Date(today); year.setMonth(0, 1);

  let daily = 0; let monthly = 0; let yearly = 0; let total = 0;
  for (const p of payments) {
    const amount = Number(p.amount) || 0;
    const created = new Date(p.created_at || p.createdAt || 0);
    const type = String(p.event_type || p.eventType || '').toLowerCase();
    const status = String(p.status || '').toLowerCase();
    if (type.includes('refund') || status === 'refunded') continue;
    if (type.includes('fail') || status === 'failed') continue;
    if (amount > 0 && (status === 'completed' || status === 'success' || type.includes('completed') || type.includes('activated'))) {
      total += amount;
      if (created >= year) yearly += amount;
      if (created >= month) monthly += amount;
      if (created >= today) daily += amount;
    }
  }

  checks.push(assertClose('revenueToday', k.revenueToday.value, daily));
  checks.push(assertClose('revenueMonth', k.revenueMonth.value, monthly));
  checks.push(assertClose('revenueYear', k.revenueYear.value, yearly));
  checks.push(assertClose('arr=mrr*12', k.arr.value, Math.round(k.mrr.value * 12 * 100) / 100));

  const active = users.filter((u) => String(u.subscription_status || '').toLowerCase() === 'active'
    && ['starter', 'pro', 'agency'].includes(String(u.subscription_plan || '').toLowerCase())).length;
  const cancelled = users.filter((u) => /cancel/.test(String(u.subscription_status || '').toLowerCase())).length;
  const totalCust = users.filter((u) => String(u.role || '').toLowerCase() !== 'super_admin').length;
  const newToday = users.filter((u) => {
    const c = u.created_at || u.createdAt;
    return c && new Date(c) >= today;
  }).length;
  const denom = active + cancelled;
  const churn = denom > 0 ? Math.round((cancelled / denom) * 1000) / 10 : 0;
  const retention = denom > 0 ? Math.round((active / denom) * 1000) / 10 : 100;

  checks.push(assertClose('activeCustomers', k.activeCustomers.value, active));
  checks.push(assertClose('totalCustomers', k.totalCustomers.value, totalCust));
  checks.push(assertClose('newCustomersToday', k.newCustomersToday.value, newToday));
  checks.push(assertClose('churnRate', k.churnRate.value, churn));
  checks.push(assertClose('retentionRate', k.retentionRate.value, retention));

  let dbCamps = { running: 0, completed: 0, failed: 0 };
  let dbWins = 0;
  let dbMeet = 0;
  let dbDeals = 0;
  let dbReplies = 0;
  let dbAiSent = 0;
  if (userStorage.resolveDriver() === 'postgres') {
    const camps = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('sent','replied','interested','meeting'))::int AS running,
        COUNT(*) FILTER (WHERE status = 'deal')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'lost')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'meeting')::int AS meetings,
        COUNT(*) FILTER (WHERE status = 'deal')::int AS deals
      FROM campaigns
    `);
    dbCamps = camps.rows[0] || dbCamps;
    dbMeet = camps.rows[0]?.meetings || 0;
    dbDeals = camps.rows[0]?.deals || 0;
    const wins = await query(`SELECT COUNT(*)::int AS n FROM owner_success_events WHERE COALESCE(ignored,FALSE)=FALSE`);
    dbWins = wins.rows[0]?.n || 0;
    const replies = await query(`SELECT COUNT(*)::int AS n FROM messages WHERE direction='inbound'`);
    dbReplies = replies.rows[0]?.n || 0;
  }

  checks.push(assertClose('runningCampaigns', k.runningCampaigns.value, dbCamps.running || 0));
  checks.push(assertClose('completedCampaigns', k.completedCampaigns.value, dbCamps.completed || 0));
  checks.push(assertClose('failedCampaigns', k.failedCampaigns.value, dbCamps.failed || 0));
  checks.push(assertClose('totalAiWins', k.totalAiWins.value, dbWins));
  checks.push(assertClose('meetingsBooked', k.meetingsBooked.value, dbMeet));
  checks.push(assertClose('dealsClosed', k.dealsClosed.value, dbDeals));
  checks.push(assertClose('totalReplies', k.totalReplies.value, dbReplies));

  const requiredKeys = [
    'revenueToday', 'revenueMonth', 'revenueYear', 'mrr', 'arr',
    'activeCustomers', 'totalCustomers', 'newCustomersToday', 'churnRate', 'retentionRate',
    'totalAiWins', 'runningCampaigns', 'completedCampaigns', 'failedCampaigns',
    'aiMessagesSent', 'totalReplies', 'meetingsBooked', 'dealsClosed',
    'conversionFunnel', 'overallAiHealthScore',
  ];
  const missing = requiredKeys.filter((key) => !k[key]);
  const failed = checks.filter((c) => !c.ok);

  const proof = {
    generatedAt: new Date().toISOString(),
    endpoint: 'GET /api/admin/metrics/executive (+ overview.executive)',
    kpiCount: requiredKeys.length,
    missingKeys: missing,
    checks,
    failed: failed.length,
    passed: checks.filter((c) => c.ok).length,
    sampleKpis: Object.fromEntries(requiredKeys.map((key) => [key, k[key]])),
    charts: {
      revenuePoints: (exec.charts.revenue30d || []).length,
      funnelStages: (exec.charts.funnel || []).length,
      campaignMix: exec.charts.campaignMix,
    },
    ledgerTotals: { daily, monthly, yearly, total, paymentEvents: payments.length },
    success: missing.length === 0 && failed.length === 0,
  };

  const out = path.join(__dirname, '../logs/executive-kpi-proof.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({
    success: proof.success,
    passed: proof.passed,
    failed: proof.failed,
    missingKeys: proof.missingKeys,
    out,
    kpis: requiredKeys.map((key) => ({ key, value: k[key]?.value, label: k[key]?.label })),
  }, null, 2));
  if (!proof.success) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
