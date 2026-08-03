/**
 * Background follow-up worker — processes overdue follow-ups for all workspaces.
 *
 * Enabled when FOLLOWUP_WORKER_ENABLED is unset or "true".
 * Interval: FOLLOWUP_WORKER_INTERVAL_MS (default 60000).
 *
 * Uses the same send path as POST /api/campaign/follow-up/process-due.
 * Skips workspaces without WhatsApp connected (QR session or Meta).
 */

const campaignStorage = require('../utils/campaignStorage');
const followUpStorage = require('../utils/followUpStorage');
const leadStorage = require('../utils/leadStorage');
const integrationStorage = require('../utils/integrationStorage');
const unifiedSend = require('./unifiedSend');
const whatsappTransport = require('./whatsappTransport');
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
      '[FollowUpWorker] Postgres TLS trust failed (throttled). '
      + 'Set TLS_CA_FILE or NODE_EXTRA_CA_CERTS to your corporate/root CA PEM. '
      + 'Do not set TLS_INSECURE_ALLOW in production. Detail:',
      err.message
    );
    return;
  }
  console.error('[FollowUpWorker] tick error:', err.message);
}

async function processWorkspace(workspaceId) {
  if (!whatsappTransport.isConfigured(workspaceId)) {
    return { workspaceId, skipped: true, reason: 'whatsapp_not_configured' };
  }

  const overdue = await campaignStorage.getOverdueFollowUps({ workspaceId });
  if (!overdue.length) return { workspaceId, processed: 0, sent: 0 };

  const results = [];

  for (const item of overdue) {
    try {
      const leadId = item.leadId;
      const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
      const lead = (leads || []).find((l) => l.id === leadId);
      if (!lead || !lead.phone) {
        results.push({ leadId, status: 'skipped', reason: 'No phone number' });
        continue;
      }

      const name = (lead.name || 'there').split(/\s+/)[0];
      const niche = String(lead.niche || lead.category || 'business').trim().toLowerCase();
      const body = `Hi ${name}, just following up on my earlier message. Would love to show you how other ${niche}s are getting more leads. Open to a quick chat?`;

      const sendResult = await unifiedSend.send({
        leadId,
        channel: 'whatsapp',
        body,
        providerSend: async () => whatsappTransport.sendText({
          workspaceId,
          to: lead.phone,
          message: body,
        }),
        metadata: { source: 'follow_up_worker' },
        scheduleFollowUps: false,
        workspaceId,
      });

      if (item.id && item.status === 'pending') {
        await followUpStorage.markFollowUpSent(item.id, { workspaceId });
      } else {
        const followUpNum = !item.followUp1Sent ? 1 : 2;
        await campaignStorage.markFollowUpSent(leadId, followUpNum, { workspaceId });
      }

      results.push({ leadId, status: 'sent', messageId: sendResult.messageId });
    } catch (err) {
      console.error(`[FollowUpWorker] ${workspaceId}/${item.leadId}:`, err.message);
      results.push({ leadId: item.leadId, status: 'failed', error: err.message });
    }
  }

  return {
    workspaceId,
    processed: results.length,
    sent: results.filter((r) => r.status === 'sent').length,
    results,
  };
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const workspaces = new Set([
      ...(integrationStorage.listAllWorkspaces() || []),
      process.env.DEFAULT_WORKSPACE_ID || 'default',
    ]);
    let totalSent = 0;
    for (const ws of workspaces) {
      const summary = await processWorkspace(ws);
      if (summary.sent) {
        totalSent += summary.sent;
        console.log(`[FollowUpWorker] ${ws}: sent=${summary.sent} processed=${summary.processed}`);
      }
    }
    if (totalSent === 0 && process.env.FOLLOWUP_WORKER_VERBOSE === 'true') {
      console.log('[FollowUpWorker] tick complete — nothing due');
    }
  } catch (err) {
    logTickError(err);
  } finally {
    running = false;
  }
}

function startFollowUpWorker() {
  const enabled = String(process.env.FOLLOWUP_WORKER_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[FollowUpWorker] disabled (FOLLOWUP_WORKER_ENABLED=false)');
    return;
  }
  const intervalMs = Math.max(15_000, parseInt(process.env.FOLLOWUP_WORKER_INTERVAL_MS || '60000', 10));
  if (timer) clearInterval(timer);
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  console.log(`[FollowUpWorker] started (interval=${intervalMs}ms)`);
  // First tick after a short delay so boot is not blocked
  setTimeout(() => { tick().catch(() => {}); }, 8_000).unref?.();
}

function stopFollowUpWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  startFollowUpWorker,
  stopFollowUpWorker,
  processWorkspace,
  tick,
};
