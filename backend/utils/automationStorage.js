/**
 * Automation Engine storage — workspace-scoped automations, runs, logs.
 * Drivers: postgres | json (same pattern as other *Storage modules).
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUTOMATIONS_FILE = path.join(DATA_DIR, 'automations.json');
const RUNS_FILE = path.join(DATA_DIR, 'automation_runs.json');
const LOGS_FILE = path.join(DATA_DIR, 'automation_run_logs.json');
const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || 'default';

let forceJsonFallback = String(process.env.AUTOMATION_JSON_FALLBACK || '').toLowerCase() === 'true';

function resolveDriver() {
  if (forceJsonFallback) return 'json';
  const d = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  if (d === 'postgres' || d === 'pg') return 'postgres';
  if (d === 'json' || d === 'file') return 'json';
  return process.env.DATABASE_URL ? 'postgres' : 'json';
}

function enableJsonFallback(err) {
  const msg = err && err.message ? err.message : String(err || '');
  if (/certificate|self-signed|ECONNREFUSED|ENOTFOUND|does not exist|relation .* does not exist/i.test(msg)) {
    if (!forceJsonFallback) {
      console.warn('[AutomationStorage] Falling back to JSON file storage:', msg);
      forceJsonFallback = true;
    }
    return true;
  }
  return false;
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
  } catch {
    return [];
  }
}

function save(file, rows) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
}

function now() {
  return new Date().toISOString();
}

function mapAutomation(r) {
  return {
    id: r.id,
    workspaceId: r.workspace_id || r.workspaceId,
    name: r.name,
    description: r.description || '',
    enabled: r.enabled === true || r.enabled === 't',
    triggerType: r.trigger_type || r.triggerType,
    triggerConfig: typeof r.trigger_config === 'string' ? JSON.parse(r.trigger_config) : (r.triggerConfig || r.trigger_config || {}),
    conditions: typeof r.conditions === 'string' ? JSON.parse(r.conditions) : (r.conditions || []),
    actions: typeof r.actions === 'string' ? JSON.parse(r.actions) : (r.actions || []),
    color: r.color || null,
    createdAt: r.created_at || r.createdAt,
    updatedAt: r.updated_at || r.updatedAt,
  };
}

function mapRun(r) {
  return {
    id: r.id,
    automationId: r.automation_id || r.automationId,
    workspaceId: r.workspace_id || r.workspaceId,
    status: r.status,
    triggerType: r.trigger_type || r.triggerType,
    context: typeof r.context === 'string' ? JSON.parse(r.context) : (r.context || {}),
    error: r.error || null,
    startedAt: r.started_at || r.startedAt || null,
    finishedAt: r.finished_at || r.finishedAt || null,
    createdAt: r.created_at || r.createdAt,
  };
}

function mapLog(r) {
  return {
    id: r.id,
    runId: r.run_id || r.runId,
    workspaceId: r.workspace_id || r.workspaceId,
    stepIndex: r.step_index ?? r.stepIndex ?? 0,
    stepType: r.step_type || r.stepType || null,
    message: r.message,
    level: r.level || 'info',
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload || {}),
    createdAt: r.created_at || r.createdAt,
  };
}

const automationStorage = {
  async list(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (resolveDriver() === 'postgres') {
      try {
        const { rows } = await query(
          `SELECT * FROM automations WHERE workspace_id = $1 ORDER BY updated_at DESC`,
          [workspaceId]
        );
        return rows.map(mapAutomation);
      } catch (err) {
        if (!enableJsonFallback(err)) throw err;
      }
    }
    return load(AUTOMATIONS_FILE)
      .filter((a) => (a.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId)
      .map(mapAutomation)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  },

  async getById(id, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (resolveDriver() === 'postgres') {
      const { rows } = await query(
        `SELECT * FROM automations WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId]
      );
      return rows[0] ? mapAutomation(rows[0]) : null;
    }
    const row = load(AUTOMATIONS_FILE).find(
      (a) => a.id === id && (a.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId
    );
    return row ? mapAutomation(row) : null;
  },

  async listEnabledByTrigger(triggerType, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const all = await this.list({ workspaceId });
    return all.filter((a) => a.enabled && a.triggerType === triggerType);
  },

  async create(data, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const row = {
      id: data.id || uuidv4(),
      workspaceId,
      name: data.name,
      description: data.description || '',
      enabled: !!data.enabled,
      triggerType: data.triggerType || 'manual',
      triggerConfig: data.triggerConfig || {},
      conditions: data.conditions || [],
      actions: data.actions || [],
      color: data.color || '#6366f1',
      createdAt: now(),
      updatedAt: now(),
    };

    if (resolveDriver() === 'postgres') {
      try {
        await query(
          `INSERT INTO automations
            (id, workspace_id, name, description, enabled, trigger_type, trigger_config, conditions, actions, color, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            row.id, workspaceId, row.name, row.description, row.enabled, row.triggerType,
            JSON.stringify(row.triggerConfig), JSON.stringify(row.conditions), JSON.stringify(row.actions),
            row.color, row.createdAt, row.updatedAt,
          ]
        );
        return row;
      } catch (err) {
        if (!enableJsonFallback(err)) throw err;
      }
    }

    const all = load(AUTOMATIONS_FILE);
    all.unshift(row);
    save(AUTOMATIONS_FILE, all);
    return row;
  },

  async update(id, patch, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const existing = await this.getById(id, { workspaceId });
    if (!existing) return null;
    const next = {
      ...existing,
      ...patch,
      id: existing.id,
      workspaceId,
      updatedAt: now(),
    };

    if (resolveDriver() === 'postgres') {
      await query(
        `UPDATE automations SET
           name=$1, description=$2, enabled=$3, trigger_type=$4, trigger_config=$5,
           conditions=$6, actions=$7, color=$8, updated_at=$9
         WHERE id=$10 AND workspace_id=$11`,
        [
          next.name, next.description, !!next.enabled, next.triggerType,
          JSON.stringify(next.triggerConfig || {}), JSON.stringify(next.conditions || []),
          JSON.stringify(next.actions || []), next.color, next.updatedAt, id, workspaceId,
        ]
      );
      return next;
    }

    const all = load(AUTOMATIONS_FILE).map((a) =>
      a.id === id && (a.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId ? next : a
    );
    save(AUTOMATIONS_FILE, all);
    return next;
  },

  async remove(id, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (resolveDriver() === 'postgres') {
      const { rowCount } = await query(
        `DELETE FROM automations WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId]
      );
      return rowCount > 0;
    }
    const all = load(AUTOMATIONS_FILE);
    const next = all.filter(
      (a) => !(a.id === id && (a.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId)
    );
    if (next.length === all.length) return false;
    save(AUTOMATIONS_FILE, next);
    return true;
  },

  async createRun({ automationId, triggerType, context }, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const row = {
      id: uuidv4(),
      automationId,
      workspaceId,
      status: 'pending',
      triggerType: triggerType || null,
      context: context || {},
      error: null,
      startedAt: null,
      finishedAt: null,
      createdAt: now(),
    };

    if (resolveDriver() === 'postgres') {
      await query(
        `INSERT INTO automation_runs
          (id, automation_id, workspace_id, status, trigger_type, context, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [row.id, row.automationId, workspaceId, row.status, row.triggerType, JSON.stringify(row.context), row.createdAt]
      );
      return row;
    }

    const all = load(RUNS_FILE);
    all.unshift(row);
    save(RUNS_FILE, all.slice(0, 2000));
    return row;
  },

  async updateRun(id, patch, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    if (resolveDriver() === 'postgres') {
      const fields = [];
      const params = [];
      const map = {
        status: 'status',
        error: 'error',
        startedAt: 'started_at',
        finishedAt: 'finished_at',
        context: 'context',
      };
      for (const [k, col] of Object.entries(map)) {
        if (patch[k] !== undefined) {
          params.push(k === 'context' ? JSON.stringify(patch[k]) : patch[k]);
          fields.push(`${col} = $${params.length}`);
        }
      }
      if (!fields.length) return null;
      params.push(id, workspaceId);
      await query(
        `UPDATE automation_runs SET ${fields.join(', ')} WHERE id = $${params.length - 1} AND workspace_id = $${params.length}`,
        params
      );
      const { rows } = await query(`SELECT * FROM automation_runs WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
      return rows[0] ? mapRun(rows[0]) : null;
    }

    let updated = null;
    const all = load(RUNS_FILE).map((r) => {
      if (r.id === id && (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId) {
        updated = { ...r, ...patch };
        return updated;
      }
      return r;
    });
    if (updated) save(RUNS_FILE, all);
    return updated;
  },

  async listRuns(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const limit = Math.min(parseInt(options.limit || '50', 10), 200);
    if (resolveDriver() === 'postgres') {
      try {
        const { rows } = await query(
          `SELECT * FROM automation_runs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2`,
          [workspaceId, limit]
        );
        return rows.map(mapRun);
      } catch (err) {
        if (!enableJsonFallback(err)) throw err;
      }
    }
    return load(RUNS_FILE)
      .filter((r) => (r.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId)
      .slice(0, limit)
      .map(mapRun);
  },

  /**
   * Failed runs that are due for retry (context.nextRetryAt <= now, attempt < max).
   * Scans recent runs across known workspaces when workspaceId omitted.
   */
  async listRetryableRuns(options = {}) {
    const workspaceId = options.workspaceId || null;
    const limit = Math.min(parseInt(options.limit || '50', 10), 200);
    const now = Date.now();
    const all = await this.listRuns({
      workspaceId: workspaceId || DEFAULT_WORKSPACE_ID,
      limit: 500,
    });
    return all
      .filter((r) => {
        if (r.status !== 'failed') return false;
        const ctx = r.context || {};
        if (ctx.retryExhausted) return false;
        if (ctx.retryClaimedAt) return false; // already claimed — do not re-queue
        const attempt = Number(ctx.retryAttempt || 0);
        const maxRetries = Number(ctx.maxRetries ?? 3);
        if (attempt >= maxRetries) return false;
        const next = ctx.nextRetryAt ? Date.parse(ctx.nextRetryAt) : 0;
        // Require an explicit nextRetryAt (never treat missing as immediately due)
        return Number.isFinite(next) && next > 0 && next <= now;
      })
      .slice(0, limit);
  },

  /** Runs paused on delay whose resumeAt is due. */
  async listWaitingRuns(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const limit = Math.min(parseInt(options.limit || '50', 10), 200);
    const now = Date.now();
    const all = await this.listRuns({ workspaceId, limit: 500 });
    return all
      .filter((r) => {
        if (r.status !== 'waiting') return false;
        const ctx = r.context || {};
        if (ctx.delayClaimedAt) return false;
        const resumeAt = ctx.resumeAt ? Date.parse(ctx.resumeAt) : 0;
        return resumeAt && resumeAt <= now;
      })
      .slice(0, limit);
  },

  async addLog({ runId, stepIndex, stepType, message, level, payload }, options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const row = {
      id: uuidv4(),
      runId,
      workspaceId,
      stepIndex: stepIndex || 0,
      stepType: stepType || null,
      message,
      level: level || 'info',
      payload: payload || {},
      createdAt: now(),
    };

    if (resolveDriver() === 'postgres') {
      await query(
        `INSERT INTO automation_run_logs
          (id, run_id, workspace_id, step_index, step_type, message, level, payload, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [row.id, row.runId, workspaceId, row.stepIndex, row.stepType, row.message, row.level, JSON.stringify(row.payload), row.createdAt]
      );
      return row;
    }

    const all = load(LOGS_FILE);
    all.unshift(row);
    save(LOGS_FILE, all.slice(0, 5000));
    return row;
  },

  async listLogs(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const limit = Math.min(parseInt(options.limit || '100', 10), 500);
    const runId = options.runId;
    if (resolveDriver() === 'postgres') {
      if (runId) {
        const { rows } = await query(
          `SELECT * FROM automation_run_logs WHERE workspace_id = $1 AND run_id = $2 ORDER BY created_at ASC LIMIT $3`,
          [workspaceId, runId, limit]
        );
        return rows.map(mapLog);
      }
      const { rows } = await query(
        `SELECT * FROM automation_run_logs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [workspaceId, limit]
      );
      return rows.map(mapLog);
    }
    let rows = load(LOGS_FILE).filter((l) => (l.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId);
    if (runId) rows = rows.filter((l) => l.runId === runId).reverse();
    return rows.slice(0, limit).map(mapLog);
  },

  async getStats(options = {}) {
    const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
    const automations = await this.list({ workspaceId });
    const runs = await this.listRuns({ workspaceId, limit: 500 });
    return {
      totalAutomations: automations.length,
      enabledAutomations: automations.filter((a) => a.enabled).length,
      runsTotal: runs.length,
      runsRunning: runs.filter((r) => r.status === 'running' || r.status === 'pending').length,
      runsSucceeded: runs.filter((r) => r.status === 'succeeded').length,
      runsFailed: runs.filter((r) => r.status === 'failed').length,
    };
  },
};

module.exports = automationStorage;
