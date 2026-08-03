/**
 * Non-destructive HTTP proof for Intelligence v2 APIs.
 * Uses signed owner session. Lifecycle pin/unpin only on isolated row.
 * Delete is proven via reject-without-confirm only (no delete executed).
 */
require('dotenv').config();
const axios = require('axios');
const userStorage = require('../utils/userStorage');
const authService = require('../services/authService');
const sessionService = require('../services/sessionService');

const BASE = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5001}`;
const ISOLATED_ID = process.argv[2] || 'ose_isolated_4c5898e4-b66a-45e5-abdd-49ea5e2587a8';
const ISOLATED_LIB = process.argv[3] || 'ocl_ose_isolated_4c5898e4-b66a-45e5-abdd-49ea5e2587a8';

async function main() {
  const ownerEmail = (process.env.SUPER_ADMIN_EMAILS || 'leadflow.my@gmail.com').split(',')[0].trim();
  const owner = await userStorage.findByEmail(ownerEmail);
  if (!owner) throw new Error('Owner not found: ' + ownerEmail);
  const sess = await sessionService.createSession({
    userId: owner.id,
    email: owner.email,
    ip: '127.0.0.1',
    userAgent: 'api-intel-v2-proof',
  });
  const token = authService.signToken(owner.id, { role: 'super_admin', sessionId: sess.id });
  const client = axios.create({
    baseURL: BASE,
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  const out = {};

  const list = await client.get('/api/admin/intelligence', {
    params: { showTest: 'true', sort: 'score_desc', page: 1, pageSize: 10 },
  });
  out.list = {
    status: list.status,
    total: list.data.total,
    events: (list.data.events || []).length,
    top: (list.data.events || []).slice(0, 3).map((e) => ({
      id: e.id, ai_score: e.ai_score, score_label: e.score_label, is_test: e.is_test, industry: e.industry,
    })),
  };

  const hide = await client.get('/api/admin/intelligence', {
    params: { showTest: 'false', page: 1, pageSize: 10 },
  });
  out.hideTest = { status: hide.status, total: hide.data.total };

  const filter = await client.get('/api/admin/intelligence', {
    params: { industry: 'Optometry', showTest: 'true', page: 1, pageSize: 10 },
  });
  out.filterIndustry = {
    status: filter.status,
    total: filter.data.total,
    ids: (filter.data.events || []).map((e) => e.id),
  };

  const detail = await client.get(`/api/admin/intelligence/campaign/${ISOLATED_ID}`);
  out.detail = {
    status: detail.status,
    aiScore: detail.data.campaignSummary?.aiScore,
    scoreLabel: detail.data.campaignSummary?.scoreLabel,
    hasRecs: !!detail.data.recommendations,
    recKeys: Object.keys(detail.data.recommendations || {}),
  };

  const pin = await client.post(`/api/admin/intelligence/events/${ISOLATED_ID}/pin`);
  out.pin = { status: pin.status, pinned: pin.data.result?.pinned };

  const archive = await client.post(`/api/admin/intelligence/events/${ISOLATED_ID}/archive`);
  out.archive = { status: archive.status, archived: archive.data.result?.archived };

  const unarchive = await client.post(`/api/admin/intelligence/events/${ISOLATED_ID}/unarchive`);
  out.unarchive = { status: unarchive.status, archived: unarchive.data.result?.archived };

  const unpin = await client.post(`/api/admin/intelligence/events/${ISOLATED_ID}/unpin`);
  out.unpin = { status: unpin.status, pinned: unpin.data.result?.pinned };

  const delReject = await client.post(`/api/admin/intelligence/events/${ISOLATED_ID}/delete`, {});
  out.deleteRejectNoConfirm = { status: delReject.status, error: delReject.data.error };

  const draft = await client.post(`/api/admin/intelligence/library/${ISOLATED_LIB}/launch-draft`, {
    channel: 'email',
  });
  out.launchDraft = { status: draft.status, id: draft.data.draft?.id, channel: draft.data.draft?.channel };

  if (draft.data.draft?.id) {
    const ws = await client.get('/api/admin/intelligence/workspaces');
    const target = (ws.data.workspaces || [])[0];
    const upd = await client.patch(`/api/admin/intelligence/launch-draft/${draft.data.draft.id}`, {
      targetWorkspaceId: target?.id,
      body: 'Isolated V2 launch wizard proof body',
      subject: 'V2 proof',
      name: 'Isolated V2 Launch',
    });
    out.launchUpdate = { status: upd.status, workspace: upd.data.draft?.target_workspace_id };
    // Do NOT call launch endpoint against real workspaces in this non-destructive run.
    out.launchSkipped = 'Launch POST skipped intentionally (non-destructive). Draft created+updated only.';
  }

  const notifs = await client.get('/api/admin/notifications');
  const success = (notifs.data.notifications || []).filter((n) => String(n.source || '').startsWith('ose_')).slice(0, 3);
  out.notifications = {
    status: notifs.status,
    successDeepLinks: success.map((n) => ({
      title: n.title,
      source: n.source,
      hasScore: /AI Score/i.test(n.body || ''),
    })),
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
