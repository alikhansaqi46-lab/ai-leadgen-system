/**
 * WhatsApp Test Mode Storage (S6.5).
 *
 * Stores user's test WhatsApp number and tracks test message usage.
 * Limit: 10 test messages per workspace. Test messages are tracked
 * separately from live campaign messages.
 *
 * Record: { workspaceId, testNumber, messagesUsed, messagesLimit, active, createdAt, updatedAt }
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const fs = require('fs');
const path = require('path');

const TEST_MODE_FILE = path.join(__dirname, '..', 'data', 'testMode.json');
const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || 'default';
const DEFAULT_LIMIT = 10;

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
    console.error(`[TestModeStorage] Failed to load ${path.basename(file)}:`, err.message);
    return [];
  }
}

function save(file, rows) {
  ensureDir(file);
  try {
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(`[TestModeStorage] Failed to save ${path.basename(file)}:`, err.message);
  }
}

function now() { return new Date().toISOString(); }

const testModeStorage = {
  /** Get or create test mode record for a workspace. */
  async get(workspaceId = DEFAULT_WORKSPACE_ID) {
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `SELECT id, workspace_id, test_number, messages_used, messages_limit, active, created_at, updated_at
         FROM test_mode WHERE workspace_id = $1`,
        [workspaceId]
      );
      if (result.rows.length > 0) {
        const r = result.rows[0];
        return { id: r.id, workspaceId: r.workspace_id, testNumber: r.test_number, messagesUsed: r.messages_used, messagesLimit: r.messages_limit, active: r.active, createdAt: r.created_at, updatedAt: r.updated_at };
      }
      return this._createDefault(workspaceId, driver);
    }

    let rows;    const existing = rows.find((r) => (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId);
    if (existing) return existing;
    return this._createDefault(workspaceId, driver);
  },

  async _createDefault(workspaceId, driver) {
    const record = {
      id: uuidv4(),
      workspaceId,
      testNumber: null,
      messagesUsed: 0,
      messagesLimit: DEFAULT_LIMIT,
      active: false,
      createdAt: now(),
      updatedAt: now(),
    };

    if (driver === 'postgres') {
      await query(
        `INSERT INTO test_mode (id, workspace_id, test_number, messages_used, messages_limit, active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [record.id, workspaceId, record.testNumber, record.messagesUsed, record.messagesLimit, record.active, record.createdAt, record.updatedAt]
      );
      return record;
    }    const all = load(TEST_MODE_FILE);
    save(TEST_MODE_FILE, [record, ...all]);
    return record;
  },

  /** Set test WhatsApp number and activate test mode. */
  async setNumber(workspaceId, testNumber) {
    const record = await this.get(workspaceId);
    const updates = { testNumber, active: true, updatedAt: now() };
    return this._update(workspaceId, updates);
  },

  /** Increment test message count. Returns { ok: boolean, remaining: number }. */
  async useMessage(workspaceId) {
    const record = await this.get(workspaceId);
    if (!record.active || !record.testNumber) return { ok: false, remaining: 0, error: 'Test mode not active' };
    if (record.messagesUsed >= record.messagesLimit) return { ok: false, remaining: 0, error: 'Test limit reached' };

    const newUsed = record.messagesUsed + 1;
    await this._update(workspaceId, { messagesUsed: newUsed, updatedAt: now() });
    return { ok: true, remaining: record.messagesLimit - newUsed };
  },

  /** Reset test message counter (for new test sessions). */
  async resetCounter(workspaceId) {
    return this._update(workspaceId, { messagesUsed: 0, updatedAt: now() });
  },

  /** Deactivate test mode. */
  async deactivate(workspaceId) {
    return this._update(workspaceId, { active: false, updatedAt: now() });
  },

  async _update(workspaceId, updates) {
    const driver = resolveDriver();
    const setClause = Object.keys(updates).map((k, i) => `${snake(k)} = $${i + 2}`).join(', ');
    const values = Object.values(updates);

    if (driver === 'postgres') {
      await query(`UPDATE test_mode SET ${setClause} WHERE workspace_id = $1`, [workspaceId, ...values]);
    } else    return { ...(await this.get(workspaceId)), ...updates };
  },
};

function snake(str) {
  return str.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

module.exports = testModeStorage;
