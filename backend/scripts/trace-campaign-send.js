/**
 * One-shot campaign send trace — logs each step with ISO timestamps.
 * Usage: node backend/scripts/trace-campaign-send.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const WORKSPACE_ID = process.env.TRACE_WORKSPACE_ID || 'usr_super_admin_1783323507243';
const TO_EMAIL = process.env.TRACE_TO_EMAIL || 'leadflow.my@gmail.com';

function step(n, label, extra = {}) {
  const line = { step: n, label, at: new Date().toISOString(), ...extra };
  console.log('[TRACE]', JSON.stringify(line));
  return line;
}

function dumpError(label, err) {
  console.log('[TRACE ERROR]', label, JSON.stringify({
    message: err?.message,
    source: err?.source,
    service: err?.service,
    status: err?.status,
    rateLimited: err?.rateLimited,
    retryAfter: err?.retryAfter,
    code: err?.code,
    errors: err?.errors,
    response: err?.response?.data || err?.response || undefined,
  }, null, 2));
}

async function main() {
  step(1, 'trace_script_started', { workspaceId: WORKSPACE_ID, to: TO_EMAIL });

  const { sendViaGmailApi, getGmailClient } = require('../services/emailOAuthService');
  const { getQueueStats, runGmailOperation } = require('../utils/gmailApiQueue');

  step(2, 'modules_loaded', { queueStats: getQueueStats(WORKSPACE_ID) });

  step(3, 'creating_gmail_client');
  let client;
  try {
    client = await getGmailClient(WORKSPACE_ID);
    step(4, 'gmail_client_created', {
      success: Boolean(client),
      user: client?.user || null,
    });
  } catch (err) {
    step(4, 'gmail_client_created', { success: false });
    dumpError('gmail_client', err);
    process.exit(1);
  }

  if (!client) {
    step(4, 'gmail_client_created', { success: false, reason: 'OAuth not configured' });
    process.exit(1);
  }

  step(5, 'queue_before_send', getQueueStats(WORKSPACE_ID));

  step(6, 'calling_sendViaGmailApi');
  const started = Date.now();
  try {
    const result = await sendViaGmailApi(WORKSPACE_ID, {
      to: TO_EMAIL,
      subject: `[TRACE] Campaign send test ${started}`,
      text: 'Trace campaign send — one recipient, no image, no preview.',
      html: '<p>Trace campaign send — one recipient, no image, no preview.</p>',
      skipDeliveryVerification: true,
    });
    step(7, 'sendViaGmailApi_resolved', {
      success: true,
      elapsedMs: Date.now() - started,
      messageId: result?.messageId,
      recipientEmail: result?.recipientEmail,
    });
    step(8, 'queue_after_send', getQueueStats(WORKSPACE_ID));
    step(9, 'trace_complete', { success: true, totalMs: Date.now() - started });
  } catch (err) {
    step(7, 'sendViaGmailApi_failed', {
      success: false,
      elapsedMs: Date.now() - started,
    });
    dumpError('sendViaGmailApi', err);
    step(8, 'queue_after_failure', getQueueStats(WORKSPACE_ID));
    step(9, 'trace_complete', { success: false, totalMs: Date.now() - started });
    process.exit(1);
  }
}

main().catch((err) => {
  dumpError('unhandled', err);
  process.exit(1);
});
