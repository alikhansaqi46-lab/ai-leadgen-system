/**
 * Tracks OpenAI usage for Owner console (real token/cost events).
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { query } = require('../config/db');

const DATA_FILE = path.join(__dirname, '..', 'data', 'ai_usage_events.json');

// Default gpt-4o-mini-ish blended rates (USD per 1K tokens) — override via env
const INPUT_PER_1K = Number(process.env.OPENAI_COST_INPUT_PER_1K || 0.00015);
const OUTPUT_PER_1K = Number(process.env.OPENAI_COST_OUTPUT_PER_1K || 0.0006);

function driver() {
  const d = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  if (d === 'postgres' || d === 'pg') return 'postgres';
  if (d === 'json' || d === 'file') return 'json';
  return process.env.DATABASE_URL ? 'postgres' : 'json';
}

function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson() {
  ensureDir();
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

function writeJson(rows) {
  ensureDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(rows.slice(0, 20000), null, 2));
}

function estimateCost(promptTokens, completionTokens) {
  return (promptTokens / 1000) * INPUT_PER_1K + (completionTokens / 1000) * OUTPUT_PER_1K;
}

async function ensureTable() {
  if (driver() !== 'postgres') return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS ai_usage_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        user_id TEXT,
        source TEXT,
        model TEXT,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        estimated_cost_usd NUMERIC(12, 6) DEFAULT 0,
        meta JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (_) { /* ignore */ }
}

async function recordUsage({
  userId, workspaceId, source = 'openai', model, promptTokens = 0, completionTokens = 0,
  totalTokens = 0, meta = {},
} = {}) {
  const prompt = Number(promptTokens) || 0;
  const completion = Number(completionTokens) || 0;
  const total = Number(totalTokens) || (prompt + completion);
  const cost = estimateCost(prompt, completion);
  const row = {
    id: `aiu_${uuidv4()}`,
    workspace_id: workspaceId || userId || null,
    user_id: userId || null,
    source,
    model: model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    estimated_cost_usd: Math.round(cost * 1e6) / 1e6,
    meta,
    created_at: new Date().toISOString(),
  };

  await ensureTable();
  if (driver() === 'postgres') {
    try {
      await query(
        `INSERT INTO ai_usage_events
         (id, workspace_id, user_id, source, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, meta, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [row.id, row.workspace_id, row.user_id, row.source, row.model, row.prompt_tokens,
          row.completion_tokens, row.total_tokens, row.estimated_cost_usd, JSON.stringify(row.meta), row.created_at],
      );
      return row;
    } catch (err) {
      console.warn('[AiUsage] pg insert failed:', err.message);
    }
  }
  const list = readJson();
  list.unshift(row);
  writeJson(list);
  return row;
}

async function listUsage(limit = 500) {
  await ensureTable();
  if (driver() === 'postgres') {
    try {
      const { rows } = await query(
        'SELECT * FROM ai_usage_events ORDER BY created_at DESC LIMIT $1',
        [Math.min(limit, 5000)],
      );
      return rows;
    } catch (_) { /* fallback */ }
  }
  return readJson().slice(0, limit);
}

function startOfDay(d = new Date()) {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
}
function startOfMonth(d = new Date()) {
  const x = startOfDay(d); x.setDate(1); return x;
}

async function getOwnerUsageSummary() {
  const events = await listUsage(5000);
  const today = startOfDay();
  const month = startOfMonth();
  let totalTokens = 0;
  let totalCost = 0;
  let requestsToday = 0;
  let requestsMonth = 0;
  let tokensToday = 0;
  let tokensMonth = 0;
  let costToday = 0;
  let costMonth = 0;
  const byUser = {};

  for (const e of events) {
    const created = new Date(e.created_at || e.createdAt);
    const tokens = Number(e.total_tokens || e.totalTokens || 0);
    const cost = Number(e.estimated_cost_usd || e.estimatedCostUsd || 0);
    totalTokens += tokens;
    totalCost += cost;
    if (created >= month) {
      requestsMonth += 1;
      tokensMonth += tokens;
      costMonth += cost;
    }
    if (created >= today) {
      requestsToday += 1;
      tokensToday += tokens;
      costToday += cost;
    }
    const uid = e.user_id || e.userId || e.workspace_id || 'unknown';
    if (!byUser[uid]) byUser[uid] = { userId: uid, requests: 0, tokens: 0, cost: 0 };
    byUser[uid].requests += 1;
    byUser[uid].tokens += tokens;
    byUser[uid].cost += cost;
  }

  // Enrich top users with emails
  let topUsers = Object.values(byUser).sort((a, b) => b.requests - a.requests).slice(0, 10);
  try {
    const userStorage = require('../utils/userStorage');
    topUsers = await Promise.all(topUsers.map(async (u) => {
      const user = await userStorage.findById(u.userId).catch(() => null);
      return {
        ...u,
        email: user?.email || null,
        name: user?.full_name || user?.fullName || null,
        cost: Math.round(u.cost * 10000) / 10000,
      };
    }));
  } catch (_) { /* ignore */ }

  const byModel = {};
  for (const e of events) {
    const model = e.model || 'unknown';
    if (!byModel[model]) byModel[model] = { model, requests: 0, tokens: 0, cost: 0 };
    byModel[model].requests += 1;
    byModel[model].tokens += Number(e.total_tokens || e.totalTokens || 0);
    byModel[model].cost += Number(e.estimated_cost_usd || e.estimatedCostUsd || 0);
  }

  const liveBalance = await fetchOpenAiBalance().catch(() => null);
  const monthlyBudget = Number(process.env.OPENAI_MONTHLY_BUDGET_USD || 0);
  const avgTokensPerReq = requestsMonth > 0 ? tokensMonth / requestsMonth : 800;
  const avgCostPerReq = requestsMonth > 0 ? costMonth / requestsMonth : estimateCost(400, 400);
  let estimatedRemainingRequests = null;
  let remainingBudgetUsd = null;
  if (liveBalance?.remainingUsd != null && Number.isFinite(liveBalance.remainingUsd)) {
    remainingBudgetUsd = liveBalance.remainingUsd;
    if (avgCostPerReq > 0) {
      estimatedRemainingRequests = Math.max(0, Math.floor(liveBalance.remainingUsd / avgCostPerReq));
    }
  } else if (monthlyBudget > 0) {
    remainingBudgetUsd = Math.max(0, Math.round((monthlyBudget - costMonth) * 10000) / 10000);
    if (avgCostPerReq > 0) {
      estimatedRemainingRequests = Math.max(0, Math.floor(remainingBudgetUsd / avgCostPerReq));
    }
  }

  const masterConfigured = Boolean(process.env.OPENAI_API_KEY || process.env.MASTER_OPENAI_API_KEY);
  const keyProbe = await probeOpenAiKey().catch(() => null);

  return {
    totalTokens,
    totalApiCost: Math.round(totalCost * 10000) / 10000,
    requestsToday,
    requestsThisMonth: requestsMonth,
    tokensToday,
    tokensThisMonth: tokensMonth,
    costToday: Math.round(costToday * 10000) / 10000,
    costThisMonth: Math.round(costMonth * 10000) / 10000,
    estimatedRemainingRequests,
    remainingBudgetUsd,
    monthlyBudgetUsd: monthlyBudget || null,
    avgTokensPerRequest: Math.round(avgTokensPerReq),
    avgCostPerRequest: Math.round(avgCostPerReq * 1e6) / 1e6,
    topAiUsers: topUsers,
    byModel: Object.values(byModel)
      .map((m) => ({ ...m, cost: Math.round(m.cost * 10000) / 10000 }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 8),
    openAiBalance: liveBalance,
    openAiKeyStatus: keyProbe,
    masterKeyConfigured: masterConfigured,
    trackingEvents: events.length,
    note: !masterConfigured
      ? 'No OPENAI_API_KEY / MASTER_OPENAI_API_KEY configured. Usage will appear after real API calls.'
      : (liveBalance?.source === 'unavailable'
        ? 'Tracked from real chat.completions usage events. Set OPENAI_CREDIT_BALANCE_USD or OPENAI_MONTHLY_BUDGET_USD for remaining-request estimates (billing API needs org admin key).'
        : 'Usage tracked from real OpenAI chat.completions responses + configured balance/budget.'),
  };
}

async function probeOpenAiKey() {
  const key = process.env.OPENAI_API_KEY || process.env.MASTER_OPENAI_API_KEY;
  if (!key) return { ok: false, detail: 'No master OpenAI key' };
  try {
    const res = await axios.get('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 8000,
      validateStatus: () => true,
    });
    return {
      ok: res.status === 200,
      status: res.status,
      detail: res.status === 200 ? 'Master OpenAI key valid' : `Key probe HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

/**
 * Attempt live OpenAI billing/balance.
 * Official consumer API keys usually cannot access billing; we try known endpoints
 * and fall back to OPENAI_CREDIT_BALANCE_USD / OPENAI_MONTHLY_BUDGET_USD.
 */
async function fetchOpenAiBalance() {
  const key = process.env.OPENAI_API_KEY || process.env.MASTER_OPENAI_API_KEY;
  const adminKey = process.env.OPENAI_ADMIN_KEY || key;
  const configuredBalance = process.env.OPENAI_CREDIT_BALANCE_USD != null
    ? Number(process.env.OPENAI_CREDIT_BALANCE_USD)
    : null;

  if (configuredBalance != null && Number.isFinite(configuredBalance)) {
    return {
      remainingUsd: configuredBalance,
      source: 'env:OPENAI_CREDIT_BALANCE_USD',
      live: false,
      detail: 'Configured owner credit balance',
    };
  }

  if (!adminKey) {
    return { remainingUsd: null, source: 'unavailable', live: false, detail: 'No OpenAI key configured' };
  }

  // Try organization costs (may fail for non-admin keys — that's OK)
  try {
    const start = startOfMonth().toISOString().slice(0, 10);
    const end = new Date().toISOString().slice(0, 10);
    const res = await axios.get('https://api.openai.com/v1/organization/costs', {
      headers: { Authorization: `Bearer ${adminKey}` },
      params: { start_time: Math.floor(startOfMonth().getTime() / 1000), limit: 1 },
      timeout: 8000,
      validateStatus: () => true,
    });
    if (res.status === 200 && res.data) {
      return {
        remainingUsd: null,
        source: 'openai:organization/costs',
        live: true,
        detail: 'Organization costs endpoint reachable',
        rawHint: { start, end, status: res.status },
      };
    }
  } catch (_) { /* ignore */ }

  return {
    remainingUsd: null,
    source: 'unavailable',
    live: false,
    detail: 'OpenAI balance API not available for this key — use OPENAI_CREDIT_BALANCE_USD or tracked cost',
  };
}

module.exports = {
  recordUsage,
  listUsage,
  getOwnerUsageSummary,
  fetchOpenAiBalance,
  estimateCost,
};
