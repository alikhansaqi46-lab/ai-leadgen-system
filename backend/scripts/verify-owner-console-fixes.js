/**
 * Owner Console production fix verification (no UI).
 * Usage: node scripts/verify-owner-console-fixes.js
 * Optional: OWNER_EMAIL / OWNER_PASSWORD for authenticated API checks.
 */

require('dotenv').config();
const axios = require('axios');

const BASE = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5001}`;
const email = process.env.OWNER_EMAIL || process.env.SUPER_ADMIN_EMAILS?.split(',')[0]?.trim() || 'leadflow.my@gmail.com';
const password = process.env.OWNER_PASSWORD || '';

async function main() {
  const report = [];
  const ok = (name, detail) => report.push({ name, status: 'PASS', detail });
  const fail = (name, detail) => report.push({ name, status: 'FAIL', detail });

  // Direct service checks (no auth)
  const adminMetrics = require('../services/adminMetrics');
  const health = await adminMetrics.getSystemHealth();
  if (health.checks.render?.status === 'unconfigured') {
    ok('Render health', health.checks.render.detail);
  } else if (!process.env.RENDER_HEALTH_URL) {
    fail('Render health', `Expected unconfigured without RENDER_HEALTH_URL, got ${health.checks.render?.status}`);
  } else {
    ok('Render health', `${health.checks.render.status}: ${health.checks.render.detail}`);
  }

  const revenue = await adminMetrics.getRevenueAnalytics();
  if (revenue.pricingSource === 'payment_ledger' && revenue.estimated !== true) {
    ok('Revenue pricing', `pricingSource=${revenue.pricingSource}, mrr=${revenue.mrr}`);
  } else {
    fail('Revenue pricing', JSON.stringify({ pricingSource: revenue.pricingSource, estimated: revenue.estimated }));
  }

  const channels = await adminMetrics.getChannelAnalytics();
  if (channels.totals && 'manualSent' in channels.totals && 'aiSent' in channels.totals) {
    ok('Messaging split', `total=${channels.totals.totalOutbound} manual=${channels.totals.manualSent} ai=${channels.totals.aiSent}`);
  } else {
    fail('Messaging split', 'totals missing');
  }

  // Authenticated checks
  if (!password) {
    fail('Auth API suite', 'Set OWNER_PASSWORD to run authenticated API verification');
  } else {
    try {
      const login = await axios.post(`${BASE}/api/auth/login`, { email, password });
      const token = login.data.token;
      const headers = { Authorization: `Bearer ${token}` };
      ok('Owner login', `sessionId=${login.data.sessionId || 'legacy'}`);

      const testErr = await axios.post(`${BASE}/api/admin/errors/test`, { message: 'verify-script-test-error' }, { headers });
      ok('Create test error', testErr.data.error?.id || 'created');

      const errors = await axios.get(`${BASE}/api/admin/errors?limit=20`, { headers });
      const found = (errors.data.logs || []).some((e) => String(e.message || '').includes('verify-script-test-error') || e.source === 'admin.test');
      if (found) ok('Error logs list', `count=${errors.data.logs.length}`);
      else fail('Error logs list', 'test error not found in list');

      await axios.post(`${BASE}/api/admin/maintenance`, { enabled: true, message: 'verify maintenance' }, { headers });
      try {
        await axios.get(`${BASE}/api/leads`);
        fail('Maintenance block', 'unauthenticated /api/leads should be 503');
      } catch (e) {
        if (e.response?.status === 503) ok('Maintenance block', '503 for non-admin');
        else fail('Maintenance block', `status=${e.response?.status}`);
      }
      // Super admin still works
      const overview = await axios.get(`${BASE}/api/admin/overview`, { headers });
      if (overview.status === 200) ok('Maintenance admin bypass', 'overview OK');
      else fail('Maintenance admin bypass', String(overview.status));

      await axios.post(`${BASE}/api/admin/maintenance`, { enabled: false }, { headers });
      ok('Maintenance OFF', 'disabled');

      const cache = await axios.post(`${BASE}/api/admin/cache/clear`, {}, { headers });
      ok('Cache clear', JSON.stringify(cache.data.cleared || cache.data.message));

      const queue = await axios.post(`${BASE}/api/admin/queue/restart`, {}, { headers });
      ok('Worker restart', queue.data.message);

      const intel = await axios.post(`${BASE}/api/admin/intelligence/scan`, {}, { headers });
      ok('Intelligence scan', `scanned=${intel.data.scanned} created=${intel.data.created}`);
    } catch (err) {
      fail('Auth API suite', err.response?.data?.error || err.message);
    }
  }

  console.log('\n=== Owner Console Fix Verification ===\n');
  for (const r of report) {
    console.log(`${r.status === 'PASS' ? '✅' : '❌'} ${r.name}: ${r.detail}`);
  }
  const failed = report.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${report.length - failed}/${report.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
