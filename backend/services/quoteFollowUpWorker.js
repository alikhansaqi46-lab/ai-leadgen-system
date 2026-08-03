/**
 * Quote follow-up worker — sends AI follow-ups when customers don't respond to quotes/invoices.
 *
 * Enabled when QUOTE_FOLLOWUP_WORKER_ENABLED is unset or "true".
 * Interval: QUOTE_FOLLOWUP_WORKER_INTERVAL_MS (default 120000).
 * Delay: QUOTE_FOLLOWUP_HOURS (default 36).
 */

const quoteStorage = require('../utils/quoteStorage');
const quoteService = require('./quoteService');
const userStorage = require('../utils/userStorage');

let timer = null;
let running = false;

async function listWorkspaceIds() {
  const env = process.env.DEFAULT_WORKSPACE_ID || 'default';
  try {
    const users = await userStorage.listAll?.();
    if (Array.isArray(users) && users.length) {
      const ids = [...new Set(users.map((u) => u.workspaceId || u.workspace_id || env))];
      return ids.length ? ids : [env];
    }
  } catch (_) { /* ignore */ }
  return [env];
}

async function processWorkspace(workspaceId) {
  const due = await quoteStorage.listDueQuoteFollowUps(workspaceId);
  if (!due.length) return { workspaceId, processed: 0 };

  let sent = 0;
  for (const doc of due) {
    try {
      await quoteService.processQuoteFollowUp(doc, workspaceId);
      sent += 1;
    } catch (err) {
      console.warn(`[QuoteFollowUpWorker] ${doc.id}:`, err.message);
    }
  }
  return { workspaceId, processed: due.length, sent };
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const workspaces = await listWorkspaceIds();
    for (const ws of workspaces) {
      const result = await processWorkspace(ws);
      if (result.sent > 0) {
        console.log(`[QuoteFollowUpWorker] workspace=${ws} sent=${result.sent}`);
      }
    }
  } catch (err) {
    console.error('[QuoteFollowUpWorker] tick error:', err.message);
  } finally {
    running = false;
  }
}

function startQuoteFollowUpWorker() {
  const enabled = String(process.env.QUOTE_FOLLOWUP_WORKER_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return;
  const ms = Math.max(60000, Number(process.env.QUOTE_FOLLOWUP_WORKER_INTERVAL_MS || 120000));
  if (timer) clearInterval(timer);
  timer = setInterval(tick, ms);
  setTimeout(tick, 15000);
  console.log(`[QuoteFollowUpWorker] started (interval ${ms}ms)`);
}

module.exports = { startQuoteFollowUpWorker, tick };
