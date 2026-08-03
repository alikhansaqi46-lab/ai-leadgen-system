/**
 * User session tracking for Owner Console online users + idle timeout.
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const userStorage = require('../utils/userStorage');
const adminAudit = require('../utils/adminAudit');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'admin_sessions.json');

function driver() {
  return userStorage.resolveDriver();
}

function readJson() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeJson(rows) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(rows.slice(0, 5000), null, 2));
}

async function ensureTable() {
  if (driver() !== 'postgres') return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS admin_user_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        email TEXT,
        ip TEXT,
        user_agent TEXT,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ,
        revoke_reason TEXT
      )
    `);
    await query('CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_user_sessions (user_id, last_seen_at DESC)');
    await query('CREATE INDEX IF NOT EXISTS idx_admin_sessions_seen ON admin_user_sessions (last_seen_at DESC)');
  } catch (_) { /* ignore */ }
}

async function createSession({ userId, email, ip, userAgent }) {
  await ensureTable();
  const row = {
    id: `sess_${uuidv4()}`,
    user_id: userId,
    email: email || null,
    ip: ip || null,
    user_agent: userAgent || null,
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    revoked_at: null,
    revoke_reason: null,
  };
  if (driver() === 'postgres') {
    try {
      await query(
        `INSERT INTO admin_user_sessions
         (id, user_id, email, ip, user_agent, last_seen_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [row.id, row.user_id, row.email, row.ip, row.user_agent, row.last_seen_at, row.created_at],
      );
      return row;
    } catch (err) {
      console.warn('[Sessions] create pg failed:', err.message);
    }
  }
  const list = readJson();
  list.unshift(row);
  writeJson(list);
  return row;
}

async function touchSession(sessionId, { ip, userAgent } = {}) {
  if (!sessionId) return null;
  await ensureTable();
  const now = new Date().toISOString();
  if (driver() === 'postgres') {
    try {
      const { rows } = await query(
        `UPDATE admin_user_sessions
         SET last_seen_at = $1,
             ip = COALESCE($2, ip),
             user_agent = COALESCE($3, user_agent)
         WHERE id = $4 AND revoked_at IS NULL
         RETURNING *`,
        [now, ip || null, userAgent || null, sessionId],
      );
      return rows[0] || null;
    } catch (_) { /* fallback */ }
  }
  const list = readJson();
  const idx = list.findIndex((s) => s.id === sessionId);
  if (idx < 0 || list[idx].revoked_at) return null;
  list[idx].last_seen_at = now;
  if (ip) list[idx].ip = ip;
  if (userAgent) list[idx].user_agent = userAgent;
  writeJson(list);
  return list[idx];
}

async function getSession(sessionId) {
  if (!sessionId) return null;
  await ensureTable();
  if (driver() === 'postgres') {
    try {
      const { rows } = await query('SELECT * FROM admin_user_sessions WHERE id = $1 LIMIT 1', [sessionId]);
      return rows[0] || null;
    } catch (_) { /* fallback */ }
  }
  return readJson().find((s) => s.id === sessionId) || null;
}

async function revokeSession(sessionId, reason = 'logout') {
  if (!sessionId) return false;
  await ensureTable();
  const now = new Date().toISOString();
  if (driver() === 'postgres') {
    try {
      await query(
        `UPDATE admin_user_sessions SET revoked_at = $1, revoke_reason = $2 WHERE id = $3 AND revoked_at IS NULL`,
        [now, reason, sessionId],
      );
      return true;
    } catch (_) { /* fallback */ }
  }
  const list = readJson();
  const s = list.find((x) => x.id === sessionId);
  if (!s || s.revoked_at) return false;
  s.revoked_at = now;
  s.revoke_reason = reason;
  writeJson(list);
  return true;
}

async function revokeAllUserSessions(userId, reason = 'logout_all') {
  await ensureTable();
  const now = new Date().toISOString();
  if (driver() === 'postgres') {
    try {
      await query(
        `UPDATE admin_user_sessions SET revoked_at = $1, revoke_reason = $2
         WHERE user_id = $3 AND revoked_at IS NULL`,
        [now, reason, userId],
      );
      return true;
    } catch (_) { /* fallback */ }
  }
  const list = readJson().map((s) => {
    if (s.user_id === userId && !s.revoked_at) {
      return { ...s, revoked_at: now, revoke_reason: reason };
    }
    return s;
  });
  writeJson(list);
  return true;
}

async function getTimeoutMinutes(user) {
  const security = await adminAudit.getSetting('security', {
    adminSessionTimeoutMinutes: 60,
    userSessionTimeoutMinutes: 120,
  });
  const isAdmin = (user?.role === 'super_admin') || false;
  const mins = isAdmin
    ? Number(security.adminSessionTimeoutMinutes || 60)
    : Number(security.userSessionTimeoutMinutes || security.adminSessionTimeoutMinutes || 120);
  return Math.max(5, Math.min(mins || 60, 60 * 24 * 30));
}

/**
 * Validate session idle timeout. Returns { ok, reason, session }.
 */
async function validateSession(sessionId, user) {
  if (!sessionId) {
    // Legacy tokens without sid — allow but not counted as live session
    return { ok: true, legacy: true, session: null };
  }
  const session = await getSession(sessionId);
  if (!session) {
    // Session row missing (DB maintenance / cleanup) — allow valid JWT to proceed;
    // touchSession will no-op and the next login mints a fresh sid.
    return { ok: true, legacy: true, session: null, recovered: true };
  }
  if (session.revoked_at) return { ok: false, reason: 'Session revoked' };

  const timeoutMins = await getTimeoutMinutes(user);
  const last = new Date(session.last_seen_at || session.created_at).getTime();
  const idleMs = Date.now() - last;
  if (idleMs > timeoutMins * 60 * 1000) {
    await revokeSession(sessionId, 'idle_timeout');
    return { ok: false, reason: `Session expired after ${timeoutMins} minutes idle` };
  }
  return { ok: true, session, timeoutMins };
}

async function listOnlineSessions(withinMinutes = 5) {
  await ensureTable();
  const since = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
  if (driver() === 'postgres') {
    try {
      const { rows } = await query(
        `SELECT DISTINCT ON (user_id) *
         FROM admin_user_sessions
         WHERE revoked_at IS NULL AND last_seen_at >= $1
         ORDER BY user_id, last_seen_at DESC`,
        [since],
      );
      return rows;
    } catch (_) { /* fallback */ }
  }
  const map = {};
  for (const s of readJson()) {
    if (s.revoked_at) continue;
    if (new Date(s.last_seen_at) < new Date(since)) continue;
    if (!map[s.user_id] || new Date(s.last_seen_at) > new Date(map[s.user_id].last_seen_at)) {
      map[s.user_id] = s;
    }
  }
  return Object.values(map);
}

module.exports = {
  ensureTable,
  createSession,
  touchSession,
  getSession,
  revokeSession,
  revokeAllUserSessions,
  validateSession,
  listOnlineSessions,
  getTimeoutMinutes,
};
