/**
 * Per-Gmail-account API gate with high/low priority.
 *
 * ALL Gmail HTTP calls must go through this module so quota is never consumed
 * by parallel inbox sync + campaign sends on the same account.
 *
 * High priority (campaign sends) runs before low priority (inbox sync).
 * Low-priority sync yields when a send is waiting.
 */

const fs = require('fs');
const path = require('path');
const integrationStorage = require('./integrationStorage');
const {
  isRateLimitError,
  computeBackoffUntil,
  logExternalApiError,
} = require('./externalApiErrors');

const COOLDOWN_STATE_PATH = path.join(__dirname, '..', 'data', 'gmail-queue-cooldown.json');
let cooldownStateCache = null;

function loadCooldownState() {
  if (cooldownStateCache) return cooldownStateCache;
  try {
    if (fs.existsSync(COOLDOWN_STATE_PATH)) {
      cooldownStateCache = JSON.parse(fs.readFileSync(COOLDOWN_STATE_PATH, 'utf8')) || {};
    } else {
      cooldownStateCache = {};
    }
  } catch {
    cooldownStateCache = {};
  }
  return cooldownStateCache;
}

function saveCooldownState() {
  try {
    const dir = path.dirname(COOLDOWN_STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(COOLDOWN_STATE_PATH, JSON.stringify(loadCooldownState(), null, 2));
  } catch (err) {
    console.warn('[GmailQueue] failed to persist cooldown state:', err.message);
  }
}

function getPersistedPausedUntil(accountKey) {
  const key = String(accountKey || 'default').toLowerCase();
  const state = loadCooldownState();
  const until = Number(state[key]?.pausedUntil || 0);
  return until > Date.now() ? until : 0;
}

function persistPausedUntil(accountKey, pausedUntil) {
  const key = String(accountKey || 'default').toLowerCase();
  const state = loadCooldownState();
  const existing = Number(state[key]?.pausedUntil || 0);
  const next = Math.max(existing, pausedUntil);
  if (next <= Date.now()) {
    if (state[key]) {
      delete state[key];
      saveCooldownState();
    }
    return;
  }
  state[key] = { pausedUntil: next, updatedAt: new Date().toISOString() };
  saveCooldownState();
}

const configuredDelay = parseInt(process.env.GMAIL_QUEUE_DELAY_MS, 10) || 300;
const QUEUE_DELAY_MS = Math.min(500, Math.max(200, configuredDelay));
const SEND_TIMEOUT_MS = parseInt(process.env.GMAIL_SEND_TIMEOUT_MS, 10) || 45000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logQueue(accountKey, message, extra = {}) {
  const suffix = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[GmailQueue:${accountKey}] ${message}${suffix}`);
}

function withTimeout(promise, ms, operation) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Gmail operation timed out after ${ms}ms (${operation || 'unknown'})`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

class AccountGmailQueue {
  constructor(accountKey) {
    this.accountKey = accountKey;
    this.highPending = [];
    this.lowPending = [];
    this.running = false;
    this.currentOperation = null;
    this.currentPriority = null;
    this.pausedUntil = getPersistedPausedUntil(accountKey);
    this.stats = { completed: 0, failed: 0, queued: 0, apiCalls: 0 };
    if (this.pausedUntil > Date.now()) {
      logQueue(this.accountKey, 'restored persisted cooldown', {
        pausedUntil: new Date(this.pausedUntil).toISOString(),
      });
    }
  }

  isPaused() {
    return Date.now() < this.pausedUntil;
  }

  getPausedUntil() {
    return this.pausedUntil;
  }

  hasHighPriorityWaiting() {
    return this.highPending.length > 0;
  }

  shouldYieldLowPriorityWork() {
    return this.hasHighPriorityWaiting();
  }

  flushLowPriorityPending(err) {
    while (this.lowPending.length > 0) {
      const job = this.lowPending.shift();
      logQueue(this.accountKey, 'background task cancelled during cooldown', {
        operation: job.operation,
      });
      job.reject(err);
    }
  }

  pauseUntil(err) {
    const requested = computeBackoffUntil(err, 120000);
    this.pausedUntil = Math.max(this.pausedUntil, requested);
    persistPausedUntil(this.accountKey, this.pausedUntil);
    this.flushLowPriorityPending(err);
    logExternalApiError(err, {
      accountKey: this.accountKey,
      action: 'gmail_queue_paused',
      pausedUntil: new Date(this.pausedUntil).toISOString(),
    });
    logQueue(this.accountKey, 'queue paused until retry window', {
      pausedUntil: new Date(this.pausedUntil).toISOString(),
      highPending: this.highPending.length,
      lowPending: this.lowPending.length,
    });
  }

  buildPausedError(operation) {
    const retryAfter = new Date(this.pausedUntil).toISOString();
    const err = new Error(`User-rate limit exceeded.  Retry after ${retryAfter}`);
    err.status = 429;
    err.code = 429;
    err.rateLimited = true;
    err.retryAfter = retryAfter;
    err.source = 'gmail_api';
    err.service = 'gmail_api';
    err.context = { operation, accountKey: this.accountKey, action: 'gmail_queue_paused' };
    return err;
  }

  async waitForResume(operation) {
    while (this.isPaused()) {
      const remaining = this.pausedUntil - Date.now();
      if (remaining <= 0) break;
      logQueue(this.accountKey, 'task waiting for rate-limit pause', {
        operation,
        pausedUntil: new Date(this.pausedUntil).toISOString(),
        highPending: this.highPending.length,
        lowPending: this.lowPending.length,
      });
      await sleep(Math.min(Math.max(remaining, 250), 5000));
    }
  }

  run(operation, fn, priority = 'high') {
    this.stats.queued += 1;
    const bucket = priority === 'low' ? this.lowPending : this.highPending;
    logQueue(this.accountKey, 'task queued', {
      operation,
      priority,
      highPending: this.highPending.length + (priority === 'high' ? 1 : 0),
      lowPending: this.lowPending.length + (priority === 'low' ? 1 : 0),
      queuedTotal: this.stats.queued,
    });

    return new Promise((resolve, reject) => {
      bucket.push({ operation, fn, resolve, reject, priority });
      this.drain();
    });
  }

  nextJob() {
    if (this.highPending.length > 0) return this.highPending.shift();
    if (this.lowPending.length > 0) return this.lowPending.shift();
    return null;
  }

  async drain() {
    if (this.running) return;

    while (this.highPending.length > 0 || this.lowPending.length > 0) {
      const job = this.nextJob();
      if (!job) break;

      this.running = true;
      this.currentOperation = job.operation;
      this.currentPriority = job.priority;
      logQueue(this.accountKey, 'task started', {
        operation: job.operation,
        priority: job.priority,
        highPending: this.highPending.length,
        lowPending: this.lowPending.length,
      });

      try {
        // Campaign sends must never block HTTP requests waiting for Google cooldown.
        if (job.priority === 'high' && this.isPaused()) {
          throw this.buildPausedError(job.operation);
        }
        if (job.priority === 'low') {
          await this.waitForResume(job.operation);
        }
        const result = await withTimeout(
          Promise.resolve().then(job.fn),
          SEND_TIMEOUT_MS,
          job.operation
        );
        this.stats.completed += 1;
        logQueue(this.accountKey, 'task completed', {
          operation: job.operation,
          priority: job.priority,
          highPending: this.highPending.length,
          lowPending: this.lowPending.length,
        });
        job.resolve(result);
        if (this.highPending.length > 0 || this.lowPending.length > 0) {
          await sleep(QUEUE_DELAY_MS);
        }
      } catch (err) {
        this.stats.failed += 1;
        if (isRateLimitError(err)) {
          this.pauseUntil(err);
        }
        logQueue(this.accountKey, 'task failed', {
          operation: job.operation,
          priority: job.priority,
          message: err?.message || String(err),
          highPending: this.highPending.length,
          lowPending: this.lowPending.length,
        });
        job.reject(err);
      } finally {
        this.running = false;
        this.currentOperation = null;
        this.currentPriority = null;
      }
    }
  }
}

const queues = new Map();
const workspaceAccountCache = new Map();

function resolveAccountKey(workspaceId) {
  const ws = String(workspaceId || 'default');
  if (workspaceAccountCache.has(ws)) {
    return workspaceAccountCache.get(ws);
  }
  const rec = integrationStorage.get(ws, 'email');
  const account = String(rec?.account || rec?.credentials?.email || ws).toLowerCase();
  workspaceAccountCache.set(ws, account);
  return account;
}

function invalidateWorkspaceAccountCache(workspaceId) {
  workspaceAccountCache.delete(String(workspaceId || 'default'));
}

function getAccountQueue(accountKey) {
  const key = String(accountKey || 'default').toLowerCase();
  if (!queues.has(key)) {
    queues.set(key, new AccountGmailQueue(key));
  }
  return queues.get(key);
}

function isBackgroundSuspended(workspaceId) {
  return getAccountQueue(resolveAccountKey(workspaceId)).isPaused();
}

function runGmailOperation(workspaceId, operation, fn, options = {}) {
  const priority = options.priority === 'low' ? 'low' : 'high';
  const accountKey = resolveAccountKey(workspaceId);
  const queue = getAccountQueue(accountKey);

  if (queue.isPaused()) {
    if (priority === 'low') {
      const until = new Date(queue.getPausedUntil()).toISOString();
      const err = new Error(`Gmail background operations suspended until ${until}`);
      err.code = 'GMAIL_BACKGROUND_SUSPENDED';
      err.suspended = true;
      err.retryAfter = until;
      return Promise.reject(err);
    }
    return Promise.reject(queue.buildPausedError(operation));
  }

  return queue.run(operation, fn, priority);
}

function shouldYieldInboxSync(workspaceId) {
  const queue = getAccountQueue(resolveAccountKey(workspaceId));
  return queue.shouldYieldLowPriorityWork();
}

function logGmailApiCall(workspaceId, endpoint, extra = {}) {
  const accountKey = resolveAccountKey(workspaceId);
  const queue = getAccountQueue(accountKey);
  queue.stats.apiCalls += 1;
  console.log('[GmailAPI] call', JSON.stringify({
    endpoint,
    accountKey,
    apiCallNumber: queue.stats.apiCalls,
    ...extra,
  }));
}

function isPaused(workspaceId) {
  return getAccountQueue(resolveAccountKey(workspaceId)).isPaused();
}

function isAnyPaused() {
  for (const queue of queues.values()) {
    if (queue.isPaused()) return true;
  }
  return false;
}

function getPausedUntil(workspaceId) {
  return getAccountQueue(resolveAccountKey(workspaceId)).getPausedUntil();
}

function pauseAccount(workspaceId, err) {
  if (!isRateLimitError(err)) return false;
  getAccountQueue(resolveAccountKey(workspaceId)).pauseUntil(err);
  return true;
}

function isSendQueueBusy(workspaceId) {
  const queue = getAccountQueue(resolveAccountKey(workspaceId));
  return queue.running || queue.highPending.length > 0;
}

function isGmailApiBusy(workspaceId) {
  const queue = getAccountQueue(resolveAccountKey(workspaceId));
  return queue.running || queue.highPending.length > 0 || queue.lowPending.length > 0;
}

function getQueueStats(workspaceId) {
  const accountKey = resolveAccountKey(workspaceId);
  const queue = getAccountQueue(accountKey);
  return {
    accountKey,
    pausedUntil: queue.pausedUntil,
    isPaused: queue.isPaused(),
    pending: queue.highPending.length + queue.lowPending.length,
    highPending: queue.highPending.length,
    lowPending: queue.lowPending.length,
    running: queue.running,
    currentOperation: queue.currentOperation,
    currentPriority: queue.currentPriority,
    queued: queue.stats.queued,
    completed: queue.stats.completed,
    failed: queue.stats.failed,
    apiCalls: queue.stats.apiCalls,
    delayMs: QUEUE_DELAY_MS,
    sendTimeoutMs: SEND_TIMEOUT_MS,
  };
}

module.exports = {
  runGmailOperation,
  resolveAccountKey,
  shouldYieldInboxSync,
  logGmailApiCall,
  isPaused,
  isAnyPaused,
  isBackgroundSuspended,
  getPausedUntil,
  pauseAccount,
  isSendQueueBusy,
  isGmailApiBusy,
  getQueueStats,
  invalidateWorkspaceAccountCache,
  QUEUE_DELAY_MS,
  SEND_TIMEOUT_MS,
};
