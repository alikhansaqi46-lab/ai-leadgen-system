/**
 * Clean-state Gmail send verification.
 * Waits for Google Retry-After, sends ONE campaign email, prints evidence.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const RETRY_AFTER_ISO = process.env.CLEAN_STATE_RETRY_AFTER || '2026-07-08T07:45:50.138Z';
const WORKSPACE_ID = process.env.TRACE_WORKSPACE_ID || 'usr_super_admin_1783323507243';
const LEAD_ID = process.env.CLEAN_STATE_LEAD_ID || 'e0d9b27e-fe87-473c-bd5c-4c0e9719673d';

function log(label, extra = {}) {
  console.log(`[CLEAN-STATE] ${label}`, JSON.stringify({ at: new Date().toISOString(), ...extra }));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForRetryAfter() {
  const target = new Date(RETRY_AFTER_ISO).getTime();
  const now = Date.now();
  if (now >= target) {
    log('retry_after_passed', { retryAfter: RETRY_AFTER_ISO, waitedMs: 0 });
    return;
  }
  const waitMs = target - now + 5000;
  log('waiting_for_retry_after', { retryAfter: RETRY_AFTER_ISO, waitMs });
  await sleep(waitMs);
  log('retry_after_passed', { retryAfter: RETRY_AFTER_ISO, waitedMs: waitMs });
}

async function main() {
  log('verification_started', { retryAfter: RETRY_AFTER_ISO, workspaceId: WORKSPACE_ID, leadId: LEAD_ID });

  await waitForRetryAfter();

  const { getQueueStats } = require('../utils/gmailApiQueue');
  log('queue_stats_before_send', getQueueStats(WORKSPACE_ID));

  const payload = {
    channel: 'email',
    leads: [{ id: LEAD_ID, email: 'leadflow.my@gmail.com', name: 'Clean State Test', city: 'Test', niche: 'Test' }],
    message: 'Clean-state verification — single recipient, no preview.',
    subject: 'Clean State Verification',
    previewMode: false,
  };

  const req = {
    body: payload,
    auth: { userId: WORKSPACE_ID, workspaceId: WORKSPACE_ID },
    headers: {},
  };

  let responseBody = null;
  const res = {
    status() { return this; },
    json(body) { responseBody = body; return body; },
  };

  const campaignRouter = require('../routes/campaign');
  const layer = campaignRouter.stack.find((l) => l.route && l.route.path === '/send-with-preview' && l.route.methods.post);
  const handler = layer.route.stack[0].handle;

  const started = Date.now();
  log('campaign_send_started');
  await handler(req, res);
  const elapsedMs = Date.now() - started;

  const queueAfter = getQueueStats(WORKSPACE_ID);
  log('queue_stats_after_send', queueAfter);
  log('campaign_response', {
    elapsedMs,
    success: responseBody?.sent > 0,
    sent: responseBody?.sent,
    failed: responseBody?.failed,
    results: responseBody?.results,
    gmailApiCalls: queueAfter.apiCalls,
  });

  const result = responseBody?.results?.[0];
  if (responseBody?.sent > 0 && result?.messageId) {
    log('VERIFICATION_SUCCESS', { messageId: result.messageId, gmailApiCalls: queueAfter.apiCalls });
    process.exit(0);
  }

  log('VERIFICATION_FAILED', {
    error: result?.error,
    source: result?.source,
    rateLimited: result?.rateLimited,
    retryAfter: result?.retryAfter,
    gmailApiCalls: queueAfter.apiCalls,
  });
  process.exit(1);
}

main().catch((err) => {
  log('unhandled_error', {
    message: err?.message,
    source: err?.source,
    response: err?.response?.data,
  });
  process.exit(1);
});
