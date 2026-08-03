const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { query } = require('../config/db');
const { parseEmailAddress, isValidEmail } = require('./emailValidation');

const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || 'default';
const DATA_FILE = path.join(__dirname, '..', 'data', 'personal_contacts.json');

function resolveDriver() {
  const d = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  if (d === 'postgres' || d === 'pg') return 'postgres';
  if (d === 'json' || d === 'file') return 'json';
  return process.env.DATABASE_URL ? 'postgres' : 'json';
}

function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[PersonalContactStorage] Failed to load contacts:', err.message);
    return [];
  }
}

function save(rows) {
  ensureDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2));
}

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'N/A' || raw === 'Not Available') return '';
  return raw.replace(/\D/g, '');
}

function normalizeEmail(value) {
  const parsed = parseEmailAddress(value);
  return isValidEmail(parsed) ? parsed : '';
}

function resolveDeliveryEmail(contact = {}) {
  return normalizeEmail(contact.emailNormalized || contact.email_normalized || contact.email);
}

function hasContactPoint(input) {
  return Boolean(normalizePhone(input.whatsappNumber) || normalizePhone(input.smsNumber) || normalizeEmail(input.email));
}

function contactFromPg(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name || '',
    company: row.company || '',
    whatsappNumber: row.whatsapp_number || '',
    whatsappNormalized: row.whatsapp_normalized || '',
    smsNumber: row.sms_number || '',
    smsNormalized: row.sms_normalized || '',
    email: row.email || '',
    emailNormalized: row.email_normalized || '',
    notes: row.notes || '',
    source: row.source || 'manual',
    duplicateOf: row.duplicate_of || null,
    isDuplicate: Boolean(row.duplicate_of),
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeInput(input = {}) {
  const whatsappNumber = String(input.whatsappNumber || input.whatsapp || input.phone || '').trim();
  const smsNumber = String(input.smsNumber || input.sms || input.phone || '').trim();
  const emailRaw = String(input.email || '').trim();
  const email = parseEmailAddress(emailRaw) || emailRaw;
  return {
    id: input.id || uuidv4(),
    workspaceId: input.workspaceId || DEFAULT_WORKSPACE_ID,
    name: String(input.name || '').trim(),
    company: String(input.company || '').trim(),
    whatsappNumber,
    whatsappNormalized: normalizePhone(whatsappNumber),
    smsNumber,
    smsNormalized: normalizePhone(smsNumber),
    email,
    emailNormalized: normalizeEmail(email),
    notes: String(input.notes || '').trim(),
    source: input.source || 'manual',
    duplicateOf: input.duplicateOf || null,
    metadata: input.metadata || {},
  };
}

function duplicateOf(candidate, existingRows) {
  const ownId = candidate.id;
  const match = existingRows.find((row) => {
    if (row.id === ownId) return false;
    const rowEmail = row.emailNormalized || row.email_normalized || normalizeEmail(row.email);
    const rowWa = row.whatsappNormalized || row.whatsapp_normalized || normalizePhone(row.whatsappNumber || row.whatsapp_number);
    const rowSms = row.smsNormalized || row.sms_normalized || normalizePhone(row.smsNumber || row.sms_number);
    return (
      (candidate.emailNormalized && rowEmail === candidate.emailNormalized) ||
      (candidate.whatsappNormalized && rowWa === candidate.whatsappNormalized) ||
      (candidate.smsNormalized && rowSms === candidate.smsNormalized)
    );
  });
  return match?.id || null;
}

async function findDuplicate(candidate, workspaceId) {
  if (resolveDriver() === 'postgres') {
    const clauses = [];
    const params = [workspaceId, candidate.id];
    if (candidate.emailNormalized) {
      params.push(candidate.emailNormalized);
      clauses.push(`email_normalized = $${params.length}`);
    }
    if (candidate.whatsappNormalized) {
      params.push(candidate.whatsappNormalized);
      clauses.push(`whatsapp_normalized = $${params.length}`);
    }
    if (candidate.smsNormalized) {
      params.push(candidate.smsNormalized);
      clauses.push(`sms_normalized = $${params.length}`);
    }
    if (!clauses.length) return null;
    const result = await query(
      `SELECT id FROM personal_contacts
       WHERE workspace_id = $1 AND id <> $2 AND (${clauses.join(' OR ')})
       ORDER BY created_at ASC LIMIT 1`,
      params,
    );
    return result.rows[0]?.id || null;
  }
  const rows = load().filter((c) => (c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId);
  return duplicateOf(candidate, rows);
}

function parseLines(text = '', mode = 'mixed') {
  const rows = [];
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split(',').map((p) => p.trim());
    const first = parts[0] || '';
    const second = parts[1] || '';
    const looksEmail = first.includes('@') || second.includes('@');
    const looksPhone = /\d{6,}/.test(first.replace(/\D/g, '')) || /\d{6,}/.test(second.replace(/\D/g, ''));

    if (mode === 'email' || (looksEmail && !looksPhone)) {
      rows.push(parts.length > 1 ? { name: first.includes('@') ? '' : first, email: first.includes('@') ? first : second } : { email: first });
      continue;
    }

    if (parts.length > 1) {
      rows.push({ name: first, whatsappNumber: second, smsNumber: second });
    } else {
      rows.push({ whatsappNumber: first, smsNumber: first });
    }
  }
  return rows;
}

async function refreshDuplicateFlags(workspaceId) {
  if (resolveDriver() === 'postgres') {
    await query(
      `WITH ranked AS (
        SELECT id,
          FIRST_VALUE(id) OVER (PARTITION BY workspace_id, email_normalized ORDER BY created_at ASC, id ASC) AS email_owner,
          FIRST_VALUE(id) OVER (PARTITION BY workspace_id, whatsapp_normalized ORDER BY created_at ASC, id ASC) AS wa_owner,
          FIRST_VALUE(id) OVER (PARTITION BY workspace_id, sms_normalized ORDER BY created_at ASC, id ASC) AS sms_owner
        FROM personal_contacts
        WHERE workspace_id = $1
      )
      UPDATE personal_contacts pc
      SET duplicate_of = CASE
        WHEN pc.email_normalized IS NOT NULL AND pc.email_normalized <> '' AND ranked.email_owner <> pc.id THEN ranked.email_owner
        WHEN pc.whatsapp_normalized IS NOT NULL AND pc.whatsapp_normalized <> '' AND ranked.wa_owner <> pc.id THEN ranked.wa_owner
        WHEN pc.sms_normalized IS NOT NULL AND pc.sms_normalized <> '' AND ranked.sms_owner <> pc.id THEN ranked.sms_owner
        ELSE NULL
      END,
      updated_at = NOW()
      FROM ranked
      WHERE pc.id = ranked.id AND pc.workspace_id = $1`,
      [workspaceId],
    );
    return;
  }
  const all = load();
  const workspaceRows = all.filter((c) => (c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId);
  const next = all.map((row) => {
    if ((row.workspaceId || DEFAULT_WORKSPACE_ID) !== workspaceId) return row;
    return { ...row, duplicateOf: duplicateOf(row, workspaceRows), updatedAt: new Date().toISOString() };
  });
  save(next);
}

const personalContactStorage = {
  normalizePhone,
  normalizeEmail,
  resolveDeliveryEmail,
  parseLines,

  async list({ workspaceId = DEFAULT_WORKSPACE_ID, search = '', limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
    const q = String(search || '').trim().toLowerCase();

    if (resolveDriver() === 'postgres') {
      const params = [workspaceId];
      let where = 'workspace_id = $1';
      if (q) {
        params.push(`%${q}%`);
        where += ` AND (
          lower(COALESCE(name, '')) LIKE $${params.length}
          OR lower(COALESCE(company, '')) LIKE $${params.length}
          OR lower(COALESCE(email, '')) LIKE $${params.length}
          OR COALESCE(whatsapp_number, '') LIKE $${params.length}
          OR COALESCE(sms_number, '') LIKE $${params.length}
        )`;
      }
      const countResult = await query(`SELECT COUNT(*)::int AS total FROM personal_contacts WHERE ${where}`, params);
      params.push(safeLimit, safeOffset);
      const result = await query(
        `SELECT * FROM personal_contacts
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { contacts: result.rows.map(contactFromPg), total: countResult.rows[0]?.total || 0, limit: safeLimit, offset: safeOffset };
    }

    let rows = load().filter((c) => (c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId);
    if (q) {
      rows = rows.filter((c) => [c.name, c.company, c.email, c.whatsappNumber, c.smsNumber].some((v) => String(v || '').toLowerCase().includes(q)));
    }
    rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return { contacts: rows.slice(safeOffset, safeOffset + safeLimit), total: rows.length, limit: safeLimit, offset: safeOffset };
  },

  async get(id, { workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    if (resolveDriver() === 'postgres') {
      const result = await query('SELECT * FROM personal_contacts WHERE workspace_id = $1 AND id = $2 LIMIT 1', [workspaceId, id]);
      return result.rows[0] ? contactFromPg(result.rows[0]) : null;
    }
    return load().find((c) => (c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && c.id === id) || null;
  },

  async findByContact({ workspaceId = DEFAULT_WORKSPACE_ID, channel = 'email', value }) {
    const normalizedEmail = normalizeEmail(value);
    const normalizedPhone = normalizePhone(value);
    if (!normalizedEmail && !normalizedPhone) return null;

    if (resolveDriver() === 'postgres') {
      let sql;
      let params;
      if (channel === 'email') {
        sql = 'SELECT * FROM personal_contacts WHERE workspace_id = $1 AND email_normalized = $2 ORDER BY created_at ASC LIMIT 1';
        params = [workspaceId, normalizedEmail];
      } else if (channel === 'sms') {
        sql = 'SELECT * FROM personal_contacts WHERE workspace_id = $1 AND sms_normalized = $2 ORDER BY created_at ASC LIMIT 1';
        params = [workspaceId, normalizedPhone];
      } else {
        sql = 'SELECT * FROM personal_contacts WHERE workspace_id = $1 AND whatsapp_normalized = $2 ORDER BY created_at ASC LIMIT 1';
        params = [workspaceId, normalizedPhone];
      }
      const result = await query(sql, params);
      return result.rows[0] ? contactFromPg(result.rows[0]) : null;
    }

    const rows = load().filter((c) => (c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId);
    return rows.find((c) => {
      if (channel === 'email') return (c.emailNormalized || normalizeEmail(c.email)) === normalizedEmail;
      if (channel === 'sms') return (c.smsNormalized || normalizePhone(c.smsNumber)) === normalizedPhone;
      return (c.whatsappNormalized || normalizePhone(c.whatsappNumber)) === normalizedPhone;
    }) || null;
  },

  async create(input, { workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    const row = sanitizeInput({ ...input, workspaceId });
    if (row.email && !row.emailNormalized) {
      throw new Error(`Invalid email address: ${row.email}`);
    }
    if (!hasContactPoint(row)) throw new Error('At least one WhatsApp number, SMS number, or email address is required');
    row.duplicateOf = await findDuplicate(row, workspaceId);
    const now = new Date().toISOString();

    if (resolveDriver() === 'postgres') {
      const result = await query(
        `INSERT INTO personal_contacts
         (id, workspace_id, name, company, whatsapp_number, whatsapp_normalized, sms_number, sms_normalized,
          email, email_normalized, notes, source, duplicate_of, metadata, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
         RETURNING *`,
        [
          row.id,
          workspaceId,
          row.name || null,
          row.company || null,
          row.whatsappNumber || null,
          row.whatsappNormalized || null,
          row.smsNumber || null,
          row.smsNormalized || null,
          row.email || null,
          row.emailNormalized || null,
          row.notes || null,
          row.source,
          row.duplicateOf,
          JSON.stringify(row.metadata || {}),
        ],
      );
      return contactFromPg(result.rows[0]);
    }

    const rows = load();
    const saved = { ...row, isDuplicate: Boolean(row.duplicateOf), createdAt: now, updatedAt: now };
    rows.push(saved);
    save(rows);
    return saved;
  },

  async update(id, input, { workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    const existing = await this.get(id, { workspaceId });
    if (!existing) return null;
    const row = sanitizeInput({ ...existing, ...input, id, workspaceId });
    if (row.email && !row.emailNormalized) {
      throw new Error(`Invalid email address: ${row.email}`);
    }
    if (!hasContactPoint(row)) throw new Error('At least one WhatsApp number, SMS number, or email address is required');
    row.duplicateOf = await findDuplicate(row, workspaceId);

    if (resolveDriver() === 'postgres') {
      const result = await query(
        `UPDATE personal_contacts
         SET name=$3, company=$4, whatsapp_number=$5, whatsapp_normalized=$6, sms_number=$7, sms_normalized=$8,
             email=$9, email_normalized=$10, notes=$11, duplicate_of=$12, metadata=$13, updated_at=NOW()
         WHERE workspace_id=$1 AND id=$2
         RETURNING *`,
        [
          workspaceId,
          id,
          row.name || null,
          row.company || null,
          row.whatsappNumber || null,
          row.whatsappNormalized || null,
          row.smsNumber || null,
          row.smsNormalized || null,
          row.email || null,
          row.emailNormalized || null,
          row.notes || null,
          row.duplicateOf,
          JSON.stringify(row.metadata || {}),
        ],
      );
      await refreshDuplicateFlags(workspaceId);
      return result.rows[0] ? contactFromPg(result.rows[0]) : null;
    }

    const rows = load();
    const next = rows.map((c) => ((c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && c.id === id
      ? { ...row, isDuplicate: Boolean(row.duplicateOf), createdAt: c.createdAt, updatedAt: new Date().toISOString() }
      : c));
    save(next);
    await refreshDuplicateFlags(workspaceId);
    return next.find((c) => (c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && c.id === id) || null;
  },

  async bulkCreate(inputs, { workspaceId = DEFAULT_WORKSPACE_ID, source = 'bulk' } = {}) {
    const summary = { created: 0, duplicates: 0, skipped: 0, contacts: [] };
    for (const input of inputs) {
      try {
        const contact = await this.create({ ...input, source }, { workspaceId });
        summary.created += 1;
        if (contact.isDuplicate || contact.duplicateOf) summary.duplicates += 1;
        summary.contacts.push(contact);
      } catch (err) {
        summary.skipped += 1;
      }
    }
    await refreshDuplicateFlags(workspaceId);
    return summary;
  },

  async bulkDelete(ids = [], { workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    const uniqueIds = [...new Set((ids || []).map(String).filter(Boolean))];
    if (!uniqueIds.length) return 0;
    if (resolveDriver() === 'postgres') {
      const params = [workspaceId, uniqueIds];
      const result = await query('DELETE FROM personal_contacts WHERE workspace_id = $1 AND id = ANY($2::text[])', params);
      await refreshDuplicateFlags(workspaceId);
      return result.rowCount || 0;
    }
    const rows = load();
    const before = rows.length;
    save(rows.filter((c) => !((c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && uniqueIds.includes(c.id))));
    await refreshDuplicateFlags(workspaceId);
    return before - load().length;
  },
};

module.exports = personalContactStorage;
