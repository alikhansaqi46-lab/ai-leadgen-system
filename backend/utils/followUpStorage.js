/**
 * Follow-Up Sequence Storage (S9 — Foundation Hardening).
 *
 * Replaces the hardcoded follow_up_1 / follow_up_2 columns on the campaigns table
 * with a flexible sequence system that supports unlimited steps and any channel.
 *
 * Same pluggable driver dispatch as other storage seams (STORAGE_DRIVER).
 * Every method is workspace-scoped.
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const fs = require('fs');
const path = require('path');

const SEQUENCES_FILE = path.join(__dirname, '..', 'data', 'follow_up_sequences.json');
const LEAD_FOLLOWUPS_FILE = path.join(__dirname, '..', 'data', 'lead_follow_ups.json');
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
    console.error(`[FollowUpStorage] Failed to load ${path.basename(file)}:`, err.message);
    return [];
  }
}

function save(file, rows) {
  ensureDir(file);
  try {
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(`[FollowUpStorage] Failed to save ${path.basename(file)}:`, err.message);
  }
}

function now() { return new Date().toISOString(); }

/* ==================== SEQUENCES ==================== */

const followUpStorage = {
  /** Create or upsert a follow-up sequence. */
  async createSequence(data, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const row = {
      id: data.id || uuidv4(),
      workspaceId,
      name: data.name,
      channel: data.channel,
      steps: data.steps || [],
      isDefault: data.isDefault || false,
      createdAt: now(),
    };

    const driver = resolveDriver();
    if (driver === 'postgres') {
      await query(
        `INSERT INTO follow_up_sequences (id, workspace_id, name, channel, steps, is_default, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, channel = EXCLUDED.channel,
           steps = EXCLUDED.steps, is_default = EXCLUDED.is_default`,
        [row.id, workspaceId, row.name, row.channel, JSON.stringify(row.steps), row.isDefault, row.createdAt]
      );
      return row;
    }    const all = load(SEQUENCES_FILE).filter((r) => r.id !== row.id);
    save(SEQUENCES_FILE, [row, ...all]);
    return row;
  },

  /** Get the default sequence for a channel (or create one if missing). */
  async getDefaultSequence(channel, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `SELECT id, workspace_id, name, channel, steps, is_default, created_at
         FROM follow_up_sequences
         WHERE workspace_id = $1 AND channel = $2 AND is_default = true
         LIMIT 1`,
        [workspaceId, channel]
      );
      if (result.rows.length) {
        const r = result.rows[0];
        return { id: r.id, workspaceId: r.workspace_id, name: r.name, channel: r.channel,
                 steps: r.steps, isDefault: r.is_default, createdAt: r.created_at };
      }
    }
    // Auto-create a default 2-step sequence mimicking the old hardcoded behavior
    const defaultSeq = {
      id: uuidv4(),
      workspaceId,
      name: `Default ${channel} sequence`,
      channel,
      steps: [
        { step: 1, waitDays: 2, template: 'Hi {name}, just following up on my earlier message. Would love to show you how other {niche}s are getting more leads. Open to a quick chat?' },
        { step: 2, waitDays: 5, template: 'Hi {name}, last follow-up from me. I would hate for you to miss out on what other {niche}s are doing. Can we chat for 5 minutes this week?' },
      ],
      isDefault: true,
      createdAt: now(),
    };
    return this.createSequence(defaultSeq, { workspaceId });
  },

  /** Get all sequences for a workspace. */
  async getSequences(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `SELECT id, workspace_id, name, channel, steps, is_default, created_at
         FROM follow_up_sequences WHERE workspace_id = $1 ORDER BY created_at DESC`,
        [workspaceId]
      );
      return result.rows.map((r) => ({
        id: r.id, workspaceId: r.workspace_id, name: r.name, channel: r.channel,
        steps: r.steps, isDefault: r.is_default, createdAt: r.created_at,
      }));
    }

    const rows = load(SEQUENCES_FILE);
    return rows.filter((r) => (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId);
  },

  /* ==================== LEAD FOLLOW-UPS ==================== */

  /** Schedule follow-ups for a lead using a sequence (or default channel sequence). */
  async scheduleFollowUps(leadId, { sequenceId, channel } = {}, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    let seq;
    if (sequenceId) {
      const all = await this.getSequences({ workspaceId });
      seq = all.find((s) => s.id === sequenceId);
    }
    if (!seq && channel) {
      seq = await this.getDefaultSequence(channel, { workspaceId });
    }
    if (!seq) {
      throw new Error('No follow-up sequence found. Provide sequenceId or channel.');
    }

    // Cancel any existing pending follow-ups for this lead
    await this.cancelFollowUps(leadId, { workspaceId });

    const driver = resolveDriver();
    const nowDate = new Date();
    const rows = seq.steps.map((step) => {
      const scheduled = new Date(nowDate);
      scheduled.setDate(scheduled.getDate() + (step.waitDays || 1));
      return {
        id: uuidv4(),
        leadId,
        workspaceId,
        sequenceId: seq.id,
        stepIndex: step.step,
        scheduledAt: scheduled.toISOString(),
        sentAt: null,
        status: 'pending',
        createdAt: now(),
      };
    });

    if (driver === 'postgres') {
      for (const row of rows) {
        await query(
          `INSERT INTO lead_follow_ups (id, lead_id, workspace_id, sequence_id, step_index, scheduled_at, sent_at, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [row.id, row.leadId, workspaceId, row.sequenceId, row.stepIndex, row.scheduledAt, row.sentAt, row.status, row.createdAt]
        );
      }
    } else {
      const all = load(LEAD_FOLLOWUPS_FILE);
      save(LEAD_FOLLOWUPS_FILE, [...all, ...rows]);
    }
    return rows;
  },

  /** Get pending/overdue follow-ups for a lead. */
  async getLeadFollowUps(leadId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `SELECT id, lead_id, workspace_id, sequence_id, step_index, scheduled_at, sent_at, status, created_at
         FROM lead_follow_ups WHERE workspace_id = $1 AND lead_id = $2 ORDER BY step_index ASC`,
        [workspaceId, leadId]
      );
      return result.rows.map((r) => ({
        id: r.id, leadId: r.lead_id, workspaceId: r.workspace_id, sequenceId: r.sequence_id,
        stepIndex: r.step_index, scheduledAt: r.scheduled_at, sentAt: r.sent_at,
        status: r.status, createdAt: r.created_at,
      }));
    }

    const rows = load(LEAD_FOLLOWUPS_FILE);
    return rows
      .filter((r) => (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && r.leadId === leadId)
      .sort((a, b) => (a.stepIndex || 0) - (b.stepIndex || 0));
  },

  /** Get all overdue follow-ups across a workspace. */
  async getOverdueFollowUps(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();
    const nowStr = now();

    if (driver === 'postgres') {
      const result = await query(
        `SELECT id, lead_id, workspace_id, sequence_id, step_index, scheduled_at, sent_at, status, created_at
         FROM lead_follow_ups
         WHERE workspace_id = $1 AND status = 'pending' AND scheduled_at <= $2
         ORDER BY scheduled_at ASC`,
        [workspaceId, nowStr]
      );
      return result.rows.map((r) => ({
        id: r.id, leadId: r.lead_id, workspaceId: r.workspace_id, sequenceId: r.sequence_id,
        stepIndex: r.step_index, scheduledAt: r.scheduled_at, sentAt: r.sent_at,
        status: r.status, createdAt: r.created_at,
      }));
    }

    const rows = load(LEAD_FOLLOWUPS_FILE);
    return rows
      .filter((r) => (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId
        && r.status === 'pending'
        && r.scheduledAt
        && r.scheduledAt <= nowStr)
      .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
  },

  /** Mark a specific follow-up row as sent. */
  async markFollowUpSent(followUpId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();
    const updates = { status: 'sent', sentAt: now() };

    if (driver === 'postgres') {
      await query(
        `UPDATE lead_follow_ups SET status = 'sent', sent_at = $1 WHERE id = $2 AND workspace_id = $3`,
        [updates.sentAt, followUpId, workspaceId]
      );
      return updates;
    }
    const all = load(LEAD_FOLLOWUPS_FILE);
    save(LEAD_FOLLOWUPS_FILE, all.map((r) => (r.id === followUpId ? { ...r, ...updates } : r)));
    return updates;
  },

  /** Cancel all pending follow-ups for a lead. */
  async cancelFollowUps(leadId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      await query(
        `UPDATE lead_follow_ups SET status = 'cancelled' WHERE lead_id = $1 AND workspace_id = $2 AND status = 'pending'`,
        [leadId, workspaceId]
      );
      return true;
    }
    const all = load(LEAD_FOLLOWUPS_FILE);
    save(LEAD_FOLLOWUPS_FILE, all.map((r) => (
      (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && r.leadId === leadId && r.status === 'pending'
        ? { ...r, status: 'cancelled' } : r
    )));
    return true;
  },

  /** Count pending follow-ups for analytics. */
  async getPendingCount(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `SELECT COUNT(*) AS cnt FROM lead_follow_ups WHERE workspace_id = $1 AND status = 'pending'`,
        [workspaceId]
      );
      return parseInt(result.rows[0].cnt, 10);
    }

    const rows = load(LEAD_FOLLOWUPS_FILE);
    return rows.filter((r) => (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && r.status === 'pending').length;
  },
};

module.exports = followUpStorage;
