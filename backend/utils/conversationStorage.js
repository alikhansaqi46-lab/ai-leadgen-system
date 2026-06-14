/**
 * Conversation + message storage (S5.3 — Inbox foundation).
 *
 * Threads two-way outreach with a lead. A conversation groups messages for one
 * (lead, channel); a message is a single outbound/inbound entry. This is the
 * data foundation the Inbox renders on — live WhatsApp/email send + inbound
 * webhooks are wired on top later. V1 records messages (a log); approving a
 * draft and moving it to the Inbox is the only way an outbound message is created.
 *
 * Same pluggable driver dispatch as the other seams (STORAGE_DRIVER). Every
 * method is workspace-scoped.
 *
 * Conversation: { id, leadId, workspaceId, channel, status, subject,
 *                 lastMessageAt, createdAt, updatedAt }
 * Message:      { id, conversationId, workspaceId, direction, channel, body,
 *                 source, draftId, createdAt }
 */

const { v4: uuidv4 } = require('uuid');
const { db } = require('../config/firebase');
const { query } = require('../config/db');
const fs = require('fs');
const path = require('path');

const CONV_FILE = path.join(__dirname, '..', 'data', 'conversations.json');
const MSG_FILE = path.join(__dirname, '..', 'data', 'messages.json');
const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || 'default';

function resolveDriver() {
  const d = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  if (d === 'postgres' || d === 'pg') return 'postgres';
  if (d === 'firestore') return 'firestore';
  if (d === 'json' || d === 'file') return 'json';
  return db ? 'firestore' : 'json';
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
    createdAt: r.created_at,
  };
}

/* ---------- API ---------- */

const conversationStorage = {
  /** List conversations for a workspace (newest activity first). */
  async getConversations(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `SELECT id, lead_id, channel, status, subject, last_message_at, created_at, updated_at
         FROM conversations WHERE workspace_id = $1
         ORDER BY last_message_at DESC NULLS LAST, created_at DESC`,
        [workspaceId]
      );
      return result.rows.map((r) => convFromPg(r, workspaceId));
    }

    let rows;
    if (driver === 'firestore') {
      try {
        const snap = await db.collection('conversations').where('workspaceId', '==', workspaceId).get();
        rows = snap.docs.map((d) => d.data());
      } catch (err) {
        console.error('[ConversationStorage] Firestore get failed, falling back to file:', err.message);
        rows = load(CONV_FILE);
      }
    } else {
      rows = load(CONV_FILE);
    }

    return rows
      .filter((r) => (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId)
      .sort((a, b) => String(b.lastMessageAt || b.createdAt).localeCompare(String(a.lastMessageAt || a.createdAt)));
  },

  /** Fetch one conversation (workspace-scoped) or null. */
  async getConversation(id, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const all = await this.getConversations({ workspaceId });
    return all.find((c) => c.id === id) || null;
  },

  /** Find an existing open conversation for a (lead, channel), or null. */
  async findConversation({ workspaceId, leadId, channel }) {
    const ws = workspaceId || DEFAULT_WORKSPACE_ID;
    const all = await this.getConversations({ workspaceId: ws });
    return all.find((c) => c.leadId === leadId && c.channel === channel && c.status !== 'closed') || null;
  },

  /** Create a conversation. Returns the created row. */
  async createConversation(data, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const now = new Date().toISOString();
    const row = {
      id: uuidv4(),
      leadId: data.leadId,
      workspaceId,
      channel: data.channel,
      status: data.status || 'open',
      subject: data.subject || null,
      lastMessageAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const driver = resolveDriver();

    if (driver === 'postgres') {
      await query(
        `INSERT INTO conversations
           (id, lead_id, workspace_id, channel, status, subject, last_message_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [row.id, row.leadId, workspaceId, row.channel, row.status, row.subject, row.lastMessageAt, row.createdAt, row.updatedAt]
      );
      return row;
    }

    if (driver === 'firestore') {
      try {
        await db.collection('conversations').doc(row.id).set(row);
        return row;
      } catch (err) {
        console.error('[ConversationStorage] Firestore create failed, falling back to file:', err.message);
      }
    }

    const all = load(CONV_FILE);
    save(CONV_FILE, [row, ...all]);
    return row;
  },

  /** List messages in a conversation (oldest first), workspace-scoped. */
  async getMessages(conversationId, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    // Guard: only return messages if the conversation belongs to this workspace.
    const conv = await this.getConversation(conversationId, { workspaceId });
    if (!conv) return [];

    if (driver === 'postgres') {
      const result = await query(
        `SELECT id, conversation_id, direction, channel, body, source, draft_id, created_at
         FROM messages WHERE workspace_id = $1 AND conversation_id = $2
         ORDER BY created_at ASC`,
        [workspaceId, conversationId]
      );
      return result.rows.map((r) => msgFromPg(r, workspaceId));
    }

    let rows;
    if (driver === 'firestore') {
      try {
        const snap = await db
          .collection('messages')
          .where('workspaceId', '==', workspaceId)
          .where('conversationId', '==', conversationId)
          .get();
        rows = snap.docs.map((d) => d.data());
      } catch (err) {
        console.error('[ConversationStorage] Firestore messages get failed, falling back to file:', err.message);
        rows = load(MSG_FILE);
      }
    } else {
      rows = load(MSG_FILE);
    }

    return rows
      .filter((r) => (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && r.conversationId === conversationId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  },

  /**
   * Append a message to a conversation and bump its lastMessageAt.
   * Returns the created message, or null if the conversation isn't in this workspace.
   */
  async addMessage(conversationId, data, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const conv = await this.getConversation(conversationId, { workspaceId });
    if (!conv) return null;

    const now = new Date().toISOString();
    const row = {
      id: uuidv4(),
      conversationId,
      workspaceId,
      direction: data.direction || 'outbound',
      channel: data.channel || conv.channel,
      body: data.body,
      source: data.source || 'manual',
      draftId: data.draftId || null,
      createdAt: now,
    };
    const driver = resolveDriver();

    if (driver === 'postgres') {
      await query(
        `INSERT INTO messages
           (id, conversation_id, workspace_id, direction, channel, body, source, draft_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [row.id, conversationId, workspaceId, row.direction, row.channel, row.body, row.source, row.draftId, row.createdAt]
      );
      await query(`UPDATE conversations SET last_message_at = $1, updated_at = $1 WHERE id = $2 AND workspace_id = $3`,
        [now, conversationId, workspaceId]);
      return row;
    }

    if (driver === 'firestore') {
      try {
        await db.collection('messages').doc(row.id).set(row);
        await db.collection('conversations').doc(conversationId).set(
          { lastMessageAt: now, updatedAt: now }, { merge: true }
        );
        return row;
      } catch (err) {
        console.error('[ConversationStorage] Firestore addMessage failed, falling back to file:', err.message);
      }
    }

    const msgs = load(MSG_FILE);
    save(MSG_FILE, [...msgs, row]);
    const convs = load(CONV_FILE);
    save(CONV_FILE, convs.map((c) => (c.id === conversationId ? { ...c, lastMessageAt: now, updatedAt: now } : c)));
    return row;
  },
};

module.exports = conversationStorage;
