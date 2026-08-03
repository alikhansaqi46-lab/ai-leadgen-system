/**
 * Universal Contact Manager storage.
 *
 * Leads remain the CRM root for backward compatibility; this module normalizes
 * all contact methods, tags, notes, and custom fields around lead_id.
 */

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { query } = require('../config/db');
const leadStorage = require('./leadStorage');
const timelineStorage = require('./timelineStorage');

const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || 'default';
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILES = {
  contacts: path.join(DATA_DIR, 'contacts.json'),
  tags: path.join(DATA_DIR, 'contact_tags.json'),
  leadTags: path.join(DATA_DIR, 'lead_contact_tags.json'),
  notes: path.join(DATA_DIR, 'contact_notes.json'),
  fields: path.join(DATA_DIR, 'contact_custom_fields.json'),
};

const CHANNEL_ALIASES = {
  email: 'email',
  mail: 'email',
  phone: 'phone',
  call: 'phone',
  whatsapp: 'whatsapp',
  wa: 'whatsapp',
  sms: 'sms',
  text: 'sms',
};

function resolveDriver() {
  const d = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  if (d === 'postgres' || d === 'pg') return 'postgres';
  if (d === 'json' || d === 'file') return 'json';
  return process.env.DATABASE_URL ? 'postgres' : 'json';
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load(file) {
  ensureDir();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`[ContactStorage] Failed to load ${path.basename(file)}:`, err.message);
    return [];
  }
}

function save(file, rows) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
}

function normalizeChannel(channel) {
  const key = String(channel || '').trim().toLowerCase();
  return CHANNEL_ALIASES[key] || key || 'phone';
}

function normalizeValue(channel, value) {
  const ch = normalizeChannel(channel);
  const raw = String(value || '').trim();
  if (!raw || raw === 'N/A' || raw === 'Not Available') return '';
  if (ch === 'email') return raw.toLowerCase();
  if (['phone', 'sms', 'whatsapp'].includes(ch)) {
    const digits = raw.replace(/\D/g, '');
    if (!digits) return '';
    return digits.length === 10 ? `1${digits}` : digits;
  }
  return raw.toLowerCase();
}

function isValidContactValue(channel, value) {
  const normalized = normalizeValue(channel, value);
  if (!normalized) return false;
  if (normalizeChannel(channel) === 'email') return normalized.includes('@') && normalized.includes('.');
  return normalized.length >= 6;
}

function isDuplicateOwnerError(err) {
  return err && String(err.message || '').includes('already belongs to another contact');
}

function contactFromPg(r) {
  return {
    id: r.id,
    leadId: r.lead_id,
    workspaceId: r.workspace_id,
    channel: r.channel,
    value: r.value,
    normalizedValue: r.normalized_value,
    label: r.label,
    notes: r.notes,
    isPrimary: !!r.is_primary,
    isVerified: !!r.is_verified,
    metadata: r.metadata || {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function tagFromPg(r) {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    color: r.color,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function noteFromPg(r) {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    leadId: r.lead_id,
    contactId: r.contact_id,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function fieldFromPg(r) {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    leadId: r.lead_id,
    key: r.field_key,
    label: r.label,
    type: r.field_type,
    value: r.field_value,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function uniqueCandidateMethods(lead) {
  const candidates = [];
  if (lead.email && isValidContactValue('email', lead.email)) {
    candidates.push({ channel: 'email', value: lead.email, label: 'Primary email', isPrimary: true, metadata: { source: 'lead.email' } });
  }
  if (lead.phone && isValidContactValue('phone', lead.phone)) {
    candidates.push({ channel: 'phone', value: lead.phone, label: 'Primary phone', isPrimary: true, metadata: { source: 'lead.phone' } });
  }
  if (lead.whatsapp && isValidContactValue('whatsapp', lead.whatsapp)) {
    candidates.push({ channel: 'whatsapp', value: lead.whatsapp, label: 'WhatsApp', isPrimary: true, metadata: { source: 'lead.whatsapp' } });
  }
  const seen = new Set();
  return candidates.filter((c) => {
    const key = `${c.channel}:${normalizeValue(c.channel, c.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getLeadById(leadId, workspaceId) {
  if (resolveDriver() === 'postgres') {
    const result = await query('SELECT data FROM leads WHERE id = $1 AND workspace_id = $2 LIMIT 1', [leadId, workspaceId]);
    return result.rows[0]?.data || null;
  }
  const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
  return leads.find((l) => l.id === leadId) || null;
}

async function getContactsForLead(leadId, workspaceId) {
  if (resolveDriver() === 'postgres') {
    const result = await query(
      `SELECT * FROM contacts WHERE workspace_id = $1 AND lead_id = $2
       ORDER BY is_primary DESC, channel ASC, created_at ASC`,
      [workspaceId, leadId],
    );
    return result.rows.map(contactFromPg);
  }
  return load(FILES.contacts)
    .filter((c) => (c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && c.leadId === leadId)
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || String(a.channel).localeCompare(String(b.channel)));
}

async function clearPrimaryForChannel({ workspaceId, leadId, channel }) {
  if (resolveDriver() === 'postgres') {
    await query(
      'UPDATE contacts SET is_primary = false, updated_at = NOW() WHERE workspace_id = $1 AND lead_id = $2 AND channel = $3',
      [workspaceId, leadId, channel],
    );
    return;
  }
  const all = load(FILES.contacts);
  save(FILES.contacts, all.map((c) => (
    (c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && c.leadId === leadId && c.channel === channel
      ? { ...c, isPrimary: false, updatedAt: new Date().toISOString() }
      : c
  )));
}

const contactStorage = {
  normalizeChannel,
  normalizeValue,
  isValidContactValue,

  async ensureLeadContacts(lead, options = {}) {
    if (!lead?.id) return [];
    const workspaceId = options.workspaceId || lead.workspaceId || DEFAULT_WORKSPACE_ID;
    const existing = await getContactsForLead(lead.id, workspaceId);
    const existingKeys = new Set(existing.map((c) => `${c.channel}:${c.normalizedValue || normalizeValue(c.channel, c.value)}`));
    const created = [];
    for (const candidate of uniqueCandidateMethods(lead)) {
      const normalizedValue = normalizeValue(candidate.channel, candidate.value);
      const key = `${candidate.channel}:${normalizedValue}`;
      if (existingKeys.has(key)) continue;
      try {
        const row = await this.addContactMethod(lead.id, candidate, { workspaceId, skipTimeline: true });
        if (row) created.push(row);
      } catch (err) {
        if (!isDuplicateOwnerError(err)) throw err;
        console.warn(
          `[ContactStorage] Skipping duplicate legacy contact value during normalization: ${candidate.channel}:${normalizedValue}`,
        );
      }
    }
    return [...existing, ...created];
  },

  async addContactMethod(leadId, input, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const lead = await getLeadById(leadId, workspaceId);
    if (!lead) throw new Error('Lead not found');

    const channel = normalizeChannel(input.channel);
    const value = String(input.value || '').trim();
    const normalizedValue = normalizeValue(channel, value);
    if (!isValidContactValue(channel, value)) throw new Error(`Invalid ${channel} contact value`);

    const now = new Date().toISOString();
    const isPrimary = !!input.isPrimary;
    if (isPrimary) await clearPrimaryForChannel({ workspaceId, leadId, channel });

    const row = {
      id: input.id || uuidv4(),
      leadId,
      workspaceId,
      channel,
      value,
      normalizedValue,
      label: input.label || null,
      notes: input.notes || null,
      isPrimary,
      isVerified: !!input.isVerified,
      metadata: input.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    if (resolveDriver() === 'postgres') {
      try {
        const existingOwner = await query(
          'SELECT * FROM contacts WHERE workspace_id = $1 AND channel = $2 AND normalized_value = $3 LIMIT 1',
          [workspaceId, channel, normalizedValue],
        );
        if (existingOwner.rows[0] && existingOwner.rows[0].lead_id !== leadId) {
          throw new Error('Contact method already belongs to another contact in this workspace');
        }
        const result = await query(
          `INSERT INTO contacts
             (id, lead_id, workspace_id, channel, value, normalized_value, label, notes, is_primary, is_verified, metadata, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (workspace_id, channel, normalized_value) WHERE normalized_value IS NOT NULL
           DO UPDATE SET
             value = EXCLUDED.value,
             label = COALESCE(EXCLUDED.label, contacts.label),
             notes = COALESCE(EXCLUDED.notes, contacts.notes),
             is_primary = contacts.is_primary OR EXCLUDED.is_primary,
             is_verified = contacts.is_verified OR EXCLUDED.is_verified,
             metadata = COALESCE(contacts.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
             updated_at = NOW()
           RETURNING *`,
          [row.id, row.leadId, row.workspaceId, row.channel, row.value, row.normalizedValue, row.label, row.notes, row.isPrimary, row.isVerified, JSON.stringify(row.metadata), row.createdAt, row.updatedAt],
        );
        const saved = contactFromPg(result.rows[0]);
        if (!options.skipTimeline) {
          await timelineStorage.recordEvent({
            leadId,
            type: 'contact_method_added',
            channel,
            payload: { value, label: row.label },
          }, { workspaceId }).catch(() => {});
        }
        return saved;
      } catch (err) {
        throw err;
      }
    }

    const currentRows = load(FILES.contacts);
    const duplicate = currentRows.find((c) =>
      (c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId &&
      c.channel === channel &&
      (c.normalizedValue || normalizeValue(c.channel, c.value)) === normalizedValue
    );
    if (duplicate && duplicate.leadId !== leadId) {
      throw new Error('Contact method already belongs to another contact in this workspace');
    }
    const savedRow = duplicate ? { ...duplicate, ...row, id: duplicate.id, createdAt: duplicate.createdAt } : row;
    const all = currentRows.filter((c) => !(c.id === duplicate?.id));
    save(FILES.contacts, [savedRow, ...all]);
    return savedRow;
  },

  async updateContactMethod(contactId, updates, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (resolveDriver() === 'postgres') {
      const existing = await query('SELECT * FROM contacts WHERE id = $1 AND workspace_id = $2 LIMIT 1', [contactId, workspaceId]);
      if (!existing.rows[0]) return null;
      const current = contactFromPg(existing.rows[0]);
      const channel = updates.channel ? normalizeChannel(updates.channel) : current.channel;
      const value = updates.value !== undefined ? String(updates.value).trim() : current.value;
      const normalizedValue = normalizeValue(channel, value);
      if (!isValidContactValue(channel, value)) throw new Error(`Invalid ${channel} contact value`);
      const existingOwner = await query(
        'SELECT * FROM contacts WHERE workspace_id = $1 AND channel = $2 AND normalized_value = $3 AND id <> $4 LIMIT 1',
        [workspaceId, channel, normalizedValue, contactId],
      );
      if (existingOwner.rows[0]) {
        throw new Error('Contact method already belongs to another contact in this workspace');
      }
      if (updates.isPrimary === true) await clearPrimaryForChannel({ workspaceId, leadId: current.leadId, channel });
      const result = await query(
        `UPDATE contacts SET channel=$1, value=$2, normalized_value=$3, label=$4, notes=$5,
         is_primary=$6, is_verified=$7, metadata=$8, updated_at=NOW()
         WHERE id=$9 AND workspace_id=$10 RETURNING *`,
        [
          channel,
          value,
          normalizedValue,
          updates.label !== undefined ? updates.label : current.label,
          updates.notes !== undefined ? updates.notes : current.notes,
          updates.isPrimary !== undefined ? !!updates.isPrimary : current.isPrimary,
          updates.isVerified !== undefined ? !!updates.isVerified : current.isVerified,
          JSON.stringify(updates.metadata !== undefined ? updates.metadata : current.metadata || {}),
          contactId,
          workspaceId,
        ],
      );
      return contactFromPg(result.rows[0]);
    }
    const all = load(FILES.contacts);
    let updated = null;
    const rows = all.map((c) => {
      if (c.id !== contactId || (c.workspaceId || DEFAULT_WORKSPACE_ID) !== workspaceId) return c;
      const channel = updates.channel ? normalizeChannel(updates.channel) : c.channel;
      const value = updates.value !== undefined ? String(updates.value).trim() : c.value;
      const normalizedValue = normalizeValue(channel, value);
      const duplicate = all.find((other) =>
        other.id !== contactId &&
        (other.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId &&
        other.channel === channel &&
        (other.normalizedValue || normalizeValue(other.channel, other.value)) === normalizedValue
      );
      if (duplicate) throw new Error('Contact method already belongs to another contact in this workspace');
      updated = {
        ...c,
        ...updates,
        channel,
        value,
        normalizedValue,
        updatedAt: new Date().toISOString(),
      };
      return updated;
    });
    save(FILES.contacts, rows);
    return updated;
  },

  async deleteContactMethod(contactId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (resolveDriver() === 'postgres') {
      const result = await query('DELETE FROM contacts WHERE id = $1 AND workspace_id = $2 RETURNING *', [contactId, workspaceId]);
      return result.rowCount > 0;
    }
    const all = load(FILES.contacts);
    const next = all.filter((c) => !(c.id === contactId && (c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId));
    save(FILES.contacts, next);
    return next.length !== all.length;
  },

  async findLeadByContact({ workspaceId = DEFAULT_WORKSPACE_ID, channel, value }) {
    const normalized = normalizeValue(channel, value);
    if (!normalized) return null;
    const requested = normalizeChannel(channel);
    const channels = requested === 'sms' || requested === 'whatsapp' ? [requested, 'phone'] : [requested];
    if (resolveDriver() === 'postgres') {
      const result = await query(
        `SELECT l.data
         FROM contacts c
         JOIN leads l ON l.id = c.lead_id AND l.workspace_id = c.workspace_id
         WHERE c.workspace_id = $1 AND c.channel = ANY($2) AND c.normalized_value = $3
         ORDER BY c.is_primary DESC, c.updated_at DESC
         LIMIT 1`,
        [workspaceId, channels, normalized],
      );
      if (result.rows[0]?.data) return result.rows[0].data;
    } else {
      const contacts = load(FILES.contacts);
      const hit = contacts.find((c) =>
        (c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId &&
        channels.includes(c.channel) &&
        (c.normalizedValue || normalizeValue(c.channel, c.value)) === normalized
      );
      if (hit) return getLeadById(hit.leadId, workspaceId);
    }
    if (channels.includes('phone')) {
      return leadStorage.findByPhone(value, { workspaceId });
    }
    if (requested === 'email') {
      const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
      return leads.find((l) => l.email && normalizeValue('email', l.email) === normalized) || null;
    }
    return null;
  },

  async listProfiles(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const limit = Math.min(parseInt(options.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(options.offset, 10) || 0, 0);
    const search = String(options.search || '').trim();

    let leads;
    let total;
    if (resolveDriver() === 'postgres') {
      const params = [workspaceId];
      let where = 'l.workspace_id = $1';
      if (search) {
        params.push(`%${search}%`);
        where += ` AND (
          l.name ILIKE $${params.length}
          OR l.phone ILIKE $${params.length}
          OR l.niche ILIKE $${params.length}
          OR l.country ILIKE $${params.length}
          OR l.data->>'email' ILIKE $${params.length}
          OR EXISTS (
            SELECT 1 FROM contacts c
            WHERE c.workspace_id = l.workspace_id AND c.lead_id = l.id
              AND (c.value ILIKE $${params.length} OR c.label ILIKE $${params.length})
          )
          OR EXISTS (
            SELECT 1
            FROM lead_contact_tags lct
            JOIN contact_tags t ON t.id = lct.tag_id AND t.workspace_id = lct.workspace_id
            WHERE lct.workspace_id = l.workspace_id AND lct.lead_id = l.id
              AND t.name ILIKE $${params.length}
          )
        )`;
      }
      params.push(limit, offset);
      const result = await query(
        `SELECT l.data, COUNT(*) OVER() AS total
         FROM leads l
         WHERE ${where}
         ORDER BY l.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      leads = result.rows.map((r) => r.data);
      total = parseInt(result.rows[0]?.total || '0', 10);
    } else {
      const all = await leadStorage.getLeads({ workspaceId, limit: 10000 });
      const q = search.toLowerCase();
      let filtered = all;
      if (q) {
        const tagMap = await this.getTagsByLeadIds(all.map((l) => l.id), { workspaceId });
        const methodMap = await this.getContactMethodsByLeadIds(all.map((l) => l.id), { workspaceId });
        filtered = all.filter((l) => (
          [l.name, l.phone, l.email, l.city, l.niche, l.country].some((v) => String(v || '').toLowerCase().includes(q)) ||
          (tagMap.get(l.id) || []).some((t) => String(t.name || '').toLowerCase().includes(q)) ||
          (methodMap.get(l.id) || []).some((m) => [m.value, m.label].some((v) => String(v || '').toLowerCase().includes(q)))
        ));
      }
      total = filtered.length;
      leads = filtered.slice(offset, offset + limit);
    }

    for (const lead of leads) await this.ensureLeadContacts(lead, { workspaceId });
    const leadIds = leads.map((l) => l.id);
    const [methodsByLead, tagsByLead] = await Promise.all([
      this.getContactMethodsByLeadIds(leadIds, { workspaceId }),
      this.getTagsByLeadIds(leadIds, { workspaceId }),
    ]);
    return {
      contacts: leads.map((lead) => ({
        lead,
        leadId: lead.id,
        contactMethods: methodsByLead.get(lead.id) || [],
        primaryContact: (methodsByLead.get(lead.id) || []).find((c) => c.isPrimary) || (methodsByLead.get(lead.id) || [])[0] || null,
        tags: tagsByLead.get(lead.id) || [],
      })),
      count: leads.length,
      total,
      limit,
      offset,
    };
  },

  async getContactMethodsByLeadIds(leadIds, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const map = new Map(leadIds.map((id) => [id, []]));
    if (leadIds.length === 0) return map;
    if (resolveDriver() === 'postgres') {
      const result = await query(
        `SELECT * FROM contacts WHERE workspace_id = $1 AND lead_id = ANY($2)
         ORDER BY is_primary DESC, channel ASC, created_at ASC`,
        [workspaceId, leadIds],
      );
      for (const row of result.rows.map(contactFromPg)) {
        if (!map.has(row.leadId)) map.set(row.leadId, []);
        map.get(row.leadId).push(row);
      }
      return map;
    }
    for (const c of load(FILES.contacts)) {
      if ((c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && map.has(c.leadId)) map.get(c.leadId).push(c);
    }
    return map;
  },

  async getProfile(leadId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const lead = await getLeadById(leadId, workspaceId);
    if (!lead) return null;
    const [contactMethods, tags, notes, customFields, history] = await Promise.all([
      this.ensureLeadContacts(lead, { workspaceId }),
      this.getTags(leadId, { workspaceId }),
      this.getNotes(leadId, { workspaceId }),
      this.getCustomFields(leadId, { workspaceId }),
      timelineStorage.getEvents(leadId, { workspaceId }).catch(() => []),
    ]);
    return {
      lead,
      leadId,
      contactMethods,
      primaryContact: contactMethods.find((c) => c.isPrimary) || contactMethods[0] || null,
      tags,
      notes,
      customFields,
      history,
    };
  },

  async getTagsByLeadIds(leadIds, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const map = new Map(leadIds.map((id) => [id, []]));
    if (leadIds.length === 0) return map;
    if (resolveDriver() === 'postgres') {
      const result = await query(
        `SELECT lct.lead_id, t.*
         FROM lead_contact_tags lct
         JOIN contact_tags t ON t.id = lct.tag_id AND t.workspace_id = lct.workspace_id
         WHERE lct.workspace_id = $1 AND lct.lead_id = ANY($2)
         ORDER BY t.name ASC`,
        [workspaceId, leadIds],
      );
      for (const r of result.rows) {
        if (!map.has(r.lead_id)) map.set(r.lead_id, []);
        map.get(r.lead_id).push(tagFromPg(r));
      }
      return map;
    }
    const tags = load(FILES.tags);
    const tagById = new Map(tags.map((t) => [t.id, t]));
    for (const link of load(FILES.leadTags)) {
      if ((link.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && map.has(link.leadId)) {
        const tag = tagById.get(link.tagId);
        if (tag) map.get(link.leadId).push(tag);
      }
    }
    return map;
  },

  async getTags(leadId, options = {}) {
    const map = await this.getTagsByLeadIds([leadId], options);
    return map.get(leadId) || [];
  },

  async listTags(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (resolveDriver() === 'postgres') {
      const result = await query(
        'SELECT * FROM contact_tags WHERE workspace_id = $1 ORDER BY lower(name) ASC',
        [workspaceId],
      );
      return result.rows.map(tagFromPg);
    }
    return load(FILES.tags)
      .filter((t) => (t.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId)
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  async upsertTag({ name, color }, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Tag name is required');
    const now = new Date().toISOString();
    if (resolveDriver() === 'postgres') {
      const existing = await query(
        'SELECT * FROM contact_tags WHERE workspace_id = $1 AND lower(name) = lower($2) LIMIT 1',
        [workspaceId, cleanName],
      );
      if (existing.rows[0]) {
        const result = await query(
          'UPDATE contact_tags SET color = COALESCE($1, color), updated_at = NOW() WHERE id = $2 AND workspace_id = $3 RETURNING *',
          [color || null, existing.rows[0].id, workspaceId],
        );
        return tagFromPg(result.rows[0]);
      }
      const result = await query(
        `INSERT INTO contact_tags (id, workspace_id, name, color, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5)
         RETURNING *`,
        [uuidv4(), workspaceId, cleanName, color || null, now],
      );
      return tagFromPg(result.rows[0]);
    }
    const all = load(FILES.tags);
    const existing = all.find((t) => (t.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && t.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) {
      existing.color = color || existing.color || null;
      existing.updatedAt = now;
      save(FILES.tags, all);
      return existing;
    }
    const tag = { id: uuidv4(), workspaceId, name: cleanName, color: color || null, createdAt: now, updatedAt: now };
    save(FILES.tags, [tag, ...all]);
    return tag;
  },

  async assignTag(leadId, tagInput, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const tag = tagInput.id ? tagInput : await this.upsertTag(tagInput, { workspaceId });
    if (resolveDriver() === 'postgres') {
      await query(
        `INSERT INTO lead_contact_tags (workspace_id, lead_id, tag_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [workspaceId, leadId, tag.id],
      );
      return tag;
    }
    const all = load(FILES.leadTags);
    if (!all.some((l) => (l.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && l.leadId === leadId && l.tagId === tag.id)) {
      save(FILES.leadTags, [{ workspaceId, leadId, tagId: tag.id, createdAt: new Date().toISOString() }, ...all]);
    }
    return tag;
  },

  async removeTag(leadId, tagId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (resolveDriver() === 'postgres') {
      const result = await query('DELETE FROM lead_contact_tags WHERE workspace_id = $1 AND lead_id = $2 AND tag_id = $3', [workspaceId, leadId, tagId]);
      return result.rowCount > 0;
    }
    const all = load(FILES.leadTags);
    const next = all.filter((l) => !((l.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && l.leadId === leadId && l.tagId === tagId));
    save(FILES.leadTags, next);
    return next.length !== all.length;
  },

  async addNote(leadId, { body, contactId = null }, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const text = String(body || '').trim();
    if (!text) throw new Error('Note body is required');
    const now = new Date().toISOString();
    const row = { id: uuidv4(), workspaceId, leadId, contactId, body: text, createdAt: now, updatedAt: now };
    if (resolveDriver() === 'postgres') {
      const result = await query(
        `INSERT INTO contact_notes (id, workspace_id, lead_id, contact_id, body, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [row.id, workspaceId, leadId, contactId, text, now, now],
      );
      await timelineStorage.recordEvent({ leadId, type: 'note', payload: { body: text, contactId } }, { workspaceId }).catch(() => {});
      return noteFromPg(result.rows[0]);
    }
    save(FILES.notes, [row, ...load(FILES.notes)]);
    return row;
  },

  async getNotes(leadId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (resolveDriver() === 'postgres') {
      const result = await query(
        'SELECT * FROM contact_notes WHERE workspace_id = $1 AND lead_id = $2 ORDER BY created_at DESC',
        [workspaceId, leadId],
      );
      return result.rows.map(noteFromPg);
    }
    return load(FILES.notes)
      .filter((n) => (n.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && n.leadId === leadId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  },

  async deleteNote(noteId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (resolveDriver() === 'postgres') {
      const result = await query('DELETE FROM contact_notes WHERE id = $1 AND workspace_id = $2', [noteId, workspaceId]);
      return result.rowCount > 0;
    }
    const all = load(FILES.notes);
    const next = all.filter((n) => !(n.id === noteId && (n.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId));
    save(FILES.notes, next);
    return next.length !== all.length;
  },

  async getCustomFields(leadId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (resolveDriver() === 'postgres') {
      const result = await query(
        'SELECT * FROM contact_custom_fields WHERE workspace_id = $1 AND lead_id = $2 ORDER BY field_key ASC',
        [workspaceId, leadId],
      );
      return result.rows.map(fieldFromPg);
    }
    return load(FILES.fields).filter((f) => (f.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && f.leadId === leadId);
  },

  async upsertCustomField(leadId, input, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const key = String(input.key || input.fieldKey || '').trim();
    if (!key) throw new Error('Custom field key is required');
    const value = input.value === undefined ? null : input.value;
    const type = input.type || 'text';
    const label = input.label || key;
    const now = new Date().toISOString();
    if (resolveDriver() === 'postgres') {
      const result = await query(
        `INSERT INTO contact_custom_fields (id, workspace_id, lead_id, field_key, label, field_type, field_value, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
         ON CONFLICT (workspace_id, lead_id, field_key)
         DO UPDATE SET label = EXCLUDED.label, field_type = EXCLUDED.field_type, field_value = EXCLUDED.field_value, updated_at = NOW()
         RETURNING *`,
        [uuidv4(), workspaceId, leadId, key, label, type, JSON.stringify(value), now],
      );
      return fieldFromPg(result.rows[0]);
    }
    const all = load(FILES.fields);
    const idx = all.findIndex((f) => (f.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && f.leadId === leadId && f.key === key);
    const row = { id: idx >= 0 ? all[idx].id : uuidv4(), workspaceId, leadId, key, label, type, value, createdAt: idx >= 0 ? all[idx].createdAt : now, updatedAt: now };
    if (idx >= 0) all[idx] = row;
    else all.unshift(row);
    save(FILES.fields, all);
    return row;
  },

  async deleteCustomField(leadId, key, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (resolveDriver() === 'postgres') {
      const result = await query('DELETE FROM contact_custom_fields WHERE workspace_id = $1 AND lead_id = $2 AND field_key = $3', [workspaceId, leadId, key]);
      return result.rowCount > 0;
    }
    const all = load(FILES.fields);
    const next = all.filter((f) => !((f.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && f.leadId === leadId && f.key === key));
    save(FILES.fields, next);
    return next.length !== all.length;
  },
};

module.exports = contactStorage;
