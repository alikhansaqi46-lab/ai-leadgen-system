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
  if (process.env.DATABASE_URL) {
    await testStorageIsolation('postgres');
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
