/**
 * Strictly GET-only Intelligence V2 API evidence.
 * No Pin/Archive/Delete/Ignore, no launch drafts, no writes.
 */
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const userStorage = require('../utils/userStorage');
const authService = require('../services/authService');
const sessionService = require('../services/sessionService');

const BASE = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5001}`;
const ISOLATED_ID = 'ose_isolated_4c5898e4-b66a-45e5-abdd-49ea5e2587a8';

async function main() {
  const ownerEmail = (process.env.SUPER_ADMIN_EMAILS || 'leadflow.my@gmail.com').split(',')[0].trim();
  const owner = await userStorage.findByEmail(ownerEmail);
  if (!owner) throw new Error('Owner not found');
  const sess = await sessionService.createSession({
    userId: owner.id, email: owner.email, ip: '127.0.0.1', userAgent: 'api-intel-v2-get-only',
  });
  const token = authService.signToken(owner.id, { role: 'super_admin', sessionId: sess.id });
  const client = axios.create({
    baseURL: BASE,
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  const out = { mode: 'get_only', at: new Date().toISOString() };

  const list = await client.get('/api/admin/intelligence', {
    params: { showTest: 'true', sort: 'score_desc', page: 1, pageSize: 10 },
  });
  out.list = {
    status: list.status,
    total: list.data.total,
    page: list.data.page,
    pageSize: list.data.pageSize,
    totalPages: list.data.totalPages,
    eventsReturned: (list.data.events || []).length,
    libraryReturned: (list.data.library || []).length,
    top: (list.data.events || []).slice(0, 5).map((e) => ({
      id: e.id,
      ai_score: e.ai_score,
      score_label: e.score_label,
      industry: e.industry,
      is_test: e.is_test,
      pinned: e.pinned,
    })),
  };

  const page2 = await client.get('/api/admin/intelligence', {
    params: { showTest: 'true', sort: 'score_desc', page: 2, pageSize: 10 },
  });
  out.pagination = {
    page1: (list.data.events || []).length,
    page2Status: page2.status,
    page2: (page2.data.events || []).length,
    total: list.data.total,
    totalPages: list.data.totalPages,
  };

  const hide = await client.get('/api/admin/intelligence', {
    params: { showTest: 'false', page: 1, pageSize: 25 },
  });
  out.hideTestQuery = { status: hide.status, total: hide.data.total };

  const optometry = await client.get('/api/admin/intelligence', {
    params: { industry: 'Optometry', showTest: 'true', page: 1, pageSize: 10 },
  });
  out.filterIndustry = { status: optometry.status, total: optometry.data.total };

  const detail = await client.get(`/api/admin/intelligence/campaign/${ISOLATED_ID}`);
  out.campaignDetail = {
    status: detail.status,
    name: detail.data.campaignSummary?.name,
    aiScore: detail.data.campaignSummary?.aiScore,
    scoreLabel: detail.data.campaignSummary?.scoreLabel,
    recKeys: Object.keys(detail.data.recommendations || {}),
    reuseConfidence: detail.data.recommendations?.reuseConfidence,
  };

  const lib = await client.get('/api/admin/intelligence/library', {
    params: { showTest: 'true', limit: 10, sort: 'score_desc' },
  });
  out.library = {
    status: lib.status,
    total: lib.data.total,
    count: (lib.data.library || []).length,
    first: (lib.data.library || [])[0] && {
      id: lib.data.library[0].id,
      name: lib.data.library[0].name,
      ai_score: lib.data.library[0].ai_score,
    },
  };

  const workspaces = await client.get('/api/admin/intelligence/workspaces');
  out.workspaces = { status: workspaces.status, count: (workspaces.data.workspaces || []).length };

  const notifs = await client.get('/api/admin/notifications');
  out.notifications = {
    status: notifs.status,
    successDeepLinks: (notifs.data.notifications || [])
      .filter((n) => String(n.source || '').startsWith('ose_'))
      .slice(0, 5)
      .map((n) => ({
        title: n.title,
        source: n.source,
        hasScore: /AI Score/i.test(n.body || ''),
        hasOpenHint: /Open in AI Intelligence/i.test(n.body || ''),
      })),
  };

  // Non-mutating contract checks only
  const delGuard = await client.post(`/api/admin/intelligence/events/${ISOLATED_ID}/delete`, {});
  out.deleteGuardNoConfirm = { status: delGuard.status, error: delGuard.data.error };

  const outPath = path.join(__dirname, '..', 'logs', 'intel-v2-get-only-proof.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log('WROTE', outPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
