/**
 * Non-destructive API proof for Intelligence v2.
 * No successful Pin/Unpin/Archive/Ignore/Delete mutations.
 * Delete is only called WITHOUT confirm to prove the guard.
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
const ISOLATED_LIB = 'ocl_ose_isolated_4c5898e4-b66a-45e5-abdd-49ea5e2587a8';

async function main() {
  const ownerEmail = (process.env.SUPER_ADMIN_EMAILS || 'leadflow.my@gmail.com').split(',')[0].trim();
  const owner = await userStorage.findByEmail(ownerEmail);
  if (!owner) throw new Error('Owner not found');
  const sess = await sessionService.createSession({
    userId: owner.id, email: owner.email, ip: '127.0.0.1', userAgent: 'api-intel-v2-readonly',
  });
  const token = authService.signToken(owner.id, { role: 'super_admin', sessionId: sess.id });
  const client = axios.create({
    baseURL: BASE,
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  const out = { mode: 'non_destructive_no_lifecycle_mutations', at: new Date().toISOString() };

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
    scores: (list.data.events || []).slice(0, 5).map((e) => ({
      id: e.id, ai_score: e.ai_score, score_label: e.score_label, is_test: e.is_test, industry: e.industry,
    })),
  };

  const page2 = await client.get('/api/admin/intelligence', {
    params: { showTest: 'true', sort: 'score_desc', page: 2, pageSize: 10 },
  });
  out.pagination = {
    page1Count: (list.data.events || []).length,
    page2Status: page2.status,
    page2Count: (page2.data.events || []).length,
    total: list.data.total,
    totalPages: list.data.totalPages,
  };

  const hide = await client.get('/api/admin/intelligence', {
    params: { showTest: 'false', page: 1, pageSize: 25 },
  });
  out.hideTest = {
    status: hide.status,
    total: hide.data.total,
    sampleIds: (hide.data.events || []).slice(0, 5).map((e) => e.id),
  };

  const filter = await client.get('/api/admin/intelligence', {
    params: { industry: 'Optometry', showTest: 'true', page: 1, pageSize: 10 },
  });
  out.filterIndustry = { status: filter.status, total: filter.data.total, ids: (filter.data.events || []).map((e) => e.id) };

  const channel = await client.get('/api/admin/intelligence', {
    params: { channel: 'email', showTest: 'true', page: 1, pageSize: 10 },
  });
  out.filterChannel = { status: channel.status, total: channel.data.total };

  const detail = await client.get(`/api/admin/intelligence/campaign/${ISOLATED_ID}`);
  out.recommendationPanel = {
    status: detail.status,
    aiScore: detail.data.campaignSummary?.aiScore,
    scoreLabel: detail.data.campaignSummary?.scoreLabel,
    recKeys: Object.keys(detail.data.recommendations || {}),
    reuseConfidence: detail.data.recommendations?.reuseConfidence,
    recommendedChannel: detail.data.recommendations?.recommendedChannel,
  };

  // Lifecycle wiring proof WITHOUT mutation
  const delReject = await client.post(`/api/admin/intelligence/events/${ISOLATED_ID}/delete`, {});
  out.lifecycleDeleteGuard = { status: delReject.status, error: delReject.data.error };

  const badAction = await client.post(`/api/admin/intelligence/events/${ISOLATED_ID}/not-a-real-action`, {});
  out.lifecycleInvalidAction = { status: badAction.status, error: badAction.data.error };

  const libDelReject = await client.post(`/api/admin/intelligence/library/${ISOLATED_LIB}/delete`, {});
  out.libraryDeleteGuard = { status: libDelReject.status, error: libDelReject.data.error };

  // Launch wizard: create + update draft only (insert/update draft table). No launch.
  const draft = await client.post(`/api/admin/intelligence/library/${ISOLATED_LIB}/launch-draft`, { channel: 'whatsapp' });
  out.launchDraftCreate = { status: draft.status, id: draft.data.draft?.id, channel: draft.data.draft?.channel };
  if (draft.data.draft?.id) {
    const ws = await client.get('/api/admin/intelligence/workspaces');
    const target = (ws.data.workspaces || [])[0];
    const upd = await client.patch(`/api/admin/intelligence/launch-draft/${draft.data.draft.id}`, {
      channel: 'email',
      targetWorkspaceId: target?.id,
      name: 'Isolated V2 Wizard Review',
      subject: 'V2 readonly proof',
      body: 'Editable body before launch — launch intentionally NOT called.',
    });
    out.launchDraftUpdate = {
      status: upd.status,
      channel: upd.data.draft?.channel,
      workspace: upd.data.draft?.target_workspace_id,
      statusField: upd.data.draft?.status,
    };
    out.launchNotCalled = true;
  }

  const notifs = await client.get('/api/admin/notifications');
  out.notifications = {
    status: notifs.status,
    deepLinks: (notifs.data.notifications || [])
      .filter((n) => String(n.source || '').startsWith('ose_'))
      .slice(0, 5)
      .map((n) => ({
        title: n.title,
        source: n.source,
        hasScore: /AI Score/i.test(n.body || ''),
        hasRevenue: /Revenue/i.test(n.body || ''),
      })),
  };

  // Honest note: prior session may have left an accidental pin on a non-isolated row
  const { query } = require('../config/db');
  const pinned = await query(`
    SELECT id, campaign_name, workspace_id, pinned
    FROM owner_success_events WHERE COALESCE(pinned,false) = TRUE
  `);
  out.currentPinnedRows = pinned.rows;
  out.note = 'No Pin/Unpin/Archive/Ignore/Delete mutations executed by this script.';

  const outPath = path.join(__dirname, '..', 'logs', 'intel-v2-readonly-proof.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log('WROTE', outPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
