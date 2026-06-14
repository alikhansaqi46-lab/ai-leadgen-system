#!/usr/bin/env node
/**
 * S2 automated isolation tests.
 *
 * Verifies two things, with NO external services required for the JSON path:
 *   1. Storage-layer workspace isolation (run against JSON, and against Postgres
 *      if DATABASE_URL is set): workspace A cannot see or delete workspace B's
 *      leads; dedup is scoped per-workspace.
 *   2. Auth middleware: disabled mode is a no-op (default workspace); dev mode
 *      rejects missing/invalid tokens (401) and resolves workspace from claims.
 *
 * Non-destructive: uses dedicated test workspace ids and cleans them up.
 *
 * Usage:
 *   node scripts/test-isolation.js                 # JSON + auth
 *   DATABASE_URL=postgres://... node scripts/test-isolation.js   # + Postgres
 */

require('dotenv').config();

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log('  PASS:', msg);
  } else {
    console.error('  FAIL:', msg);
    failures++;
  }
}

const WS_A = '__iso_test_a';
const WS_B = '__iso_test_b';

async function cleanup(storage) {
  for (const ws of [WS_A, WS_B]) {
    const leads = await storage.getLeads({ workspaceId: ws, limit: 10000 });
    if (leads.length) {
      await storage.deleteLeads(leads.map(l => l.id), { workspaceId: ws });
    }
  }
}

async function testStorageIsolation(driver) {
  console.log(`\n=== Storage isolation [STORAGE_DRIVER=${driver}] ===`);
  process.env.STORAGE_DRIVER = driver;
  // Fresh require so the module picks up env (it reads env per-call anyway).
  const storage = require('../utils/leadStorage');

  await cleanup(storage);

  // A and B each add a distinct lead.
  const addedA = await storage.addLeads([{ name: 'Acme Cafe', phone: '+1 (555) 111-1111', country: 'USA', niche: 'cafe' }], { workspaceId: WS_A });
  const addedB = await storage.addLeads([{ name: 'Beta Dentist', phone: '+1 (555) 222-2222', country: 'UK', niche: 'dentist' }], { workspaceId: WS_B });
  check(addedA.length === 1, 'A added 1 lead');
  check(addedB.length === 1, 'B added 1 lead');

  // Each workspace sees only its own.
  const leadsA = await storage.getLeads({ workspaceId: WS_A, limit: 10000 });
  const leadsB = await storage.getLeads({ workspaceId: WS_B, limit: 10000 });
  check(leadsA.length === 1 && leadsA[0].name === 'Acme Cafe', 'A sees only its lead');
  check(leadsB.length === 1 && leadsB[0].name === 'Beta Dentist', 'B sees only its lead');
  check(!leadsA.some(l => l.name === 'Beta Dentist'), 'A does NOT see B lead');
  check(leadsA[0].workspaceId === WS_A, 'A lead is stamped with workspaceId');

  // Filters/export are per-workspace.
  const filtersA = await storage.getFilters({ workspaceId: WS_A });
  check(filtersA.countries.includes('USA') && !filtersA.countries.includes('UK'), 'A filters are workspace-scoped');
  const exportB = await storage.exportLeads({ workspaceId: WS_B });
  check(exportB.length === 1 && exportB[0].country === 'UK', 'B export is workspace-scoped');

  // Cross-workspace delete must NOT remove B's lead.
  const betaId = leadsB[0].id;
  await storage.deleteLeads([betaId], { workspaceId: WS_A });
  const leadsBAfter = await storage.getLeads({ workspaceId: WS_B, limit: 10000 });
  check(leadsBAfter.some(l => l.id === betaId), 'A cannot delete B lead (isolation enforced)');

  // Legitimate delete by the owning workspace works.
  await storage.deleteLeads([betaId], { workspaceId: WS_B });
  const leadsBFinal = await storage.getLeads({ workspaceId: WS_B, limit: 10000 });
  check(!leadsBFinal.some(l => l.id === betaId), 'B can delete its own lead');

  // Dedup is per-workspace: re-adding A's business to A is a duplicate...
  const dupA = await storage.addLeads([{ name: 'Acme Cafe', phone: '+15551111111', country: 'USA', niche: 'cafe' }], { workspaceId: WS_A });
  check(dupA.length === 0, 'duplicate within A is rejected');
  // ...but the same business is allowed in B (separate workspace).
  const sameInB = await storage.addLeads([{ name: 'Acme Cafe', phone: '+15551111111', country: 'USA', niche: 'cafe' }], { workspaceId: WS_B });
  check(sameInB.length === 1, 'same business allowed in a different workspace');

  await cleanup(storage);
}

async function cleanupScores(scoreStorage) {
  for (const ws of [WS_A, WS_B]) {
    const scores = await scoreStorage.getScores({ workspaceId: ws });
    if (scores.length) {
      await scoreStorage.deleteScores(scores.map(s => s.leadId), { workspaceId: ws });
    }
  }
}

async function testScoringIsolation(driver) {
  console.log(`\n=== Score isolation [STORAGE_DRIVER=${driver}] ===`);
  process.env.STORAGE_DRIVER = driver;
  const scoreStorage = require('../utils/scoreStorage');

  await cleanupScores(scoreStorage);

  const LEAD = 'lead-shared-1';
  // A and B both score the SAME lead id, with different results.
  await scoreStorage.upsertScores(
    [{ leadId: LEAD, score: 75, priority: 'hot', breakdown: { factors: [], total: 75, max: 100 }, model: 'heuristic' }],
    { workspaceId: WS_A },
  );
  await scoreStorage.upsertScores(
    [{ leadId: LEAD, score: 50, priority: 'warm', breakdown: { factors: [], total: 50, max: 100 }, model: 'heuristic' }],
    { workspaceId: WS_B },
  );

  const scoresA = await scoreStorage.getScores({ workspaceId: WS_A });
  const scoresB = await scoreStorage.getScores({ workspaceId: WS_B });
  check(scoresA.length === 1 && scoresA[0].score === 75, 'A sees only its own score (75)');
  check(scoresB.length === 1 && scoresB[0].score === 50, 'B sees only its own score (50)');
  check(!scoresA.some(s => s.score === 50), 'A does NOT see B score');
  check(scoresA[0].workspaceId === WS_A, 'A score is stamped with workspaceId');

  // Re-qualifying upserts (no duplicate row) within a workspace.
  await scoreStorage.upsertScores(
    [{ leadId: LEAD, score: 90, priority: 'hot', breakdown: { factors: [], total: 90, max: 100 }, model: 'heuristic' }],
    { workspaceId: WS_A },
  );
  const scoresAUpdated = await scoreStorage.getScores({ workspaceId: WS_A });
  check(scoresAUpdated.length === 1 && scoresAUpdated[0].score === 90, 're-qualify upserts in place (no dup, score=90)');

  // Cross-workspace delete must NOT remove B's score.
  await scoreStorage.deleteScores([LEAD], { workspaceId: WS_A });
  const scoresBAfter = await scoreStorage.getScores({ workspaceId: WS_B });
  check(scoresBAfter.length === 1 && scoresBAfter[0].score === 50, 'A delete does NOT remove B score (isolation enforced)');

  await cleanupScores(scoreStorage);
}

async function cleanupDrafts(draftStorage) {
  for (const ws of [WS_A, WS_B]) {
    for (const leadId of ['lead-shared-1', 'lead-shared-2']) {
      await draftStorage.deleteDraftsForLead(leadId, { workspaceId: ws });
    }
  }
}

async function testDraftIsolation(driver) {
  console.log(`\n=== Draft isolation [STORAGE_DRIVER=${driver}] ===`);
  process.env.STORAGE_DRIVER = driver;
  const draftStorage = require('../utils/draftStorage');

  await cleanupDrafts(draftStorage);

  const LEAD = 'lead-shared-1';
  const tplA = [{ channel: 'email', kind: 'initial', step: 0, waitDays: 0, subject: 'A', body: 'A body', model: 'heuristic' }];
  const tplB = [{ channel: 'whatsapp', kind: 'initial', step: 0, waitDays: 0, subject: null, body: 'B body', model: 'heuristic' }];

  const createdA = await draftStorage.replaceDraftsForLead(LEAD, tplA, { workspaceId: WS_A });
  const createdB = await draftStorage.replaceDraftsForLead(LEAD, tplB, { workspaceId: WS_B });
  check(createdA.length === 1 && createdB.length === 1, 'A and B each created 1 draft for same lead id');

  const draftsA = await draftStorage.getDrafts({ workspaceId: WS_A });
  const draftsB = await draftStorage.getDrafts({ workspaceId: WS_B });
  check(draftsA.length === 1 && draftsA[0].body === 'A body', 'A sees only its own draft');
  check(draftsB.length === 1 && draftsB[0].body === 'B body', 'B sees only its own draft');
  check(!draftsA.some(d => d.body === 'B body'), 'A does NOT see B draft');

  // Cross-workspace status change must NOT touch B's draft (id belongs to B).
  const bDraftId = draftsB[0].id;
  const crossUpdate = await draftStorage.setDraftStatus(bDraftId, 'approved', { workspaceId: WS_A });
  check(crossUpdate === null, 'A cannot approve B draft (returns null)');
  const draftsBStill = await draftStorage.getDrafts({ workspaceId: WS_B });
  check(draftsBStill[0].status === 'draft', 'B draft status unchanged after A attempt');

  // Owner can approve its own draft.
  const okUpdate = await draftStorage.setDraftStatus(draftsA[0].id, 'approved', { workspaceId: WS_A });
  check(okUpdate && okUpdate.status === 'approved', 'A can approve its own draft');

  // Regenerating replaces (no pile-up).
  const regen = await draftStorage.replaceDraftsForLead(LEAD, [...tplA, { channel: 'email', kind: 'followup', step: 1, waitDays: 3, subject: 'F', body: 'F body', model: 'heuristic' }], { workspaceId: WS_A });
  check(regen.length === 2, 'regenerate produces a fresh set');
  const afterRegen = await draftStorage.getDrafts({ workspaceId: WS_A });
  check(afterRegen.length === 2, 'regenerate replaced old drafts (no pile-up)');

  await cleanupDrafts(draftStorage);
}

async function cleanupConversations(convStorage) {
  for (const ws of [WS_A, WS_B]) {
    const convs = await convStorage.getConversations({ workspaceId: ws });
    // No public delete API for conversations in V1; tests use a dedicated lead id
    // and assert by isolation, so a residual row from a prior run is filtered by
    // workspace anyway. We simply re-read fresh state below.
    void convs;
  }
}

async function testConversationIsolation(driver) {
  console.log(`\n=== Conversation isolation [STORAGE_DRIVER=${driver}] ===`);
  process.env.STORAGE_DRIVER = driver;
  const convStorage = require('../utils/conversationStorage');

  await cleanupConversations(convStorage);

  const LEAD = `lead-conv-${Date.now()}`;

  // A and B each start a conversation for the SAME lead id + channel.
  const convA = await convStorage.createConversation({ leadId: LEAD, channel: 'email', subject: 'A subj' }, { workspaceId: WS_A });
  const convB = await convStorage.createConversation({ leadId: LEAD, channel: 'email', subject: 'B subj' }, { workspaceId: WS_B });
  check(!!convA.id && !!convB.id && convA.id !== convB.id, 'A and B each created a distinct conversation for the same lead');

  await convStorage.addMessage(convA.id, { direction: 'outbound', body: 'hello from A', source: 'ai_draft' }, { workspaceId: WS_A });
  await convStorage.addMessage(convB.id, { direction: 'outbound', body: 'hello from B', source: 'ai_draft' }, { workspaceId: WS_B });

  const listA = await convStorage.getConversations({ workspaceId: WS_A });
  const listB = await convStorage.getConversations({ workspaceId: WS_B });
  check(listA.some(c => c.id === convA.id) && !listA.some(c => c.id === convB.id), 'A sees only its own conversation');
  check(listB.some(c => c.id === convB.id) && !listB.some(c => c.id === convA.id), 'B does NOT see A conversation');

  // Cross-workspace message read must return nothing for B's conversation when asked as A.
  const crossMsgs = await convStorage.getMessages(convB.id, { workspaceId: WS_A });
  check(crossMsgs.length === 0, 'A cannot read messages of B conversation (isolation enforced)');

  // Cross-workspace append must be refused (returns null), B's thread unchanged.
  const crossAdd = await convStorage.addMessage(convB.id, { body: 'intruder' }, { workspaceId: WS_A });
  check(crossAdd === null, 'A cannot append to B conversation (returns null)');
  const bMsgs = await convStorage.getMessages(convB.id, { workspaceId: WS_B });
  check(bMsgs.length === 1 && bMsgs[0].body === 'hello from B', 'B thread unchanged after A attempt');

  // Owner append works and bumps the thread.
  const ownAdd = await convStorage.addMessage(convA.id, { body: 'second from A' }, { workspaceId: WS_A });
  check(!!ownAdd, 'A can append to its own conversation');
  const aMsgs = await convStorage.getMessages(convA.id, { workspaceId: WS_A });
  check(aMsgs.length === 2, 'A thread has both messages in order');
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

function testAuthMiddleware() {
  console.log('\n=== Auth middleware ===');
  const jwt = require('jsonwebtoken');

  // Re-require fresh (module reads env per-call, but keep it explicit).
  delete require.cache[require.resolve('../middleware/auth')];
  const { requireAuth } = require('../middleware/auth');

  // disabled: no token required, default workspace.
  process.env.AUTH_MODE = 'disabled';
  let nextCalled = false;
  let req = { headers: {} };
  requireAuth(req, mockRes(), () => { nextCalled = true; });
  check(nextCalled && req.auth && req.auth.workspaceId === (process.env.DEFAULT_WORKSPACE_ID || 'default'), 'disabled mode → next() + default workspace');

  // dev: missing token → 401.
  process.env.AUTH_MODE = 'dev';
  process.env.DEV_AUTH_SECRET = 'test-secret';
  let res = mockRes();
  nextCalled = false;
  requireAuth({ headers: {} }, res, () => { nextCalled = true; });
  check(!nextCalled && res.statusCode === 401, 'dev mode → 401 without token');

  // dev: invalid token → 401.
  res = mockRes();
  nextCalled = false;
  requireAuth({ headers: { authorization: 'Bearer not.a.jwt' } }, res, () => { nextCalled = true; });
  check(!nextCalled && res.statusCode === 401, 'dev mode → 401 with invalid token');

  // dev: valid token → next() + workspace from claim.
  const token = jwt.sign({ sub: 'user-1', app_metadata: { workspace_id: 'ws-claim-9' } }, 'test-secret', { algorithm: 'HS256' });
  req = { headers: { authorization: `Bearer ${token}` } };
  nextCalled = false;
  requireAuth(req, mockRes(), () => { nextCalled = true; });
  check(nextCalled && req.auth.workspaceId === 'ws-claim-9', 'dev mode → valid token resolves workspace from claim');

  process.env.AUTH_MODE = 'disabled';
}

async function main() {
  await testStorageIsolation('json');
  await testScoringIsolation('json');
  await testDraftIsolation('json');
  await testConversationIsolation('json');
  if (process.env.DATABASE_URL) {
    await testStorageIsolation('postgres');
    await testScoringIsolation('postgres');
    await testDraftIsolation('postgres');
    await testConversationIsolation('postgres');
  } else {
    console.log('\n(skipping Postgres storage isolation — DATABASE_URL not set)');
  }
  testAuthMiddleware();

  console.log(`\n${failures === 0 ? 'ALL ISOLATION TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('isolation tests crashed:', err);
  process.exit(1);
});
