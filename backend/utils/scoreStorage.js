/**
 * Lead-score storage (S5.1).
 *
 * Stores AI qualification scores, one row per (workspace, lead), upserted on
 * re-qualify. Uses the SAME pluggable driver dispatch as leadStorage.js
 * (selected by STORAGE_DRIVER): 'postgres' | 'firestore' | 'json' | 'auto'.
 *
 * Every method is workspace-scoped so scores honor the S2 isolation model and
 * are ready for Supabase activation without changes.
 */

const { db } = require('../config/firebase');
const { query } = require('../config/db');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'scores.json');
const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || 'default';

/* ==================== DRIVER SELECTION ==================== */

function resolveDriver() {
  const d = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  if (d === 'postgres' || d === 'pg') return 'postgres';
  if (d === 'firestore') return 'firestore';
  if (d === 'json' || d === 'file') return 'json';
  // 'auto' (default): preserve legacy behavior exactly (Firestore if configured, else JSON).
  return db ? 'firestore' : 'json';
}

/* ==================== FILE HELPERS ==================== */

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
    console.error('[ScoreStorage] Failed to load scores file:', err.message);
    return [];
  }
}

function saveToFile(rows) {
  ensureDataDir();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error('[ScoreStorage] Failed to save scores file:', err.message);
  }
}

function normalize(row, workspaceId) {
  return {
    leadId: row.leadId,
    workspaceId,
    score: row.score,
    priority: row.priority,
    breakdown: row.breakdown || null,
    model: row.model || null,
    createdAt: row.createdAt || new Date().toISOString(),
  };
}

/* ==================== UNIFIED API ==================== */

const scoreStorage = {
  /** Return all scores for a workspace (newest first). */
  async getScores(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      const result = await query(
        `SELECT lead_id, score, priority, breakdown, model, created_at
         FROM lead_scores WHERE workspace_id = $1 ORDER BY score DESC`,
        [workspaceId]
      );
      return result.rows.map((r) => ({
        leadId: r.lead_id,
        workspaceId,
        score: r.score,
        priority: r.priority,
        breakdown: r.breakdown,
        model: r.model,
        createdAt: r.created_at,
      }));
    }

    if (driver === 'firestore') {
      try {
        const snap = await db
          .collection('lead_scores')
          .where('workspaceId', '==', workspaceId)
          .get();
        return snap.docs.map((d) => d.data());
      } catch (err) {
        console.error('[ScoreStorage] Firestore get failed, falling back to file:', err.message);
      }
    }

    return loadFromFile().filter(
      (r) => (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId
    );
  },

  /**
   * Upsert scores for a workspace (one row per lead). `scores` is an array of
   * { leadId, score, priority, breakdown, model, createdAt? }.
   * Returns the stored rows.
   */
  async upsertScores(scores, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const rows = scores.map((s) => normalize(s, workspaceId));
    if (rows.length === 0) return [];
    const driver = resolveDriver();

    if (driver === 'postgres') {
      for (const r of rows) {
        await query(
          `INSERT INTO lead_scores (lead_id, workspace_id, score, priority, breakdown, model, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (workspace_id, lead_id)
           DO UPDATE SET score = EXCLUDED.score, priority = EXCLUDED.priority,
                         breakdown = EXCLUDED.breakdown, model = EXCLUDED.model,
                         created_at = EXCLUDED.created_at`,
          [r.leadId, workspaceId, r.score, r.priority, JSON.stringify(r.breakdown), r.model, r.createdAt]
        );
      }
      return rows;
    }

    if (driver === 'firestore') {
      try {
        const batch = db.batch();
        for (const r of rows) {
          // Deterministic doc id enforces one-score-per-(workspace,lead).
          const ref = db.collection('lead_scores').doc(`${workspaceId}__${r.leadId}`);
          batch.set(ref, r);
        }
        await batch.commit();
        return rows;
      } catch (err) {
        console.error('[ScoreStorage] Firestore upsert failed, falling back to file:', err.message);
      }
    }

    // File driver: replace this workspace's rows for the given leads, keep others intact.
    const all = loadFromFile();
    const incomingLeadIds = new Set(rows.map((r) => r.leadId));
    const kept = all.filter(
      (r) =>
        !(
          (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId &&
          incomingLeadIds.has(r.leadId)
        )
    );
    saveToFile([...rows, ...kept]);
    return rows;
  },

  /** Delete scores by lead ids within a workspace (used for cleanup/tests). */
  async deleteScores(leadIds, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const ids = Array.isArray(leadIds) ? leadIds : [leadIds];
    if (ids.length === 0) return;
    const driver = resolveDriver();

    if (driver === 'postgres') {
      await query(
        `DELETE FROM lead_scores WHERE workspace_id = $1 AND lead_id = ANY($2)`,
        [workspaceId, ids]
      );
      return;
    }

    if (driver === 'firestore') {
      try {
        const batch = db.batch();
        for (const id of ids) {
          batch.delete(db.collection('lead_scores').doc(`${workspaceId}__${id}`));
        }
        await batch.commit();
        return;
      } catch (err) {
        console.error('[ScoreStorage] Firestore delete failed, falling back to file:', err.message);
      }
    }

    const all = loadFromFile();
    const idSet = new Set(ids);
    const filtered = all.filter(
      (r) =>
        !(
          (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId && idSet.has(r.leadId)
        )
    );
    saveToFile(filtered);
  },
};

module.exports = scoreStorage;
