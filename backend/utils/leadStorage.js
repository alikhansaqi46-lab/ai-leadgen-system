/**
 * Lead Storage Module
 * Pluggable persistence selected by STORAGE_DRIVER:
 *   - 'postgres'  → PostgreSQL / Supabase (via config/db.js)
 *   - 'json'      → file-based JSON (backend/data/leads.json)
 *   - 'auto' (default) → PostgreSQL if DATABASE_URL is set, else JSON file
 * Provides unified CRUD regardless of which backend is active.
 */

const { query } = require('../config/db');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = path.join(__dirname, '..', 'data', 'leads.json');
const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || 'default';

async function syncUniversalContacts(leads, workspaceId) {
  try {
    const contactStorage = require('./contactStorage');
    for (const lead of leads.filter(Boolean)) {
      await contactStorage.ensureLeadContacts(lead, { workspaceId });
    }
  } catch (err) {
    console.error('[LeadStorage] Contact sync failed (non-fatal):', err.message);
  }
}

/* ==================== DRIVER SELECTION ==================== */

function resolveDriver() {
  const d = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  if (d === 'postgres' || d === 'pg') return 'postgres';
  if (d === 'json' || d === 'file') return 'json';
  return process.env.DATABASE_URL ? 'postgres' : 'json';
}

/* ==================== FILE HELPERS ==================== */

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadLeadsFromFile() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[LeadStorage] Failed to load leads file:', err.message);
    return [];
  }
}

function saveLeadsToFile(leads) {
  ensureDataDir();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(leads, null, 2));
  } catch (err) {
    console.error('[LeadStorage] Failed to save leads file:', err.message);
  }
}

/* ==================== DEDUPLICATION ==================== */

function deduplicateLeads(existingLeads, newLeads) {
  const seenPhones = new Set();
  const seenNames = new Set();

  // Mark existing
  for (const lead of existingLeads) {
    const phone = (lead.phone || '').replace(/\D/g, '').trim();
    if (phone && phone !== 'N/A') seenPhones.add(phone);
    const name = (lead.name || '').toLowerCase().trim();
    if (name && name !== 'unknown') seenNames.add(name);
  }

  const unique = [];
  for (const lead of newLeads) {
    const phone = (lead.phone || '').replace(/\D/g, '').trim();
    const name = (lead.name || '').toLowerCase().trim();

    if (phone && phone !== 'N/A' && seenPhones.has(phone)) continue;
    if (name && name !== 'unknown' && seenNames.has(name)) continue;

    if (phone && phone !== 'N/A') seenPhones.add(phone);
    if (name && name !== 'unknown') seenNames.add(name);

    unique.push(lead);
  }
  return unique;
}

/* ==================== POSTGRES HELPERS ==================== */

async function getLeadsFromPostgres({ workspaceId, country, niche, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (workspaceId) { params.push(workspaceId); clauses.push(`workspace_id = $${params.length}`); }
  if (country) { params.push(country); clauses.push(`country = $${params.length}`); }
  if (niche) { params.push(niche); clauses.push(`niche = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(parseInt(limit) || 100);
  const sql = `SELECT data FROM leads ${where} ORDER BY created_at DESC LIMIT $${params.length}`;
  const result = await query(sql, params);
  // `data` is the full lead object stored verbatim → identical shape to other drivers.
  return result.rows.map(row => row.data);
}

async function saveLeadsToPostgres(leads) {
  const saved = [];
  for (const lead of leads) {
    const result = await query(
      `INSERT INTO leads (id, name, phone, country, niche, workspace_id, created_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING
       RETURNING data`,
      [
        lead.id,
        lead.name || null,
        lead.phone || null,
        lead.country || null,
        lead.niche || null,
        lead.workspaceId || DEFAULT_WORKSPACE_ID,
        lead.createdAt || new Date().toISOString(),
        JSON.stringify(lead)
      ]
    );
    if (result.rows.length > 0) saved.push(result.rows[0].data);
  }
  return saved;
}

async function deleteLeadsFromPostgres(ids, workspaceId) {
  // Scope delete to the caller's workspace so A cannot delete B's lead.
  if (workspaceId) {
    await query(`DELETE FROM leads WHERE id = ANY($1) AND workspace_id = $2`, [ids, workspaceId]);
  } else {
    await query(`DELETE FROM leads WHERE id = ANY($1)`, [ids]);
  }
}

/* ==================== UNIFIED API ==================== */

const storage = {
  /**
   * Find a lead by phone number (normalized, workspace-scoped).
   */
  async findByPhone(phone, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const normalized = (phone || '').replace(/\D/g, '').trim();
    if (!normalized || normalized.length < 7) return null;
    const leads = await this.getLeads({ workspaceId, limit: 10000 });
    return leads.find((l) => {
      const p = (l.phone || l.whatsapp || '').replace(/\D/g, '').trim();
      // Empty phone must NEVER match — ''.endsWith(x) is false but x.endsWith('') is true.
      if (!p || p.length < 7) return false;
      return p === normalized || p.endsWith(normalized) || normalized.endsWith(p);
    }) || null;
  },

  /**
   * Get all leads (newest first)
   */
  async getLeads(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const opts = { ...options, workspaceId };
    const driver = resolveDriver();

    if (driver === 'postgres') {
      return await getLeadsFromPostgres(opts);
    }// File driver: scope by workspace (legacy rows without workspaceId belong to default).
    return loadLeadsFromFile().filter(
      lead => (lead.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId
    );
  },

  /**
   * Add new leads, deduplicate against existing, generate UUIDs
   * Returns the actually-added leads
   */
  async addLeads(newLeads, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const enriched = newLeads.map(lead => ({
      ...lead,
      id: lead.id && !String(lead.id).startsWith('lead_') ? lead.id : uuidv4(),
      createdAt: lead.createdAt || new Date().toISOString(),
      source: lead.source || 'scraped',
      workspaceId
    }));

    const driver = resolveDriver();

    if (driver === 'postgres') {
      // Read existing (this workspace only) for dedup, then insert the unique leads.
      const existing = await getLeadsFromPostgres({ workspaceId, limit: 10000 });
      const unique = deduplicateLeads(existing, enriched);
      if (unique.length === 0) {
        console.log('[LeadStorage] All leads are duplicates, nothing added');
        return [];
      }
      const saved = await saveLeadsToPostgres(unique);
      console.log(`[LeadStorage] Saved ${saved.length} leads to Postgres`);
      await syncUniversalContacts(saved, workspaceId);
      return saved;
    }// File-based fallback. Dedup within the workspace, but persist ALL rows
    // (other workspaces' leads must remain intact in the shared file).
    const existingAll = loadLeadsFromFile();
    const existingWs = existingAll.filter(
      lead => (lead.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId
    );
    const unique = deduplicateLeads(existingWs, enriched);
    if (unique.length === 0) {
      console.log('[LeadStorage] All leads are duplicates, nothing added');
      return [];
    }
    const merged = [...unique, ...existingAll];
    saveLeadsToFile(merged);
    console.log(`[LeadStorage] Saved ${unique.length} leads to file (total: ${merged.length})`);
    await syncUniversalContacts(unique, workspaceId);
    return unique;
  },

  /**
   * Delete leads by ID array
   */
  async deleteLeads(ids, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      await deleteLeadsFromPostgres(ids, workspaceId);
      console.log(`[LeadStorage] Deleted leads from Postgres (workspace ${workspaceId})`);
      return;
    }// File driver: only remove rows that match BOTH id and workspace (isolation).
    const existing = loadLeadsFromFile();
    const filtered = existing.filter(
      lead => !(ids.includes(lead.id) && (lead.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId)
    );
    saveLeadsToFile(filtered);
    console.log(`[LeadStorage] Deleted leads from file (removed ${existing.length - filtered.length}, workspace ${workspaceId})`);
  },

  /**
   * Get unique countries and niches for filters
   */
  async getFilters(options = {}) {
    const leads = await this.getLeads({ ...options, limit: 10000 });
    const countries = new Set();
    const niches = new Set();
    for (const lead of leads) {
      if (lead.country) countries.add(lead.country);
      if (lead.niche) niches.add(lead.niche);
    }
    return {
      countries: Array.from(countries).sort(),
      niches: Array.from(niches).sort()
    };
  },

  /**
   * Export all leads (for CSV generation)
   */
  async exportLeads({ workspaceId, country, niche } = {}) {
    let leads = await this.getLeads({ workspaceId, limit: 10000 });
    if (country) leads = leads.filter(l => l.country === country);
    if (niche) leads = leads.filter(l => l.niche === niche);
    return leads;
  },

  /**
   * Update a lead's properties (e.g. notes). Merges new data into existing lead.
   */
  async updateLead(leadId, updates, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      // Fetch existing lead data
      const existing = await this.getLeads({ workspaceId, limit: 10000 });
      const lead = existing.find(l => l.id === leadId);
      if (!lead) return null;

      const merged = { ...lead, ...updates, updatedAt: new Date().toISOString() };
      // Update typed columns that may have changed + notes
      await query(
        `UPDATE leads SET name = $2, phone = $3, country = $4, niche = $5, notes = $6, data = $7 WHERE id = $1 AND workspace_id = $8`,
        [leadId, merged.name || null, merged.phone || null, merged.country || null, merged.niche || null, merged.notes || null, JSON.stringify(merged), workspaceId]
      );
      await syncUniversalContacts([merged], workspaceId);
      return merged;
    }// File-based fallback
    const all = loadLeadsFromFile();
    let updated = null;
    const updatedAll = all.map(lead => {
      if (lead.id === leadId && (lead.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId) {
        updated = { ...lead, ...updates, updatedAt: new Date().toISOString() };
        return updated;
      }
      return lead;
    });
    saveLeadsToFile(updatedAll);
    if (updated) await syncUniversalContacts([updated], workspaceId);
    return updated;
  }
};

module.exports = storage;
