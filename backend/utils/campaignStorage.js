/**
 * Campaign + lead-status storage (S6 — WhatsApp CRM).
 *
 * Tracks per-lead outreach lifecycle: sent → replied → interested → meeting → deal.
 * Stores follow-up scheduling state and campaign analytics.
 * Same pluggable driver dispatch as other storage seams (STORAGE_DRIVER).
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const fs = require('fs');
const path = require('path');
const timelineStorage = require('./timelineStorage');
const followUpStorage = require('./followUpStorage');

const CAMPAIGN_FILE = path.join(__dirname, '..', 'data', 'campaigns.json');
const FOLLOWUP_FILE = path.join(__dirname, '..', 'data', 'followups.json');
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
    console.error(`[CampaignStorage] Failed to load ${path.basename(file)}:`, err.message);
    return [];
  }
}

function save(file, rows) {
  ensureDir(file);
  try {
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(`[CampaignStorage] Failed to save ${path.basename(file)}:`, err.message);
  }
}

function now() { return new Date().toISOString(); }

/* ==================== CAMPAIGN RECORDS ==================== */

const campaignStorage = {
  /** Get or create campaign record for a lead. */
  async getOrCreate({ leadId, workspaceId, testMode = false }) {
    const ws = workspaceId || DEFAULT_WORKSPACE_ID;
    const existing = await this.getByLeadId(leadId, { workspaceId: ws });
    if (existing) return existing;

    const row = {
      id: uuidv4(),
      leadId,
      workspaceId: ws,
      status: 'new',
      sentAt: null,
      repliedAt: null,
      interestedAt: null,
      meetingAt: null,
      dealAt: null,
      lostAt: null,
      followUp1At: null,
      followUp2At: null,
      followUp1Sent: false,
      followUp2Sent: false,
      messageCount: 0,
      replyCount: 0,
      testMode: testMode,
      revenue: null,
      createdAt: now(),
      updatedAt: now(),
    };

    const driver = resolveDriver();
    if (driver === 'postgres') {
      try {
        await query(
          `INSERT INTO campaigns (id, lead_id, workspace_id, status, sent_at, replied_at, interested_at, meeting_at, deal_at, lost_at,
           follow_up_1_at, follow_up_2_at, follow_up_1_sent, follow_up_2_sent, message_count, reply_count, test_mode, revenue, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [row.id, row.leadId, ws, row.status, row.sentAt, row.repliedAt, row.interestedAt, row.meetingAt, row.dealAt, row.lostAt,
           row.followUp1At, row.followUp2At, row.followUp1Sent, row.followUp2Sent, row.messageCount, row.replyCount, row.testMode, row.revenue, row.createdAt, row.updatedAt]
        );
      } catch (err) {
        if (!/revenue/i.test(err.message)) throw err;
        await query(
          `INSERT INTO campaigns (id, lead_id, workspace_id, status, sent_at, replied_at, interested_at, meeting_at, deal_at, lost_at,
           follow_up_1_at, follow_up_2_at, follow_up_1_sent, follow_up_2_sent, message_count, reply_count, test_mode, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [row.id, row.leadId, ws, row.status, row.sentAt, row.repliedAt, row.interestedAt, row.meetingAt, row.dealAt, row.lostAt,
           row.followUp1At, row.followUp2At, row.followUp1Sent, row.followUp2Sent, row.messageCount, row.replyCount, row.testMode, row.createdAt, row.updatedAt]
        );
      }
      return row;
    }
    const all = load(CAMPAIGN_FILE);
    save(CAMPAIGN_FILE, [row, ...all]);
    return row;
  },

  async getByLeadId(leadId, options = {}) {
    const ws = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const all = await this.getAll({ workspaceId: ws });
    return all.find((r) => r.leadId === leadId) || null;
  },

  async getAll(options = {}) {
    const ws = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const mapRow = (r) => ({
        id: r.id, leadId: r.lead_id, workspaceId: r.workspace_id, status: r.status,
        sentAt: r.sent_at, repliedAt: r.replied_at, interestedAt: r.interested_at,
        meetingAt: r.meeting_at, dealAt: r.deal_at, lostAt: r.lost_at,
        followUp1At: r.follow_up_1_at, followUp2At: r.follow_up_2_at,
        followUp1Sent: r.follow_up_1_sent, followUp2Sent: r.follow_up_2_sent,
        messageCount: r.message_count, replyCount: r.reply_count,
        testMode: r.test_mode, revenue: r.revenue != null ? Number(r.revenue) : null,
        createdAt: r.created_at, updatedAt: r.updated_at,
      });
      try {
        const result = await query(
          `SELECT id, lead_id, workspace_id, status, sent_at, replied_at, interested_at, meeting_at, deal_at, lost_at,
           follow_up_1_at, follow_up_2_at, follow_up_1_sent, follow_up_2_sent, message_count, reply_count, test_mode, revenue, created_at, updated_at
           FROM campaigns WHERE workspace_id = $1 ORDER BY updated_at DESC`,
          [ws]
        );
        return result.rows.map(mapRow);
      } catch (err) {
        // Older DBs may not have campaigns.revenue yet (schema.sql ALTER not applied).
        if (!/revenue/i.test(err.message)) throw err;
        const result = await query(
          `SELECT id, lead_id, workspace_id, status, sent_at, replied_at, interested_at, meeting_at, deal_at, lost_at,
           follow_up_1_at, follow_up_2_at, follow_up_1_sent, follow_up_2_sent, message_count, reply_count, test_mode, created_at, updated_at
           FROM campaigns WHERE workspace_id = $1 ORDER BY updated_at DESC`,
          [ws]
        );
        return result.rows.map((r) => mapRow({ ...r, revenue: null }));
      }
    }

    const rows = load(CAMPAIGN_FILE);
    return rows.filter((r) => (r.workspaceId || DEFAULT_WORKSPACE_ID) === ws);
  },

  /** Update status and timestamp fields. Optional revenue for deal/pipeline value.
   *  Creates campaign row if missing (never silent no-op). */
  async updateStatus(leadId, status, options = {}) {
    const ws = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const existing = await this.getOrCreate({ leadId, workspaceId: ws, testMode: !!options.testMode });

    const updates = { status, updatedAt: now() };
    const tsFields = { sent: 'sentAt', replied: 'repliedAt', interested: 'interestedAt', meeting: 'meetingAt', deal: 'dealAt', lost: 'lostAt' };
    if (tsFields[status]) updates[tsFields[status]] = now();
    if (options.revenue != null && options.revenue !== '') {
      const rev = Number(options.revenue);
      if (Number.isFinite(rev)) updates.revenue = rev;
    }

    const driver = resolveDriver();
    if (driver === 'postgres') {
      const setClause = Object.keys(updates).map((k, i) => `${snake(k)} = $${i + 3}`).join(', ');
      const values = [leadId, ws, ...Object.values(updates)];
      try {
        await query(`UPDATE campaigns SET ${setClause} WHERE lead_id = $1 AND workspace_id = $2`, values);
      } catch (err) {
        // If revenue column missing on older DBs, retry without revenue
        if (updates.revenue != null && /revenue/i.test(err.message)) {
          const { revenue, ...rest } = updates;
          const keys = Object.keys(rest);
          const set2 = keys.map((k, i) => `${snake(k)} = $${i + 3}`).join(', ');
          await query(`UPDATE campaigns SET ${set2} WHERE lead_id = $1 AND workspace_id = $2`, [leadId, ws, ...Object.values(rest)]);
        } else {
          throw err;
        }
      }
    } else {
      const all = load(CAMPAIGN_FILE);
      save(CAMPAIGN_FILE, all.map((r) => (r.id === existing.id ? { ...r, ...updates } : r)));
    }
    try {
      await timelineStorage.recordEvent({
        leadId,
        type: 'status_changed',
        payload: { from: existing.status, to: status, revenue: updates.revenue ?? null },
      }, { workspaceId: ws });
    } catch (tlErr) {
      console.error('[CampaignStorage] Timeline event failed (non-fatal):', tlErr.message);
    }
    return { ...existing, ...updates };
  },

  /** Record a message sent (increment count; promote to 'sent' only from new). */
  async recordSent(leadId, options = {}) {
    const ws = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const record = await this.getOrCreate({ leadId, workspaceId: ws });
    const prev = String(record.status || 'new').toLowerCase();
    // Never demote past sent (interested/meeting/deal/lost/replied stay put)
    const promoteToSent = prev === 'new' || !prev;
    const nextStatus = promoteToSent ? 'sent' : record.status;
    const updates = {
      messageCount: (record.messageCount || 0) + 1,
      status: nextStatus,
      updatedAt: now(),
      sentAt: record.sentAt || now(),
    };

    const driver = resolveDriver();
    if (driver === 'postgres') {
      if (promoteToSent) {
        await query(
          `UPDATE campaigns SET message_count = message_count + 1, status = 'sent', sent_at = COALESCE(sent_at, NOW()), updated_at = NOW()
           WHERE lead_id = $1 AND workspace_id = $2`,
          [leadId, ws]
        );
      } else {
        await query(
          `UPDATE campaigns SET message_count = message_count + 1, sent_at = COALESCE(sent_at, NOW()), updated_at = NOW()
           WHERE lead_id = $1 AND workspace_id = $2`,
          [leadId, ws]
        );
      }
    } else {
      const all = load(CAMPAIGN_FILE);
      save(CAMPAIGN_FILE, all.map((r) => (r.id === record.id ? { ...r, ...updates } : r)));
    }

    if (promoteToSent) {
      try {
        await timelineStorage.recordEvent({
          leadId,
          type: 'status_changed',
          channel: options.channel || null,
          payload: { from: record.status, to: 'sent', trigger: 'message_sent', channel: options.channel || null },
        }, { workspaceId: ws });
      } catch (tlErr) {
        console.error('[CampaignStorage] Timeline event failed (non-fatal):', tlErr.message);
      }
    }
    return { ...record, ...updates };
  },

  /** Record a reply (increment count; promote to 'replied' only from new/sent). */
  async recordReply(leadId, options = {}) {
    const ws = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const record = await this.getOrCreate({ leadId, workspaceId: ws });
    const prev = String(record.status || 'new').toLowerCase();
    const promoteToReplied = prev === 'new' || prev === 'sent';
    const nextStatus = promoteToReplied ? 'replied' : record.status;
    const updates = {
      replyCount: (record.replyCount || 0) + 1,
      status: nextStatus,
      updatedAt: now(),
      repliedAt: record.repliedAt || now(),
    };

    const driver = resolveDriver();
    if (driver === 'postgres') {
      if (promoteToReplied) {
        await query(
          `UPDATE campaigns SET reply_count = reply_count + 1, status = 'replied', replied_at = NOW(), updated_at = NOW()
           WHERE lead_id = $1 AND workspace_id = $2`,
          [leadId, ws]
        );
      } else {
        await query(
          `UPDATE campaigns SET reply_count = reply_count + 1, replied_at = COALESCE(replied_at, NOW()), updated_at = NOW()
           WHERE lead_id = $1 AND workspace_id = $2`,
          [leadId, ws]
        );
      }
    } else {
      const all = load(CAMPAIGN_FILE);
      save(CAMPAIGN_FILE, all.map((r) => (r.id === record.id ? { ...r, ...updates } : r)));
    }

    if (promoteToReplied) {
      try {
        await timelineStorage.recordEvent({
          leadId,
          type: 'status_changed',
          channel: options.channel || null,
          payload: { from: record.status, to: 'replied', trigger: 'message_received', channel: options.channel || null },
        }, { workspaceId: ws });
      } catch (tlErr) {
        console.error('[CampaignStorage] Timeline event failed (non-fatal):', tlErr.message);
      }
    }
    // Fire automation engine (non-blocking)
    try {
      const { dispatchEvent } = require('../services/automationEngine');
      dispatchEvent('reply_received', {
        leadId,
        workspaceId: ws,
        channel: options.channel || null,
        campaignStatus: nextStatus,
        messageText: options.messageText || options.body || '',
      }, { workspaceId: ws }).catch((e) => console.error('[Automations] reply_received dispatch failed:', e.message));
    } catch (e) {
      console.error('[Automations] reply_received hook failed:', e.message);
    }

    return { ...record, ...updates };
  },

  /** Schedule follow-ups for a lead. days1 and days2 are offsets from now.
   *  Writes to BOTH old columns (backward compat) and new follow-up tables. */
  async scheduleFollowUps(leadId, { days1 = 2, days2 = 5 } = {}, options = {}) {
    const ws = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const record = await this.getOrCreate({ leadId, workspaceId: ws });
    const d1 = new Date(); d1.setDate(d1.getDate() + days1);
    const d2 = new Date(); d2.setDate(d2.getDate() + days2);
    const updates = { followUp1At: d1.toISOString(), followUp2At: d2.toISOString(), updatedAt: now() };

    // Keep old columns updated for backward compatibility
    const driver = resolveDriver();
    if (driver === 'postgres') {
      await query(`UPDATE campaigns SET follow_up_1_at = $3, follow_up_2_at = $4, updated_at = NOW() WHERE lead_id = $1 AND workspace_id = $2`, [leadId, ws, updates.followUp1At, updates.followUp2At]);
    }
    // Also write to new follow-up tables
    try {
      const channel = options.channel || 'whatsapp';
      await followUpStorage.scheduleFollowUps(leadId, { channel }, { workspaceId: ws });
      await timelineStorage.recordEvent({
        leadId,
        type: 'follow_up_scheduled',
        payload: { days1, days2, channel },
      }, { workspaceId: ws });
    } catch (fuErr) {
      console.error('[CampaignStorage] New follow-up table write failed (non-fatal):', fuErr.message);
    }

    return { ...record, ...updates };
  },

  /** Cancel follow-ups (e.g. when lead replies). */
  async cancelFollowUps(leadId, options = {}) {
    const ws = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const record = await this.getByLeadId(leadId, { workspaceId: ws });
    if (!record) return null;
    const updates = { followUp1At: null, followUp2At: null, updatedAt: now() };

    // Keep old columns updated for backward compatibility
    const driver = resolveDriver();
    if (driver === 'postgres') {
      await query(`UPDATE campaigns SET follow_up_1_at = NULL, follow_up_2_at = NULL, updated_at = NOW() WHERE lead_id = $1 AND workspace_id = $2`, [leadId, ws]);
    }
    // Also cancel in new follow-up tables
    try {
      await followUpStorage.cancelFollowUps(leadId, { workspaceId: ws });
      await timelineStorage.recordEvent({
        leadId,
        type: 'follow_up_cancelled',
        payload: { reason: 'lead_replied_or_status_change' },
      }, { workspaceId: ws });
    } catch (fuErr) {
      console.error('[CampaignStorage] New follow-up cancel failed (non-fatal):', fuErr.message);
    }
    return { ...record, ...updates };
  },

  /** Mark a follow-up as sent.
   *  num=1|2 maps to the old columns; new table rows are matched by lead + pending status. */
  async markFollowUpSent(leadId, num, options = {}) {
    const ws = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const record = await this.getByLeadId(leadId, { workspaceId: ws });
    if (!record) return null;
    const field = num === 1 ? 'followUp1Sent' : 'followUp2Sent';
    const updates = { [field]: true, updatedAt: now() };

    // Keep old columns updated for backward compatibility
    const driver = resolveDriver();
    if (driver === 'postgres') {
      const col = num === 1 ? 'follow_up_1_sent' : 'follow_up_2_sent';
      await query(`UPDATE campaigns SET ${col} = true, updated_at = NOW() WHERE lead_id = $1 AND workspace_id = $2`, [leadId, ws]);
    }
    // Also mark the corresponding new follow-up row as sent
    try {
      const pending = await followUpStorage.getLeadFollowUps(leadId, { workspaceId: ws });
      const target = pending
        .filter((p) => p.status === 'pending')
        .sort((a, b) => (a.stepIndex || 0) - (b.stepIndex || 0))[num - 1];
      if (target) {
        await followUpStorage.markFollowUpSent(target.id, { workspaceId: ws });
      }
      await timelineStorage.recordEvent({
        leadId,
        type: 'follow_up_sent',
        payload: { followUpNumber: num, followUpId: target?.id || null },
      }, { workspaceId: ws });
    } catch (fuErr) {
      console.error('[CampaignStorage] New follow-up mark sent failed (non-fatal):', fuErr.message);
    }
    return { ...record, ...updates };
  },

  /** Get overdue follow-ups (those whose date has passed but not sent).
   *  Primary source: new lead_follow_ups table. Falls back to old columns. */
  async getOverdueFollowUps(options = {}) {
    const ws = options.workspaceId || DEFAULT_WORKSPACE_ID;

    // Try new table first
    try {
      const fromNew = await followUpStorage.getOverdueFollowUps({ workspaceId: ws });
      if (fromNew.length > 0) return fromNew;
    } catch (fuErr) {
      console.error('[CampaignStorage] New follow-up overdue query failed, falling back to old columns:', fuErr.message);
    }

    // Fallback to old hardcoded columns
    const all = await this.getAll({ workspaceId: ws });
    const nowStr = now();
    return all.filter((r) => {
      if (r.status === 'replied' || r.status === 'deal' || r.status === 'lost') return false;
      if (!r.followUp1Sent && r.followUp1At && r.followUp1At < nowStr) return true;
      if (!r.followUp2Sent && r.followUp2At && r.followUp2At < nowStr) return true;
      return false;
    });
  },

  /** Get analytics summary for dashboard — single source of truth for pipeline + analytics. */
  async getAnalytics(options = {}) {
    const ws = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const all = await this.getAll({ workspaceId: ws });
    const conversationStorage = require('./conversationStorage');
    const channels = await conversationStorage.getMessageCountsByChannel({ workspaceId: ws }).catch(() => ({
      email: { sent: 0, replies: 0 },
      whatsapp: { sent: 0, replies: 0 },
      sms: { sent: 0, replies: 0 },
    }));

    const campaignMessagesSent = all.reduce((sum, r) => sum + (r.messageCount || 0), 0);
    const campaignRepliesReceived = all.reduce((sum, r) => sum + (r.replyCount || 0), 0);
    const conversationMessagesSent = Object.values(channels).reduce((sum, ch) => sum + (ch?.sent || 0), 0);
    const conversationRepliesReceived = Object.values(channels).reduce((sum, ch) => sum + (ch?.replies || 0), 0);

    const byStatus = {
      new: all.filter((r) => !r.status || r.status === 'new').length,
      sent: all.filter((r) => r.status === 'sent').length,
      replied: all.filter((r) => r.status === 'replied').length,
      interested: all.filter((r) => r.status === 'interested').length,
      meeting: all.filter((r) => r.status === 'meeting').length,
      deal: all.filter((r) => r.status === 'deal').length,
      lost: all.filter((r) => r.status === 'lost').length,
    };

    return {
      total: all.length,
      sent: all.filter((r) => r.status !== 'new').length,
      replied: all.filter((r) => r.status === 'replied' || r.status === 'interested' || r.status === 'meeting' || r.status === 'deal').length,
      interested: all.filter((r) => r.status === 'interested' || r.status === 'meeting' || r.status === 'deal').length,
      meeting: all.filter((r) => r.status === 'meeting' || r.status === 'deal').length,
      deal: all.filter((r) => r.status === 'deal').length,
      lost: all.filter((r) => r.status === 'lost').length,
      byStatus,
      channels,
      messagesSent: Math.max(campaignMessagesSent, conversationMessagesSent),
      repliesReceived: Math.max(campaignRepliesReceived, conversationRepliesReceived),
      followUpsPending: (await followUpStorage.getPendingCount({ workspaceId: ws }).catch(() => 0))
        || all.filter((r) => r.followUp1At && !r.followUp1Sent).length,
    };
  },
};

function snake(str) {
  return str.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

module.exports = campaignStorage;
