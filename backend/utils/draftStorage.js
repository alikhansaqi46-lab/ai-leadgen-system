/**
 * Outreach-draft storage (S5.2).
 *
 * Stores AI-generated outreach messages (cold email / WhatsApp / follow-ups) as
 * "drafts" pending human approval. Approve-before-send is a hard gate: V1 never
 * auto-sends, so a draft only ever moves draft → approved | rejected here.
 *
 * Uses the SAME pluggable driver dispatch as leadStorage.js / scoreStorage.js
 * (selected by STORAGE_DRIVER). Every method is workspace-scoped.
 *
 * Draft shape:
 *   { id, leadId, workspaceId, channel, kind, step, waitDays, subject, body,
 *     status, model, createdAt, updatedAt }
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'drafts.json');
const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || 'default';
const VALID_STATUS = ['draft', 'approved', 'rejected'];

function resolveDriver() {
  const d = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  if (d === 'postgres' || d === 'pg') return 'postgres';
  if (d === 'json' || d === 'file') return 'json';
  return process.env.DATABASE_URL ? 'postgres' : 'json';
}

/* ---------- file helpers ---------- */

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadFromFile() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[DraftStorage] Failed to load drafts file:', err.message);
    return [];
  }
}

function saveToFile(rows) {
  ensureDataDir();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error('[DraftStorage] Failed to save drafts file:', err.message);
  }
}

function rowFromPg(r, workspaceId) {
  return {
    id: r.id,
    leadId: r.lead_id,
    workspaceId,
    channel: r.channel,
    kind: r.kind,
    step: r.step,
    waitDays: r.wait_days,
    subject: r.subject,
    body: r.body,
    status: r.status,
    model: r.model,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ---------- unified API ---------- */

const draftStorage = {
  /** List drafts for a workspace, optionally filtered by leadId / status. */
  async getDrafts(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const { leadId, status } = options;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const clauses = ['workspace_id = $1'];
      const params = [workspaceId];
      if (leadId) { params.push(leadId); clauses.push(`lead_id = $${params.length}`); }
      if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
      const result = await query(
        `SELECT id, lead_id, channel, kind, step, wait_days, subject, body, status, model, created_at, updated_at
         FROM outreach_drafts WHERE ${clauses.join(' AND ')}
         ORDER BY lead_id, step, channel`,
        params
      );
      return result.rows.map((r) => rowFromPg(r, workspaceId));
    }

    const rows = loadFromFile();
    return rows.filter(
      (r) =>
        (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId &&
        (!leadId || r.leadId === leadId) &&
        (!status || r.status === status)
    );
  },

  /** Fetch a single draft by id (workspace-scoped) or null. */
  async getDraftById(id, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const all = await this.getDrafts({ workspaceId });
    return all.find((d) => d.id === id) || null;
  },

  /**
   * Replace a lead's drafts with a freshly generated set (regenerating is
   * idempotent — old drafts for that lead are removed first). `templates` is the
   * output of aiProvider.generateOutreach(). Returns the created draft rows.
   */
  async replaceDraftsForLead(leadId, templates, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const now = new Date().toISOString();
    const rows = (templates || []).map((t) => ({
      id: uuidv4(),
      leadId,
      workspaceId,
      channel: t.channel,
      kind: t.kind,
      step: t.step,
      waitDays: t.waitDays,
      subject: t.subject || null,
      body: t.body,
      status: 'draft',
      model: t.model || null,
      createdAt: now,
      updatedAt: now,
    }));

    await this.deleteDraftsForLead(leadId, { workspaceId });
    if (rows.length === 0) return [];
    const driver = resolveDriver();

    if (driver === 'postgres') {
      for (const r of rows) {
        await query(
          `INSERT INTO outreach_drafts
             (id, lead_id, workspace_id, channel, kind, step, wait_days, subject, body, status, model, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [r.id, r.leadId, workspaceId, r.channel, r.kind, r.step, r.waitDays, r.subject, r.body, r.status, r.model, r.createdAt, r.updatedAt]
        );
      }
      return rows;
    }

    const all = loadFromFile();
    saveToFile([...rows, ...all]);
    return rows;
  },

  /** Set a draft's status (approve/reject). Workspace-scoped: returns the updated row or null. */
  async setDraftStatus(id, status, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (!VALID_STATUS.includes(status)) {
      throw new Error(`Invalid draft status: ${status}`);
    }
    const now = new Date().toISOString();
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `UPDATE outreach_drafts SET status = $1, updated_at = $2
         WHERE id = $3 AND workspace_id = $4
         RETURNING id, lead_id, channel, kind, step, wait_days, subject, body, status, model, created_at, updated_at`,
        [status, now, id, workspaceId]
      );
      return result.rows.length ? rowFromPg(result.rows[0], workspaceId) : null;
    }

    const all = loadFromFile();
    let updated = null;
    const next = all.map((r) => {
      if (r.id === id && (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId) {
        updated = { ...r, status, updatedAt: now };
        return updated;
      }
      return r;
    });
    if (updated) saveToFile(next);
    return updated;
  },

  /** Delete all drafts for a lead within a workspace. */
  async deleteDraftsForLead(leadId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      await query(`DELETE FROM outreach_drafts WHERE workspace_id = $1 AND lead_id = $2`, [workspaceId, leadId]);
      return;
    }

    const all = loadFromFile();
    const filtered = all.filter(
      (r) => !((r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && r.leadId === leadId)
    );
    saveToFile(filtered);
  },
};

module.exports = draftStorage;
