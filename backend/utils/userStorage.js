/**
 * User Storage Module
 * Supports postgres and json (file) drivers.
 */

const { query } = require('../config/db');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = path.join(__dirname, '..', 'data', 'users.json');

function resolveDriver() {
  const d = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  if (d === 'postgres' || d === 'pg') return 'postgres';
  if (d === 'json' || d === 'file') return 'json';
  // auto: try postgres if DATABASE_URL is set, else json
  return process.env.DATABASE_URL ? 'postgres' : 'json';
}

let pgFallbackWarned = false;
function isPgUnavailable(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return (
    msg.includes('self-signed certificate')
    || msg.includes('certificate chain')
    || msg.includes('unable to verify the first certificate')
    || msg.includes('econnrefused')
    || msg.includes('connection terminated')
    || msg.includes('timeout')
    || msg.includes('enotfound')
  );
}

function warnPgFallback(err) {
  if (pgFallbackWarned) return;
  pgFallbackWarned = true;
  console.warn(
    '[UserStorage] Postgres unavailable — falling back to users.json for auth. '
    + 'Fix TLS with TLS_CA_FILE / NODE_EXTRA_CA_CERTS. Detail:',
    err && err.message
  );
}

/** Run postgres path; on TLS/connectivity failure, use JSON path. */
async function withPgFallback(pgFn, jsonFn) {
  if (resolveDriver() !== 'postgres') return jsonFn();
  try {
    return await pgFn();
  } catch (err) {
    if (!isPgUnavailable(err)) throw err;
    warnPgFallback(err);
    return jsonFn();
  }
}

/* ==================== JSON DRIVER ==================== */

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJson() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}

function saveJson(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/* ==================== CRUD ==================== */

const { encrypt, decrypt } = require('./encryption');

async function createUser({ id, fullName, businessName, email, whatsappNumber, passwordHash, role }) {
  const driver = resolveDriver();
  const userId = id || `usr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const userRole = role || 'subscriber';
  if (driver === 'postgres') {
    await query(
      `INSERT INTO users (id, full_name, business_name, email, whatsapp_number, password_hash, serp_api_key, role, subscription_status, free_ai_messages_remaining)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [userId, fullName, businessName, email.toLowerCase(), whatsappNumber || null, passwordHash, null, userRole, 'none', 100]
    );
  } else {
    const data = loadJson();
    if (data[email.toLowerCase()]) throw new Error('Email already exists');
    data[email.toLowerCase()] = {
      id: userId, full_name: fullName, business_name: businessName,
      email: email.toLowerCase(), whatsapp_number: whatsappNumber || null,
      password_hash: passwordHash, email_verified: false,
      email_code: null, reset_code: null, serp_api_key: null,
      role: userRole, subscription_status: 'none', subscription_plan: null,
      subscription_id: null, subscription_expires_at: null,
      openai_api_key: null, openai_api_enabled: false,
      free_ai_messages_remaining: 100, openai_source: 'master',
      created_at: new Date().toISOString()
    };
    saveJson(data);
  }
  return userId;
}

async function findByEmail(email) {
  const e = email.toLowerCase();
  return withPgFallback(
    async () => {
      const { rows } = await query('SELECT * FROM users WHERE email = $1 LIMIT 1', [e]);
      return rows[0] || null;
    },
    () => {
      const data = loadJson();
      return data[e] || null;
    }
  );
}

async function findById(id) {
  return withPgFallback(
    async () => {
      const { rows } = await query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
      return rows[0] || null;
    },
    () => {
      const data = loadJson();
      return Object.values(data).find((u) => u.id === id) || null;
    }
  );
}

async function findBySubscriptionId(subscriptionId) {
  const driver = resolveDriver();
  if (driver === 'postgres') {
    const { rows } = await query('SELECT * FROM users WHERE subscription_id = $1 LIMIT 1', [subscriptionId]);
    return rows[0] || null;
  }
  const data = loadJson();
  return Object.values(data).find(u => u.subscription_id === subscriptionId) || null;
}

async function setSubscription(userId, updates) {
  const driver = resolveDriver();
  const allowed = ['subscription_status', 'subscription_plan', 'subscription_id', 'subscription_expires_at'];
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [k, v] of Object.entries(updates)) {
    if (!allowed.includes(k)) continue;
    const col = k.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
    fields.push(`${col} = $${idx}`);
    values.push(v);
    idx++;
  }
  if (fields.length === 0) return;
  values.push(userId);
  if (driver === 'postgres') {
    await query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, values);
  } else {
    const data = loadJson();
    const u = Object.values(data).find(x => x.id === userId);
    if (u) {
      for (const [k, v] of Object.entries(updates)) {
        if (!allowed.includes(k)) continue;
        const col = k.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
        u[col] = v;
      }
      saveJson(data);
    }
  }
}

async function setEmailCode(email, code) {
  const driver = resolveDriver();
  const e = email.toLowerCase();
  if (driver === 'postgres') {
    await query('UPDATE users SET email_code = $1 WHERE email = $2', [code, e]);
  } else {
    const data = loadJson();
    if (data[e]) { data[e].email_code = code; saveJson(data); }
  }
}

async function verifyEmail(email, code) {
  const driver = resolveDriver();
  const e = email.toLowerCase();
  if (driver === 'postgres') {
    const { rows } = await query('SELECT * FROM users WHERE email = $1 AND email_code = $2 LIMIT 1', [e, code]);
    if (!rows[0]) return false;
    await query('UPDATE users SET email_verified = TRUE, email_code = NULL WHERE email = $1', [e]);
    return true;
  }
  const data = loadJson();
  if (!data[e] || data[e].email_code !== code) return false;
  data[e].email_verified = true;
  data[e].email_code = null;
  saveJson(data);
  return true;
}

async function setResetCode(email, code) {
  const driver = resolveDriver();
  const e = email.toLowerCase();
  if (driver === 'postgres') {
    await query('UPDATE users SET reset_code = $1 WHERE email = $2', [code, e]);
  } else {
    const data = loadJson();
    if (data[e]) { data[e].reset_code = code; saveJson(data); }
  }
}

async function resetPassword(email, code, passwordHash) {
  const driver = resolveDriver();
  const e = email.toLowerCase();
  if (driver === 'postgres') {
    const { rows } = await query('SELECT * FROM users WHERE email = $1 AND reset_code = $2 LIMIT 1', [e, code]);
    if (!rows[0]) return false;
    await query('UPDATE users SET password_hash = $1, reset_code = NULL WHERE email = $2', [passwordHash, e]);
    return true;
  }
  const data = loadJson();
  if (!data[e] || data[e].reset_code !== code) return false;
  data[e].password_hash = passwordHash;
  data[e].reset_code = null;
  saveJson(data);
  return true;
}

/* ==================== OpenAI Key Management ==================== */

async function getOpenAiKey(userId) {
  const driver = resolveDriver();
  if (driver === 'postgres') {
    const { rows } = await query('SELECT openai_api_key FROM users WHERE id = $1 LIMIT 1', [userId]);
    return rows[0]?.openai_api_key ? decrypt(rows[0].openai_api_key) : null;
  }
  const data = loadJson();
  const u = Object.values(data).find(x => x.id === userId);
  return u?.openai_api_key ? decrypt(u.openai_api_key) : null;
}

async function setOpenAiKey(userId, apiKey) {
  const driver = resolveDriver();
  const encrypted = apiKey ? encrypt(apiKey) : null;
  if (driver === 'postgres') {
    await query(
      'UPDATE users SET openai_api_key = $1, openai_api_enabled = TRUE, openai_source = $2 WHERE id = $3',
      [encrypted, 'user', userId]
    );
  } else {
    const data = loadJson();
    const u = Object.values(data).find(x => x.id === userId);
    if (u) {
      u.openai_api_key = encrypted;
      u.openai_api_enabled = true;
      u.openai_source = 'user';
      saveJson(data);
    }
  }
}

async function deleteOpenAiKey(userId) {
  const driver = resolveDriver();
  if (driver === 'postgres') {
    await query(
      'UPDATE users SET openai_api_key = NULL, openai_api_enabled = FALSE, openai_source = $1 WHERE id = $2',
      ['master', userId]
    );
  } else {
    const data = loadJson();
    const u = Object.values(data).find(x => x.id === userId);
    if (u) {
      u.openai_api_key = null;
      u.openai_api_enabled = false;
      u.openai_source = 'master';
      saveJson(data);
    }
  }
}

/* ==================== Free AI Messages ==================== */

async function getFreeAiMessages(userId) {
  const driver = resolveDriver();
  if (driver === 'postgres') {
    const { rows } = await query('SELECT free_ai_messages_remaining FROM users WHERE id = $1 LIMIT 1', [userId]);
    return rows[0]?.free_ai_messages_remaining ?? 0;
  }
  const data = loadJson();
  const u = Object.values(data).find(x => x.id === userId);
  return u?.free_ai_messages_remaining ?? 0;
}

async function decrementFreeAiMessages(userId) {
  const driver = resolveDriver();
  if (driver === 'postgres') {
    await query(
      'UPDATE users SET free_ai_messages_remaining = GREATEST(free_ai_messages_remaining - 1, 0) WHERE id = $1',
      [userId]
    );
    const { rows } = await query('SELECT free_ai_messages_remaining FROM users WHERE id = $1 LIMIT 1', [userId]);
    return rows[0]?.free_ai_messages_remaining ?? 0;
  }
  const data = loadJson();
  const u = Object.values(data).find(x => x.id === userId);
  if (u) {
    u.free_ai_messages_remaining = Math.max((u.free_ai_messages_remaining ?? 0) - 1, 0);
    saveJson(data);
    return u.free_ai_messages_remaining;
  }
  return 0;
}

async function resetFreeAiMessages(userId, amount = 100) {
  const driver = resolveDriver();
  if (driver === 'postgres') {
    await query('UPDATE users SET free_ai_messages_remaining = $1 WHERE id = $2', [amount, userId]);
  } else {
    const data = loadJson();
    const u = Object.values(data).find(x => x.id === userId);
    if (u) {
      u.free_ai_messages_remaining = amount;
      saveJson(data);
    }
  }
}

async function updateUser(id, updates) {
  const driver = resolveDriver();
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [k, v] of Object.entries(updates)) {
    const col = k.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
    fields.push(`${col} = $${idx}`);
    values.push(v);
    idx++;
  }
  if (fields.length === 0) return;
  values.push(id);
  if (driver === 'postgres') {
    await query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, values);
  } else {
    const data = loadJson();
    const u = Object.values(data).find(x => x.id === id);
    if (u) {
      for (const [k, v] of Object.entries(updates)) {
        const col = k.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
        u[col] = v;
      }
      saveJson(data);
    }
  }
}

/* ==================== Preview & Trust Mode Settings ==================== */

async function getPreviewSettings(userId) {
  const driver = resolveDriver();
  if (driver === 'postgres') {
    const { rows } = await query('SELECT preview_settings FROM users WHERE id = $1 LIMIT 1', [userId]);
    return rows[0]?.preview_settings || {};
  }
  const data = loadJson();
  const u = Object.values(data).find(x => x.id === userId);
  return u?.preview_settings || {};
}

async function updatePreviewSettings(userId, settings) {
  const driver = resolveDriver();
  const merged = { ...settings };
  if (driver === 'postgres') {
    await query('UPDATE users SET preview_settings = $1 WHERE id = $2', [JSON.stringify(merged), userId]);
  } else {
    const data = loadJson();
    const u = Object.values(data).find(x => x.id === userId);
    if (u) {
      u.preview_settings = merged;
      saveJson(data);
    }
  }
}

async function ensureAiAgentConfigColumn() {
  const driver = resolveDriver();
  if (driver !== 'postgres') return;
  try {
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_agent_config JSONB DEFAULT \'{}\'');
  } catch (err) {
    console.warn('[UserStorage] ensureAiAgentConfigColumn:', err.message);
  }
}

function parseJsonConfig(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function getAiAgentConfig(userId) {
  const driver = resolveDriver();
  if (driver === 'postgres') {
    try {
      await ensureAiAgentConfigColumn();
      const { rows } = await query('SELECT ai_agent_config FROM users WHERE id = $1 LIMIT 1', [userId]);
      return parseJsonConfig(rows[0]?.ai_agent_config);
    } catch (err) {
      console.warn('[UserStorage] getAiAgentConfig fallback:', err.message);
      return {};
    }
  }
  const data = loadJson();
  const u = Object.values(data).find(x => x.id === userId);
  return parseJsonConfig(u?.ai_agent_config);
}

async function updateAiAgentConfig(userId, config) {
  const driver = resolveDriver();
  const current = await getAiAgentConfig(userId);
  const merged = { ...current, ...(config || {}) };
  if (driver === 'postgres') {
    try {
      await ensureAiAgentConfigColumn();
      await query('UPDATE users SET ai_agent_config = $1::jsonb WHERE id = $2', [JSON.stringify(merged), userId]);
    } catch (err) {
      console.error('[UserStorage] updateAiAgentConfig failed:', err.message);
      throw err;
    }
  } else {
    const data = loadJson();
    const u = Object.values(data).find(x => x.id === userId);
    if (u) {
      u.ai_agent_config = merged;
      saveJson(data);
    }
  }
  return merged;
}

/* ==================== Channel Brain Config (per-channel independent settings) ==================== */

/**
 * Get the configuration for a specific channel brain.
 * Config is stored inside the ai_agent_config JSON as a nested object: { whatsappBrain: {...}, emailBrain: {...}, smsBrain: {...} }
 * If no channel-specific config exists, returns an empty object (defaults applied by the route).
 * @param {string} userId
 * @param {'whatsapp'|'email'|'sms'} channel
 * @returns {Promise<Object>}
 */
async function getChannelBrainConfig(userId, channel) {
  const driver = resolveDriver();
  let config = {};
  if (driver === 'postgres') {
    try {
      await ensureAiAgentConfigColumn();
      const { rows } = await query('SELECT ai_agent_config FROM users WHERE id = $1 LIMIT 1', [userId]);
      config = parseJsonConfig(rows[0]?.ai_agent_config);
    } catch (err) {
      console.warn(`[UserStorage] getChannelBrainConfig(${channel}) fallback:`, err.message);
      return {};
    }
  } else {
    const data = loadJson();
    const u = Object.values(data).find(x => x.id === userId);
    config = parseJsonConfig(u?.ai_agent_config);
  }
  const brainKey = `${channel}Brain`;
  return config[brainKey] || {};
}

/**
 * Update the configuration for a specific channel brain.
 * Merges into the existing ai_agent_config JSON under the key `{channel}Brain`.
 * @param {string} userId
 * @param {'whatsapp'|'email'|'sms'} channel
 * @param {Object} brainConfig - the channel-specific brain config to merge
 * @returns {Promise<Object>} the updated channel brain config
 */
async function updateChannelBrainConfig(userId, channel, brainConfig) {
  const driver = resolveDriver();
  const brainKey = `${channel}Brain`;
  let current = {};
  if (driver === 'postgres') {
    try {
      await ensureAiAgentConfigColumn();
      const { rows } = await query('SELECT ai_agent_config FROM users WHERE id = $1 LIMIT 1', [userId]);
      current = parseJsonConfig(rows[0]?.ai_agent_config);
    } catch (err) {
      console.warn(`[UserStorage] updateChannelBrainConfig(${channel}) read fallback:`, err.message);
    }
  } else {
    const data = loadJson();
    const u = Object.values(data).find(x => x.id === userId);
    current = parseJsonConfig(u?.ai_agent_config);
  }
  current[brainKey] = { ...(current[brainKey] || {}), ...(brainConfig || {}) };
  if (driver === 'postgres') {
    try {
      await ensureAiAgentConfigColumn();
      await query('UPDATE users SET ai_agent_config = $1::jsonb WHERE id = $2', [JSON.stringify(current), userId]);
    } catch (err) {
      console.error(`[UserStorage] updateChannelBrainConfig(${channel}) failed:`, err.message);
      throw err;
    }
  } else {
    const data = loadJson();
    const u = Object.values(data).find(x => x.id === userId);
    if (u) {
      u.ai_agent_config = current;
      saveJson(data);
    }
  }
  return current[brainKey] || {};
}

/* ==================== Email Settings ==================== */

const DEFAULT_EMAIL_SETTINGS = {
  includeUnsubscribeFooter: false,
};

async function ensureEmailSettingsColumn() {
  const driver = resolveDriver();
  if (driver !== 'postgres') return;
  try {
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_settings JSONB DEFAULT \'{}\'');
  } catch (err) {
    console.warn('[UserStorage] ensureEmailSettingsColumn:', err.message);
  }
}

async function getEmailSettings(userId) {
  const driver = resolveDriver();
  if (driver === 'postgres') {
    try {
      await ensureEmailSettingsColumn();
      const { rows } = await query('SELECT email_settings FROM users WHERE id = $1 LIMIT 1', [userId]);
      return { ...DEFAULT_EMAIL_SETTINGS, ...parseJsonConfig(rows[0]?.email_settings) };
    } catch (err) {
      console.warn('[UserStorage] getEmailSettings fallback:', err.message);
      return { ...DEFAULT_EMAIL_SETTINGS };
    }
  }
  const data = loadJson();
  const u = Object.values(data).find(x => x.id === userId);
  return { ...DEFAULT_EMAIL_SETTINGS, ...parseJsonConfig(u?.email_settings) };
}

async function updateEmailSettings(userId, settings) {
  const driver = resolveDriver();
  const current = await getEmailSettings(userId);
  const merged = { ...current, ...(settings || {}) };
  if (driver === 'postgres') {
    try {
      await ensureEmailSettingsColumn();
      await query('UPDATE users SET email_settings = $1::jsonb WHERE id = $2', [JSON.stringify(merged), userId]);
    } catch (err) {
      console.error('[UserStorage] updateEmailSettings failed:', err.message);
      throw err;
    }
  } else {
    const data = loadJson();
    const u = Object.values(data).find(x => x.id === userId);
    if (u) {
      u.email_settings = merged;
      saveJson(data);
    }
  }
  return merged;
}

async function getSerpApiKey(userId) {
  const driver = resolveDriver();
  if (driver === 'postgres') {
    const { rows } = await query('SELECT serp_api_key FROM users WHERE id = $1 LIMIT 1', [userId]);
    return rows[0]?.serp_api_key || null;
  }
  const data = loadJson();
  const u = Object.values(data).find(x => x.id === userId);
  return u?.serp_api_key || null;
}

async function setSerpApiKey(userId, apiKey) {
  const driver = resolveDriver();
  if (driver === 'postgres') {
    await query('UPDATE users SET serp_api_key = $1 WHERE id = $2', [apiKey, userId]);
  } else {
    const data = loadJson();
    const u = Object.values(data).find(x => x.id === userId);
    if (u) {
      u.serp_api_key = apiKey;
      saveJson(data);
    }
  }
}

async function getSenderEmail(userId) {
  const driver = resolveDriver();
  if (driver === 'postgres') {
    const { rows } = await query('SELECT sender_email FROM users WHERE id = $1 LIMIT 1', [userId]);
    return rows[0]?.sender_email || null;
  }
  const data = loadJson();
  const u = Object.values(data).find(x => x.id === userId);
  return u?.sender_email || null;
}

async function setSenderEmail(userId, email) {
  const driver = resolveDriver();
  const normalized = email ? email.toLowerCase().trim() : null;
  if (driver === 'postgres') {
    await query('UPDATE users SET sender_email = $1 WHERE id = $2', [normalized, userId]);
  } else {
    const data = loadJson();
    const u = Object.values(data).find(x => x.id === userId);
    if (u) {
      u.sender_email = normalized;
      saveJson(data);
    }
  }
}

function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    businessName: row.business_name,
    email: row.email,
    whatsappNumber: row.whatsapp_number,
    emailVerified: row.email_verified,
    role: row.role || 'subscriber',
    subscriptionStatus: row.subscription_status || 'none',
    subscriptionPlan: row.subscription_plan || null,
    subscriptionExpiresAt: row.subscription_expires_at || null,
    openaiApiEnabled: row.openai_api_enabled || false,
    openaiSource: row.openai_source || 'master',
    freeAiMessagesRemaining: row.free_ai_messages_remaining ?? 100,
    senderEmail: row.sender_email || null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || null,
    lastLoginIp: row.last_login_ip || null,
    lastLoginUserAgent: row.last_login_user_agent || null,
    lastLoginCountry: row.last_login_country || null,
    accountStatus: row.account_status || 'active',
    suspendedAt: row.suspended_at || null,
    suspendedReason: row.suspended_reason || null,
  };
}

async function ensureAdminUserColumns() {
  if (resolveDriver() !== 'postgres') return;
  const cols = [
    'last_login_at TIMESTAMPTZ',
    'last_login_ip TEXT',
    'last_login_user_agent TEXT',
    'last_login_country TEXT',
    "account_status TEXT DEFAULT 'active'",
    'suspended_at TIMESTAMPTZ',
    'suspended_reason TEXT',
  ];
  for (const col of cols) {
    try {
      await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col}`);
    } catch (err) {
      console.warn('[UserStorage] ensureAdminUserColumns:', col, err.message);
    }
  }
}

async function listUsers() {
  await ensureAdminUserColumns().catch(() => null);
  return withPgFallback(
    async () => {
      const { rows } = await query(
        `SELECT id, full_name, business_name, email, whatsapp_number, email_verified, role,
                subscription_status, subscription_plan, subscription_id, subscription_expires_at,
                openai_api_enabled, openai_source, free_ai_messages_remaining, sender_email, created_at,
                last_login_at, last_login_ip, last_login_user_agent, last_login_country,
                account_status, suspended_at, suspended_reason
         FROM users
         ORDER BY created_at DESC NULLS LAST`,
      );
      return rows;
    },
    async () => Object.values(loadJson()),
  );
}

async function recordLoginActivity(userId, { ip, userAgent, country } = {}) {
  await ensureAdminUserColumns().catch(() => null);
  const now = new Date().toISOString();
  if (resolveDriver() === 'postgres') {
    try {
      await query(
        `UPDATE users SET
           last_login_at = $1,
           last_login_ip = $2,
           last_login_user_agent = $3,
           last_login_country = $4
         WHERE id = $5`,
        [now, ip || null, userAgent || null, country || null, userId],
      );
      return;
    } catch (err) {
      console.warn('[UserStorage] recordLoginActivity pg:', err.message);
    }
  }
  const data = loadJson();
  const u = Object.values(data).find((x) => x.id === userId);
  if (u) {
    u.last_login_at = now;
    u.last_login_ip = ip || null;
    u.last_login_user_agent = userAgent || null;
    u.last_login_country = country || null;
    saveJson(data);
  }
}

async function deleteUser(userId) {
  if (resolveDriver() === 'postgres') {
    await query('DELETE FROM users WHERE id = $1', [userId]);
    return true;
  }
  const data = loadJson();
  const entry = Object.entries(data).find(([, u]) => u.id === userId);
  if (!entry) return false;
  delete data[entry[0]];
  saveJson(data);
  return true;
}

module.exports = {
  createUser, findByEmail, findById, findBySubscriptionId,
  setEmailCode, verifyEmail, setResetCode, resetPassword,
  updateUser, getSerpApiKey, setSerpApiKey, setSubscription,
  getOpenAiKey, setOpenAiKey, deleteOpenAiKey,
  getFreeAiMessages, decrementFreeAiMessages, resetFreeAiMessages,
  getPreviewSettings, updatePreviewSettings,
  getEmailSettings, updateEmailSettings,
  getAiAgentConfig, updateAiAgentConfig,
  getChannelBrainConfig, updateChannelBrainConfig,
  getSenderEmail, setSenderEmail,
  toPublicUser, resolveDriver,
  listUsers, recordLoginActivity, deleteUser, ensureAdminUserColumns,
};
