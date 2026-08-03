/**
 * Unified Timeline Storage (S8).
 *
 * Every significant action on a lead is recorded as an event.
 * This is the single source of truth for the lead activity feed.
 *
 * Same pluggable driver dispatch as other storage seams (STORAGE_DRIVER).
 * Every method is workspace-scoped.
 *
 * Event types:
 *   'lead_created' | 'message_sent' | 'message_received' | 'message_delivered' | 'message_read'
 * | 'email_sent' | 'email_opened' | 'link_clicked' | 'email_bounced'
 * | 'call_made' | 'call_completed' | 'status_changed' | 'note' | 'ai_action'
 * | 'follow_up_scheduled' | 'follow_up_sent' | 'message_failed'
 *
 * Channels: 'whatsapp' | 'email' | 'sms' | 'call' | null
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const fs = require('fs');
const path = require('path');

const EVENTS_FILE = path.join(__dirname, '..', 'data', 'lead_events.json');
const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || 'default';

function resolveDriver() {
  const d = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  if (d === 'postgres' || d === 'pg') return 'postgres';
  if (d === 'json' || d === 'file') return 'json';
  return process.env.DATABASE_URL ? 'postgres' : 'json';
}

function ensureDir(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load(file) {
  ensureDir(file);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`[TimelineStorage] Failed to load ${path.basename(file)}:`, err.message);
    return [];
  }
}

function save(file, rows) {
  ensureDir(file);
  try {
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(`[TimelineStorage] Failed to save ${path.basename(file)}:`, err.message);
  }
}

function eventFromPg(r, workspaceId) {
  return {
    id: r.id,
    leadId: r.lead_id,
    workspaceId,
    type: r.type,
    channel: r.channel,
    conversationId: r.conversation_id,
    referenceId: r.reference_id,
    payload: r.payload,
    createdAt: r.created_at,
  };
}

/* ---------- API ---------- */

const timelineStorage = {
  /** Record a single timeline event. Returns the created event. */
  async recordEvent({ leadId, type, channel, conversationId, referenceId, payload }, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const now = new Date().toISOString();
    const row = {
      id: uuidv4(),
      leadId,
      workspaceId,
      type,
      channel: channel || null,
      conversationId: conversationId || null,
      referenceId: referenceId || null,
      payload: payload || null,
      createdAt: now,
    };

    const driver = resolveDriver();
    if (driver === 'postgres') {
      await query(
        `INSERT INTO lead_events
           (id, lead_id, workspace_id, type, channel, conversation_id, reference_id, payload, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [row.id, row.leadId, workspaceId, row.type, row.channel, row.conversationId, row.referenceId,
         row.payload ? JSON.stringify(row.payload) : null, row.createdAt]
      );
      return row;
    }
    const all = load(EVENTS_FILE);
    save(EVENTS_FILE, [row, ...all]);
    return row;
  },

  /** Get events for a lead (newest first). */
  async getEvents(leadId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `SELECT id, lead_id, workspace_id, type, channel, conversation_id, reference_id, payload, created_at
         FROM lead_events
         WHERE workspace_id = $1 AND lead_id = $2
         ORDER BY created_at DESC`,
        [workspaceId, leadId]
      );
      return result.rows.map((r) => eventFromPg(r, workspaceId));
    }

    const rows = load(EVENTS_FILE);
    return rows
      .filter((r) => (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && r.leadId === leadId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  },

  /** Get events across a workspace, paginated. */
  async getWorkspaceEvents(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const limit = options.limit || 100;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `SELECT id, lead_id, workspace_id, type, channel, conversation_id, reference_id, payload, created_at
         FROM lead_events
         WHERE workspace_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [workspaceId, limit]
      );
      return result.rows.map((r) => eventFromPg(r, workspaceId));
    }

    const rows = load(EVENTS_FILE);
    return rows
      .filter((r) => (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  },
};

module.exports = timelineStorage;
