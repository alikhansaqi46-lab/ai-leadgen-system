/**
 * Super Admin audit + notification + payment event persistence.
 * Postgres preferred; JSON file fallback under backend/data/.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIT_FILE = path.join(DATA_DIR, 'admin_audit.json');
const AUTH_FILE = path.join(DATA_DIR, 'admin_auth_events.json');
const NOTIF_FILE = path.join(DATA_DIR, 'admin_notifications.json');
const PAY_FILE = path.join(DATA_DIR, 'admin_payments.json');
const EXPIRY_FILE = path.join(DATA_DIR, 'admin_expiry.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'admin_settings.json');
const ERROR_FILE = path.join(DATA_DIR, 'admin_errors.json');

function driver() {
  const d = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  if (d === 'postgres' || d === 'pg') return 'postgres';
  if (d === 'json' || d === 'file') return 'json';
  return process.env.DATABASE_URL ? 'postgres' : 'json';
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback = []) {
  ensureDir();
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function recordAudit({ actorId, actorEmail, action, targetType, targetId, details, ip, userAgent }) {
  const row = {
    id: `aud_${uuidv4()}`,
    actor_id: actorId || null,
    actor_email: actorEmail || null,
    action,
    target_type: targetType || null,
    target_id: targetId || null,
    details: details || {},
    ip: ip || null,
    user_agent: userAgent || null,
    created_at: new Date().toISOString(),
  };
  if (driver() === 'postgres') {
    try {
      await query(
        `INSERT INTO admin_audit_logs (id, actor_id, actor_email, action, target_type, target_id, details, ip, user_agent, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [row.id, row.actor_id, row.actor_email, row.action, row.target_type, row.target_id,
          JSON.stringify(row.details), row.ip, row.user_agent, row.created_at],
      );
      return row;
    } catch (err) {
      console.warn('[AdminAudit] postgres insert failed, JSON fallback:', err.message);
    }
  }
  const list = readJson(AUDIT_FILE, []);
  list.unshift(row);
  writeJson(AUDIT_FILE, list.slice(0, 2000));
  return row;
}

async function listAudit(limit = 100) {
  if (driver() === 'postgres') {
    try {
      const { rows } = await query(
        'SELECT * FROM admin_audit_logs ORDER BY created_at DESC LIMIT $1',
        [Math.min(limit, 500)],
      );
      return rows;
    } catch (_) { /* fallback */ }
  }
  return readJson(AUDIT_FILE, []).slice(0, limit);
}

async function recordAuthEvent({ email, userId, eventType, success, ip, userAgent, country, details }) {
  const row = {
    id: `aev_${uuidv4()}`,
    email: (email || '').toLowerCase() || null,
    user_id: userId || null,
    event_type: eventType,
    success: !!success,
    ip: ip || null,
    user_agent: userAgent || null,
    country: country || null,
    details: details || {},
    created_at: new Date().toISOString(),
  };
  if (driver() === 'postgres') {
    try {
      await query(
        `INSERT INTO admin_auth_events (id, email, user_id, event_type, success, ip, user_agent, country, details, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [row.id, row.email, row.user_id, row.event_type, row.success, row.ip, row.user_agent,
          row.country, JSON.stringify(row.details), row.created_at],
      );
      return row;
    } catch (err) {
      console.warn('[AdminAudit] auth event pg failed:', err.message);
    }
  }
  const list = readJson(AUTH_FILE, []);
  list.unshift(row);
  writeJson(AUTH_FILE, list.slice(0, 5000));
  return row;
}

async function listAuthEvents(limit = 100) {
  if (driver() === 'postgres') {
    try {
      const { rows } = await query(
        'SELECT * FROM admin_auth_events ORDER BY created_at DESC LIMIT $1',
        [Math.min(limit, 500)],
      );
      return rows;
    } catch (_) { /* fallback */ }
  }
  return readJson(AUTH_FILE, []).slice(0, limit);
}

async function pushNotification({ severity = 'info', category, title, body, source }) {
  const row = {
    id: `ntf_${uuidv4()}`,
    severity,
    category,
    title,
    body: body || null,
    source: source || null,
    acknowledged: false,
    created_at: new Date().toISOString(),
  };
  if (driver() === 'postgres') {
    try {
      await query(
        `INSERT INTO admin_notifications (id, severity, category, title, body, source, acknowledged, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [row.id, row.severity, row.category, row.title, row.body, row.source, false, row.created_at],
      );
      return row;
    } catch (err) {
      console.warn('[AdminAudit] notification pg failed:', err.message);
    }
  }
  const list = readJson(NOTIF_FILE, []);
  list.unshift(row);
  writeJson(NOTIF_FILE, list.slice(0, 1000));
  return row;
}

async function listNotifications({ limit = 50, unackedOnly = false } = {}) {
  if (driver() === 'postgres') {
    try {
      const sql = unackedOnly
        ? 'SELECT * FROM admin_notifications WHERE acknowledged = FALSE ORDER BY created_at DESC LIMIT $1'
        : 'SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT $1';
      const { rows } = await query(sql, [Math.min(limit, 200)]);
      return rows;
    } catch (_) { /* fallback */ }
  }
  let list = readJson(NOTIF_FILE, []);
  if (unackedOnly) list = list.filter((n) => !n.acknowledged);
  return list.slice(0, limit);
}

async function acknowledgeNotification(id) {
  if (driver() === 'postgres') {
    try {
      await query('UPDATE admin_notifications SET acknowledged = TRUE WHERE id = $1', [id]);
      return true;
    } catch (_) { /* fallback */ }
  }
  const list = readJson(NOTIF_FILE, []);
  const n = list.find((x) => x.id === id);
  if (n) n.acknowledged = true;
  writeJson(NOTIF_FILE, list);
  return !!n;
}

async function recordPaymentEvent(evt) {
  const row = {
    id: evt.id || `pay_${uuidv4()}`,
    user_id: evt.userId || null,
    email: evt.email || null,
    provider: evt.provider || 'paypal',
    event_type: evt.eventType,
    plan_key: evt.planKey || null,
    amount: evt.amount != null ? Number(evt.amount) : null,
    currency: evt.currency || 'USD',
    status: evt.status || null,
    external_id: evt.externalId || null,
    raw: evt.raw || {},
    created_at: evt.createdAt || new Date().toISOString(),
  };
  if (driver() === 'postgres') {
    try {
      await query(
        `INSERT INTO admin_payment_events
         (id, user_id, email, provider, event_type, plan_key, amount, currency, status, external_id, raw, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [row.id, row.user_id, row.email, row.provider, row.event_type, row.plan_key,
          row.amount, row.currency, row.status, row.external_id, JSON.stringify(row.raw), row.created_at],
      );
      return row;
    } catch (err) {
      console.warn('[AdminAudit] payment pg failed:', err.message);
    }
  }
  const list = readJson(PAY_FILE, []);
  list.unshift(row);
  writeJson(PAY_FILE, list.slice(0, 5000));
  return row;
}

async function listPaymentEvents(limit = 100) {
  if (driver() === 'postgres') {
    try {
      const { rows } = await query(
        'SELECT * FROM admin_payment_events ORDER BY created_at DESC LIMIT $1',
        [Math.min(limit, 500)],
      );
      return rows;
    } catch (_) { /* fallback */ }
  }
  return readJson(PAY_FILE, []).slice(0, limit);
}

async function listExpiryItems() {
  if (driver() === 'postgres') {
    try {
      const { rows } = await query('SELECT * FROM admin_expiry_items ORDER BY expires_at ASC NULLS LAST');
      return rows;
    } catch (_) { /* fallback */ }
  }
  return readJson(EXPIRY_FILE, []);
}

async function upsertExpiryItem(item) {
  const row = {
    id: item.id || `exp_${uuidv4()}`,
    name: item.name,
    category: item.category || 'api',
    expires_at: item.expiresAt || item.expires_at || null,
    notes: item.notes || null,
    warn_days: item.warnDays != null ? item.warnDays : (item.warn_days != null ? item.warn_days : 14),
    updated_at: new Date().toISOString(),
    created_at: item.createdAt || new Date().toISOString(),
  };
  if (driver() === 'postgres') {
    try {
      await query(
        `INSERT INTO admin_expiry_items (id, name, category, expires_at, notes, warn_days, updated_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, category = EXCLUDED.category, expires_at = EXCLUDED.expires_at,
           notes = EXCLUDED.notes, warn_days = EXCLUDED.warn_days, updated_at = EXCLUDED.updated_at`,
        [row.id, row.name, row.category, row.expires_at, row.notes, row.warn_days, row.updated_at, row.created_at],
      );
      return row;
    } catch (err) {
      console.warn('[AdminAudit] expiry upsert pg failed:', err.message);
    }
  }
  const list = readJson(EXPIRY_FILE, []);
  const idx = list.findIndex((x) => x.id === row.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...row };
  else list.push(row);
  writeJson(EXPIRY_FILE, list);
  return row;
}

async function deleteExpiryItem(id) {
  if (driver() === 'postgres') {
    try {
      await query('DELETE FROM admin_expiry_items WHERE id = $1', [id]);
      return true;
    } catch (_) { /* fallback */ }
  }
  writeJson(EXPIRY_FILE, readJson(EXPIRY_FILE, []).filter((x) => x.id !== id));
  return true;
}

async function getSetting(key, fallback = null) {
  if (driver() === 'postgres') {
    try {
      const { rows } = await query('SELECT value FROM admin_settings WHERE key = $1', [key]);
      if (rows[0]) return rows[0].value;
    } catch (_) { /* fallback */ }
  }
  const all = readJson(SETTINGS_FILE, {});
  return all[key] != null ? all[key] : fallback;
}

async function setSetting(key, value) {
  if (driver() === 'postgres') {
    try {
      await query(
        `INSERT INTO admin_settings (key, value, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, JSON.stringify(value)],
      );
      return value;
    } catch (err) {
      console.warn('[AdminAudit] settings pg failed:', err.message);
    }
  }
  const all = readJson(SETTINGS_FILE, {});
  all[key] = value;
  writeJson(SETTINGS_FILE, all);
  return value;
}

async function recordErrorLog({ level = 'error', source, message, meta }) {
  const row = {
    id: `err_${uuidv4()}`,
    level,
    source: source || 'system',
    message: String(message || 'Unknown error'),
    meta: meta || {},
    created_at: new Date().toISOString(),
  };
  if (driver() === 'postgres') {
    try {
      await query(
        `INSERT INTO admin_error_logs (id, level, source, message, meta, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [row.id, row.level, row.source, row.message, JSON.stringify(row.meta), row.created_at],
      );
      return row;
    } catch (_) { /* fallback */ }
  }
  const list = readJson(ERROR_FILE, []);
  list.unshift(row);
  writeJson(ERROR_FILE, list.slice(0, 2000));
  return row;
}

async function listErrorLogs(limit = 100) {
  if (driver() === 'postgres') {
    try {
      const { rows } = await query(
        'SELECT * FROM admin_error_logs ORDER BY created_at DESC LIMIT $1',
        [Math.min(limit, 500)],
      );
      return rows;
    } catch (_) { /* fallback */ }
  }
  return readJson(ERROR_FILE, []).slice(0, limit);
}

module.exports = {
  recordAudit,
  listAudit,
  recordAuthEvent,
  listAuthEvents,
  pushNotification,
  listNotifications,
  acknowledgeNotification,
  recordPaymentEvent,
  listPaymentEvents,
  listExpiryItems,
  upsertExpiryItem,
  deleteExpiryItem,
  getSetting,
  setSetting,
  recordErrorLog,
  listErrorLogs,
};
