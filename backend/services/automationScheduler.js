/**
 * Automation schedule + retry worker.
 *
 * 1) Runs enabled automations with trigger_type=schedule.
 * 2) Retries failed runs with exponential backoff (from run.context.nextRetryAt).
 */

const automationStorage = require('../utils/automationStorage');
const { runAutomation } = require('./automationEngine');
const integrationStorage = require('../utils/integrationStorage');

const { isTlsTrustError } = require('../config/tls');

let timer = null;
let running = false;
let lastTlsWarnAt = 0;
const TLS_WARN_COOLDOWN_MS = 5 * 60 * 1000;

function logTickError(err) {
  if (isTlsTrustError(err)) {
    const now = Date.now();
    if (now - lastTlsWarnAt < TLS_WARN_COOLDOWN_MS) return;
    lastTlsWarnAt = now;
    console.error(
      '[AutomationScheduler] Postgres TLS trust failed (throttled). '
      + 'Set TLS_CA_FILE or NODE_EXTRA_CA_CERTS to your corporate/root CA PEM. Detail:',
      err.message
    );
    return;
  }
  console.error('[AutomationScheduler] tick error:', err.message);
}

function intervalMsFor(auto) {
  const cfg = auto.triggerConfig || {};
  const mins = parseInt(cfg.everyMinutes || cfg.intervalMinutes || 0, 10);
  if (mins > 0) return Math.max(mins, 1) * 60 * 1000;
  if (String(cfg.cronHint || '').toLowerCase() === 'hourly') return 60 * 60 * 1000;
  if (String(cfg.cronHint || '').toLowerCase() === 'daily') return 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

function discoverWorkspaces() {
  const workspaces = new Set();
  try {
    (integrationStorage.listAllWorkspaces?.() || []).forEach((w) => workspaces.add(w));
  } catch (_) { /* ignore */ }
  workspaces.add(process.env.DEFAULT_WORKSPACE_ID || 'default');
  return workspaces;
}

async function processScheduled() {
  for (const workspaceId of discoverWorkspaces()) {
    const scheduled = await automationStorage.listEnabledByTrigger('schedule', { workspaceId });
    const now = Date.now();
    for (const auto of scheduled) {
      const every = intervalMsFor(auto);
      const last = auto.triggerConfig?.lastRunAt ? Date.parse(auto.triggerConfig.lastRunAt) : 0;
      if (last && now - last < every) continue;

      try {
        await runAutomation(auto.id, {
          workspaceId,
          triggerType: 'schedule',
          userId: workspaceId,
          maxRetries: 3,
        }, { workspaceId });
        await automationStorage.update(auto.id, {
          triggerConfig: {
            ...(auto.triggerConfig || {}),
            lastRunAt: new Date().toISOString(),
          },
        }, { workspaceId });
        console.log(`[AutomationScheduler] ran ${auto.id} (${auto.name}) ws=${workspaceId}`);
      } catch (err) {
        console.error(`[AutomationScheduler] ${auto.id}:`, err.message);
      }
    }
  }
}

async function processRetries() {
  for (const workspaceId of discoverWorkspaces()) {
    const due = await automationStorage.listRetryableRuns({ workspaceId, limit: 25 });
    for (const failed of due) {
      try {
        const ctx = failed.context || {};
        console.log(`[AutomationScheduler] retrying run ${failed.id} attempt=${ctx.retryAttempt || 0}`);
        // Mark old run as superseded so it is not retried again
        await automationStorage.updateRun(failed.id, {
          context: { ...ctx, retryClaimedAt: new Date().toISOString(), nextRetryAt: null },
          status: 'superseded',
          finishedAt: new Date().toISOString(),
        }, { workspaceId });

        await runAutomation(failed.automationId, {
          ...ctx,
          workspaceId,
          triggerType: ctx.triggerType || failed.triggerType || 'retry',
          userId: ctx.userId || workspaceId,
          retryAttempt: Number(ctx.retryAttempt || 0),
          maxRetries: Number(ctx.maxRetries ?? 3),
          retriedFromRunId: failed.id,
        }, { workspaceId });
      } catch (err) {
        console.error(`[AutomationScheduler] retry failed for ${failed.id}:`, err.message);
      }
    }
  }
}

async function processDelays() {
  for (const workspaceId of discoverWorkspaces()) {
    const due = await automationStorage.listWaitingRuns({ workspaceId, limit: 25 });
    for (const waiting of due) {
      try {
        const ctx = waiting.context || {};
        console.log(`[AutomationScheduler] resuming delayed run ${waiting.id}`);
        // Claim first (still waiting) so another tick cannot double-resume
        await automationStorage.updateRun(waiting.id, {
          status: 'waiting',
          context: { ...ctx, delayClaimedAt: new Date().toISOString() },
        }, { workspaceId });

        const resumeActions = Array.isArray(ctx.resumeActions) ? ctx.resumeActions : [];
        if (!resumeActions.length) {
          await automationStorage.updateRun(waiting.id, {
            status: 'succeeded',
            finishedAt: new Date().toISOString(),
            context: { ...ctx, delayClaimedAt: new Date().toISOString(), resumeEmpty: true },
          }, { workspaceId });
          continue;
        }

        try {
          await runAutomation(waiting.automationId || ctx.automationId, {
            ...ctx,
            workspaceId,
            triggerType: 'delay_resume',
            resumeActions,
            userId: ctx.userId || workspaceId,
            maxRetries: Number(ctx.maxRetries ?? 3),
            resumedFromRunId: waiting.id,
          }, { workspaceId });
          await automationStorage.updateRun(waiting.id, {
            status: 'succeeded',
            finishedAt: new Date().toISOString(),
            context: { ...ctx, delayClaimedAt: new Date().toISOString(), resumed: true },
          }, { workspaceId });
        } catch (resumeErr) {
          // Restore waiting so scheduler can retry after backoff
          const retryAt = new Date(Date.now() + 60_000).toISOString();
          await automationStorage.updateRun(waiting.id, {
            status: 'waiting',
            context: {
              ...ctx,
              delayClaimedAt: null,
              resumeAt: retryAt,
              lastResumeError: resumeErr.message,
            },
          }, { workspaceId });
          throw resumeErr;
        }
      } catch (err) {
        console.error(`[AutomationScheduler] delay resume failed for ${waiting.id}:`, err.message);
      }
    }
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await processScheduled();
    await processRetries();
    await processDelays();
  } catch (err) {
    logTickError(err);
  } finally {
    running = false;
  }
}

function startAutomationScheduler() {
  const enabled = String(process.env.AUTOMATION_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[AutomationScheduler] disabled');
    return;
  }
  const intervalMs = Math.max(30_000, parseInt(process.env.AUTOMATION_SCHEDULER_INTERVAL_MS || '60000', 10));
  if (timer) clearInterval(timer);
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  console.log(`[AutomationScheduler] started (interval=${intervalMs}ms, retries=on)`);
  setTimeout(() => { tick().catch(() => {}); }, 12_000).unref?.();
}

function stopAutomationScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  console.log('[AutomationScheduler] stopped');
}

module.exports = {
  startAutomationScheduler,
  stopAutomationScheduler,
  tick,
  processRetries,
  processScheduled,
  processDelays,
};
