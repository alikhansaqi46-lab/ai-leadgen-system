/**
 * Conversation + message storage (S5.3 — Inbox foundation).
 *
 * Threads two-way outreach with a lead. A conversation groups messages for one
 * (lead, channel); a message is a single outbound/inbound entry.
 *
 * Same pluggable driver dispatch as the other seams (STORAGE_DRIVER).
 * Every method is workspace-scoped.
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const fs = require('fs');
const path = require('path');
const timelineStorage = require('./timelineStorage');

const CONV_FILE = path.join(__dirname, '..', 'data', 'conversations.json');
const MSG_FILE = path.join(__dirname, '..', 'data', 'messages.json');
const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || 'default';

function resolveDriver() {
  const d = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  if (d === 'postgres' || d === 'pg') return 'postgres';
  if (d === 'json' || d === 'file') return 'json';
  return process.env.DATABASE_URL ? 'postgres' : 'json';
}

/* ---------- file helpers ---------- */

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
    console.error(`[ConversationStorage] Failed to load ${path.basename(file)}:`, err.message);
    return [];
  }
}

function save(file, rows) {
  ensureDir(file);
  try {
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(`[ConversationStorage] Failed to save ${path.basename(file)}:`, err.message);
  }
}

function convFromPg(r, workspaceId) {
  return {
    id: r.id,
    leadId: r.lead_id,
    workspaceId,
    channel: r.channel,
    status: r.status,
    subject: r.subject,
    lastMessageAt: r.last_message_at,
    unreadCount: r.unread_count || 0,
    archived: r.archived || false,
    pinned: r.pinned || false,
    metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : (r.metadata ? (() => { try { return JSON.parse(r.metadata); } catch { return {}; } })() : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function msgFromPg(r, workspaceId) {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    workspaceId,
    direction: r.direction,
    channel: r.channel,
    body: r.body,
    source: r.source,
    draftId: r.draft_id,
    status: r.status || 'sent',
    externalMessageId: r.external_message_id || null,
    messageType: r.message_type || 'text',
    metadata: r.metadata || null,
    createdAt: r.created_at,
  };
}

/* ---------- API ---------- */

const conversationStorage = {
  async ensureSchema() {
    if (resolveDriver() !== 'postgres') return;
    try {
      await query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'`);
    } catch (err) {
      console.warn('[ConversationStorage] ensureSchema metadata:', err.message);
    }
  },

  /** List conversations for a workspace (newest activity first). */
  async getConversations(options = {}) {
    await this.ensureSchema().catch(() => null);
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `SELECT id, lead_id, channel, status, subject, last_message_at, unread_count, archived, pinned, metadata, created_at, updated_at
         FROM conversations WHERE workspace_id = $1
         ORDER BY pinned DESC, last_message_at DESC NULLS LAST, created_at DESC`,
        [workspaceId]
      );
      return result.rows.map((r) => convFromPg(r, workspaceId));
    }

    const rows = load(CONV_FILE);
    return rows
      .filter((r) => (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId)
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return String(b.lastMessageAt || b.createdAt).localeCompare(String(a.lastMessageAt || a.createdAt));
      });
  },

  /** Get a single conversation by ID (workspace-scoped). */
  async getConversation(id, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `SELECT id, lead_id, channel, status, subject, last_message_at, unread_count, archived, pinned, metadata, created_at, updated_at
         FROM conversations WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId]
      );
      if (result.rows.length === 0) return null;
      return convFromPg(result.rows[0], workspaceId);
    }

    const rows = load(CONV_FILE);
    return rows.find((r) => r.id === id && (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId) || null;
  },

  /** Find a conversation by workspace + lead + channel (exact match). */
  async findConversation({ workspaceId, leadId, channel }) {
    const ws = workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `SELECT id, lead_id, channel, status, subject, last_message_at, unread_count, archived, pinned, metadata, created_at, updated_at
         FROM conversations WHERE workspace_id = $1 AND lead_id = $2 AND channel = $3
         LIMIT 1`,
        [ws, leadId, channel]
      );
      if (result.rows.length === 0) return null;
      return convFromPg(result.rows[0], ws);
    }

    const rows = load(CONV_FILE);
    return rows.find((r) =>
      (r.workspaceId || DEFAULT_WORKSPACE_ID) === ws &&
      r.leadId === leadId &&
      r.channel === channel
    ) || null;
  },

  /** Create a new conversation. */
  async createConversation(data, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const now = new Date().toISOString();
    const row = {
      id: data.id || uuidv4(),
      leadId: data.leadId,
      workspaceId,
      channel: data.channel || 'whatsapp',
      status: data.status || 'active',
      subject: data.subject || null,
      lastMessageAt: data.lastMessageAt || null,
      unreadCount: data.unreadCount || 0,
      archived: false,
      pinned: false,
      metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
      createdAt: now,
      updatedAt: now,
    };

    const driver = resolveDriver();
    if (driver === 'postgres') {
      await query(
        `INSERT INTO conversations (id, lead_id, workspace_id, channel, status, subject, last_message_at, unread_count, archived, pinned, metadata, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
        [
          row.id, row.leadId, workspaceId, row.channel, row.status, row.subject,
          row.lastMessageAt, row.unreadCount, row.archived, row.pinned,
          JSON.stringify(row.metadata || {}), row.createdAt, row.updatedAt,
        ]
      );
      return row;
    }

    const all = load(CONV_FILE);
    save(CONV_FILE, [row, ...all]);
    return row;
  },

  /** All conversations for one lead/contact id (any channel). */
  async getConversationsForLead(leadId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const all = await this.getConversations({ workspaceId });
    return all.filter((c) => c.leadId === leadId);
  },

  /** Merge messages across every channel conversation for one lead/contact. */
  async getUnifiedMessagesForLead(leadId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const convs = await this.getConversationsForLead(leadId, { workspaceId });
    const merged = [];
    for (const conv of convs) {
      const msgs = await this.getMessages(conv.id, { workspaceId });
      for (const msg of msgs) {
        merged.push({ ...msg, conversationId: conv.id, conversationChannel: conv.channel });
      }
    }
    merged.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return merged;
  },

  /** List messages in a conversation (oldest first), workspace-scoped. */
  async getMessages(conversationId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    const conv = await this.getConversation(conversationId, { workspaceId });
    if (!conv) return [];

    if (driver === 'postgres') {
      const result = await query(
        `SELECT id, conversation_id, direction, channel, body, source, draft_id, status, external_message_id, message_type, metadata, created_at
         FROM messages WHERE workspace_id = $1 AND conversation_id = $2
         ORDER BY created_at ASC`,
        [workspaceId, conversationId]
      );
      return result.rows.map((r) => msgFromPg(r, workspaceId));
    }

    const rows = load(MSG_FILE);
    return rows
      .filter((r) => (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && r.conversationId === conversationId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  },

  /** Add a message to a conversation. */
  async addMessage(conversationId, message, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const now = new Date().toISOString();
    const isInbound = message.direction === 'inbound';
    const row = {
      id: message.id || uuidv4(),
      conversationId,
      workspaceId,
      direction: message.direction || 'outbound',
      channel: message.channel || 'whatsapp',
      body: message.body || '',
      source: message.source || null,
      draftId: message.draftId || null,
      status: message.status || 'sent',
      externalMessageId: message.externalMessageId || null,
      messageType: message.messageType || 'text',
      metadata: message.metadata || null,
      createdAt: now,
    };

    const driver = resolveDriver();
    if (driver === 'postgres') {
      await query(
        `INSERT INTO messages (id, conversation_id, workspace_id, direction, channel, body, source, draft_id, status, external_message_id, message_type, metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [row.id, row.conversationId, workspaceId, row.direction, row.channel, row.body, row.source, row.draftId, row.status, row.externalMessageId, row.messageType, row.metadata ? JSON.stringify(row.metadata) : null, row.createdAt]
      );
      await query(
        `UPDATE conversations SET last_message_at = $1, unread_count = unread_count + $2, updated_at = $1 WHERE id = $3 AND workspace_id = $4`,
        [now, isInbound ? 1 : 0, conversationId, workspaceId]
      );
    } else {
      const msgs = load(MSG_FILE);
      save(MSG_FILE, [...msgs, row]);
      const convs = load(CONV_FILE);
      save(CONV_FILE, convs.map((c) => (c.id === conversationId ? {
        ...c,
        unreadCount: isInbound ? ((c.unreadCount || 0) + 1) : (c.unreadCount || 0),
        lastMessageAt: now,
        updatedAt: now,
      } : c)));
    }

    try {
      await timelineStorage.recordEvent({
        leadId: (await this.getConversation(conversationId, { workspaceId }))?.leadId,
        type: isInbound ? 'message_received' : 'message_sent',
        channel: row.channel,
        conversationId,
        referenceId: row.id,
        payload: {
          body: row.body,
          direction: row.direction,
          source: row.source,
          messageType: row.messageType,
          externalMessageId: row.externalMessageId,
        },
      }, { workspaceId });
    } catch (tlErr) {
      console.error('[ConversationStorage] Timeline event failed (non-fatal):', tlErr.message);
    }
    return row;
  },

  /** Mark all messages in a conversation as read and reset unreadCount. */
  async markMessagesRead(conversationId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      await query(
        `UPDATE conversations SET unread_count = 0, updated_at = $1 WHERE id = $2 AND workspace_id = $3`,
        [new Date().toISOString(), conversationId, workspaceId]
      );
      return true;
    }

    const convs = load(CONV_FILE);
    save(CONV_FILE, convs.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0, updatedAt: new Date().toISOString() } : c)));
    return true;
  },

  /** Return message row if external id already stored in this workspace. */
  async findMessageByExternalId(externalMessageId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (!externalMessageId) return null;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `SELECT m.id, m.conversation_id, m.direction, m.channel, m.source, m.external_message_id, c.lead_id
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id AND c.workspace_id = m.workspace_id
         WHERE m.external_message_id = $1 AND m.workspace_id = $2
         LIMIT 1`,
        [externalMessageId, workspaceId]
      );
      if (!result.rowCount) return null;
      const r = result.rows[0];
      return {
        id: r.id,
        conversationId: r.conversation_id,
        leadId: r.lead_id,
        direction: r.direction,
        channel: r.channel,
        source: r.source,
        externalMessageId: r.external_message_id,
      };
    }

    const msgs = load(MSG_FILE);
    const found = msgs.find(
      (m) => (m.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && m.externalMessageId === externalMessageId
    );
    if (!found) return null;
    return {
      id: found.id,
      conversationId: found.conversationId,
      leadId: found.leadId || null,
      direction: found.direction,
      channel: found.channel,
      source: found.source,
      externalMessageId: found.externalMessageId,
    };
  },

  /** Update message delivery status by Meta/external message ID (for read receipts). */
  async updateMessageStatusByExternalId(externalMessageId, status, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (!externalMessageId) return null;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `UPDATE messages m
         SET status = $1
         FROM conversations c
         WHERE m.external_message_id = $2
           AND m.workspace_id = $3
           AND c.id = m.conversation_id
           AND c.workspace_id = m.workspace_id
         RETURNING m.id, m.conversation_id, m.channel, c.lead_id`,
        [status, externalMessageId, workspaceId]
      );
      if (!result.rowCount) return null;
      const r = result.rows[0];
      return {
        id: r.id,
        conversationId: r.conversation_id,
        leadId: r.lead_id,
        channel: r.channel,
        status,
      };
    }

    const msgs = load(MSG_FILE);
    let found = null;
    const updated = msgs.map((m) => {
      if ((m.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && m.externalMessageId === externalMessageId) {
        found = { ...m, status, updatedAt: new Date().toISOString() };
        return found;
      }
      return m;
    });
    if (!found) return null;
    save(MSG_FILE, updated);
    let leadId = found.leadId || null;
    if (!leadId && found.conversationId) {
      const conv = await this.getConversation(found.conversationId, { workspaceId });
      leadId = conv?.leadId || null;
    }
    return {
      id: found.id,
      conversationId: found.conversationId,
      leadId,
      channel: found.channel || 'whatsapp',
      status,
    };
  },
  /** Get messages for a channel, optionally since a date, for deduplication. */
  async getMessagesByChannel(channel, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const since = options.since || null;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const clauses = ['workspace_id = $1 AND channel = $2'];
      const params = [workspaceId, channel];
      if (since) {
        clauses.push(`created_at >= $${params.length + 1}`);
        params.push(since);
      }
      const result = await query(
        `SELECT id, conversation_id, direction, channel, body, source, draft_id, status, external_message_id, message_type, metadata, created_at
         FROM messages WHERE ${clauses.join(' AND ')}
         ORDER BY created_at ASC`,
        params
      );
      return result.rows.map((r) => msgFromPg(r, workspaceId));
    }

    const rows = load(MSG_FILE);
    return rows
      .filter((r) =>
        (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId &&
        r.channel === channel &&
        (!since || r.createdAt >= since)
      )
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  },

  /** Delete selected messages (workspace-scoped). */
  async deleteMessages(messageIds, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const ids = (Array.isArray(messageIds) ? messageIds : []).filter(Boolean);
    if (!ids.length) return 0;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `DELETE FROM messages WHERE workspace_id = $1 AND id = ANY($2::text[]) RETURNING id`,
        [workspaceId, ids]
      );
      return result.rowCount || 0;
    }

    const msgs = load(MSG_FILE);
    const filtered = msgs.filter((m) => !(ids.includes(m.id) && (m.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId));
    const deleted = msgs.length - filtered.length;
    save(MSG_FILE, filtered);
    return deleted;
  },

  /** Delete a conversation and all its messages. */
  async deleteConversation(id, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();
    if (driver === 'postgres') {
      await query(`DELETE FROM messages WHERE conversation_id = $1 AND workspace_id = $2`, [id, workspaceId]);
      await query(`DELETE FROM conversations WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
      return true;
    }
    const msgs = load(MSG_FILE);
    save(MSG_FILE, msgs.filter((m) => m.conversationId !== id || (m.workspaceId || DEFAULT_WORKSPACE_ID) !== workspaceId));
    const convs = load(CONV_FILE);
    save(CONV_FILE, convs.filter((c) => c.id !== id || (c.workspaceId || DEFAULT_WORKSPACE_ID) !== workspaceId));
    return true;
  },

  /** Bulk-delete conversations and their messages in one pass (workspace-scoped). */
  async bulkDeleteConversations(ids, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const cleanIds = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (!cleanIds.length) return { deleted: 0 };
    const driver = resolveDriver();

    if (driver === 'postgres') {
      await query(`DELETE FROM messages WHERE conversation_id = ANY($1::text[]) AND workspace_id = $2`, [cleanIds, workspaceId]);
      const result = await query(
        `DELETE FROM conversations WHERE id = ANY($1::text[]) AND workspace_id = $2 RETURNING id`,
        [cleanIds, workspaceId]
      );
      return { deleted: result.rowCount || 0 };
    }

    const idSet = new Set(cleanIds);
    const msgs = load(MSG_FILE);
    save(MSG_FILE, msgs.filter((m) => !(idSet.has(m.conversationId) && (m.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId)));
    const convs = load(CONV_FILE);
    const remaining = convs.filter((c) => !(idSet.has(c.id) && (c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId));
    const deleted = convs.length - remaining.length;
    save(CONV_FILE, remaining);
    return { deleted };
  },

  /** Bulk-update the same fields on multiple conversations in one pass (workspace-scoped). */
  async bulkUpdateConversations(ids, updates, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const cleanIds = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (!cleanIds.length) return { updated: 0 };
    const allowed = ['status', 'subject', 'archived', 'pinned', 'unreadCount', 'metadata'];
    const changes = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) changes[key] = updates[key];
    }
    if (Object.keys(changes).length === 0) return { updated: 0 };
    changes.updatedAt = new Date().toISOString();
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const setParts = [];
      const values = [cleanIds, workspaceId];
      for (const [key, value] of Object.entries(changes)) {
        values.push(key === 'metadata' ? JSON.stringify(value || {}) : value);
        const cast = key === 'metadata' ? '::jsonb' : '';
        setParts.push(`${snake(key)} = $${values.length}${cast}`);
      }
      const result = await query(
        `UPDATE conversations SET ${setParts.join(', ')} WHERE id = ANY($1::text[]) AND workspace_id = $2 RETURNING id`,
        values
      );
      return { updated: result.rowCount || 0 };
    }

    const idSet = new Set(cleanIds);
    const convs = load(CONV_FILE);
    let updated = 0;
    const next = convs.map((c) => {
      if (idSet.has(c.id) && (c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId) {
        updated += 1;
        return { ...c, ...changes };
      }
      return c;
    });
    save(CONV_FILE, next);
    return { updated };
  },

  /** Update arbitrary conversation fields (archive, pin, status, etc.). */
  async updateConversation(id, updates, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();
    const allowed = ['status', 'subject', 'archived', 'pinned', 'unreadCount', 'metadata'];
    const changes = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) changes[key] = updates[key];
    }
    if (Object.keys(changes).length === 0) return false;
    changes.updatedAt = new Date().toISOString();

    if (driver === 'postgres') {
      const setParts = [];
      const values = [id, workspaceId];
      for (const [key, value] of Object.entries(changes)) {
        values.push(key === 'metadata' ? JSON.stringify(value || {}) : value);
        const cast = key === 'metadata' ? '::jsonb' : '';
        setParts.push(`${snake(key)} = $${values.length}${cast}`);
      }
      await query(`UPDATE conversations SET ${setParts.join(', ')} WHERE id = $1 AND workspace_id = $2`, values);
      return true;
    }
    const convs = load(CONV_FILE);
    save(CONV_FILE, convs.map((c) => (c.id === id && (c.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId ? { ...c, ...changes } : c)));
    return true;
  },

  /** Count messages by channel and direction for dashboard analytics. */
  async getMessageCountsByChannel(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();
    const empty = () => ({ sent: 0, replies: 0, delivered: 0, read: 0, failed: 0 });

    if (driver === 'postgres') {
      const result = await query(
        `SELECT channel, direction, COALESCE(status, 'sent') as status, COUNT(*) as count
         FROM messages WHERE workspace_id = $1
         GROUP BY channel, direction, COALESCE(status, 'sent')`,
        [workspaceId]
      );
      const counts = { email: empty(), whatsapp: empty(), sms: empty() };
      for (const row of result.rows) {
        const ch = row.channel || 'email';
        if (!counts[ch]) counts[ch] = empty();
        const n = parseInt(row.count, 10) || 0;
        if (row.direction === 'outbound') {
          counts[ch].sent += n;
          const st = String(row.status || 'sent').toLowerCase();
          if (st === 'delivered') counts[ch].delivered += n;
          else if (st === 'read') {
            counts[ch].delivered += n;
            counts[ch].read += n;
          } else if (st === 'failed' || st === 'undelivered') counts[ch].failed += n;
        } else if (row.direction === 'inbound') {
          counts[ch].replies += n;
        }
      }
      return counts;
    }

    const msgs = load(MSG_FILE);
    const counts = { email: empty(), whatsapp: empty(), sms: empty() };
    for (const m of msgs) {
      if ((m.workspaceId || DEFAULT_WORKSPACE_ID) !== workspaceId) continue;
      const ch = m.channel || 'email';
      if (!counts[ch]) counts[ch] = empty();
      if (m.direction === 'outbound') {
        counts[ch].sent++;
        const st = String(m.status || 'sent').toLowerCase();
        if (st === 'delivered') counts[ch].delivered++;
        else if (st === 'read') {
          counts[ch].delivered++;
          counts[ch].read++;
        } else if (st === 'failed' || st === 'undelivered') counts[ch].failed++;
      } else if (m.direction === 'inbound') {
        counts[ch].replies++;
      }
    }
    return counts;
  },
};

function snake(str) {
  return str.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

module.exports = conversationStorage;
