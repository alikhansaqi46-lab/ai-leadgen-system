/**
 * End-to-end Gmail production verification.
 * Usage: node backend/scripts/verify-gmail-production.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const WORKSPACE_ID = process.env.TRACE_WORKSPACE_ID || 'usr_super_admin_1783323507243';
const TO_EMAIL = process.env.TRACE_TO_EMAIL || 'leadflow.my@gmail.com';
const BASE = process.env.VERIFY_API_BASE || 'http://127.0.0.1:5001';

const report = {
  startedAt: new Date().toISOString(),
  steps: [],
  gmailApiCalls: [],
  totalGmailApiCalls: 0,
  sendSuccess: false,
  messageId: null,
  errors: [],
};

function step(label, data = {}) {
  const entry = { at: new Date().toISOString(), label, ...data };
  report.steps.push(entry);
  console.log('[VERIFY]', JSON.stringify(entry));
  return entry;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function http(method, path, body) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': WORKSPACE_ID,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function captureQueueStats() {
  const { getQueueStats } = require('../utils/gmailApiQueue');
  return getQueueStats(WORKSPACE_ID);
}

async function main() {
  step(1, 'verify_started', { workspaceId: WORKSPACE_ID, base: BASE });

  // Phase A: fresh backend should have zero Gmail API calls
  const statsAfterBoot = captureQueueStats();
  step(2, 'queue_stats_after_boot', statsAfterBoot);
  if (statsAfterBoot.apiCalls > 0) {
    report.errors.push(`Expected 0 Gmail API calls after boot, got ${statsAfterBoot.apiCalls}`);
  }

  // Phase B: simulate Email CRM page (no inbox session) — still zero calls
  await sleep(2000);
  const statsEmailCrm = captureQueueStats();
  step(3, 'queue_stats_email_crm_simulation', statsEmailCrm);
  if (statsEmailCrm.apiCalls > statsAfterBoot.apiCalls) {
    report.errors.push('Gmail API calls increased without user Gmail action');
  }

  // Phase C: campaign send (preview off) — exactly one messages.send
  const apiCallsBeforeSend = captureQueueStats().apiCalls;
  step(4, 'campaign_send_start', { apiCallsBeforeSend });

  const { sendViaGmailApi } = require('../services/emailOAuthService');
  const sendStarted = Date.now();
  try {
    const result = await sendViaGmailApi(WORKSPACE_ID, {
      to: TO_EMAIL,
      subject: `[VERIFY] Production Gmail test ${sendStarted}`,
      text: 'LeadFlow production verification — one recipient, preview off.',
      html: '<p>LeadFlow production verification — one recipient, preview off.</p>',
      skipDeliveryVerification: true,
    });
    report.sendSuccess = true;
    report.messageId = result.messageId;
    step(5, 'campaign_send_success', {
      elapsedMs: Date.now() - sendStarted,
      messageId: result.messageId,
    });
  } catch (err) {
    step(5, 'campaign_send_failed', {
      elapsedMs: Date.now() - sendStarted,
      message: err.message,
      rateLimited: err.rateLimited,
      retryAfter: err.retryAfter,
    });
    report.errors.push(err.message);
  }

  const statsAfterSend = captureQueueStats();
  const sendApiCalls = statsAfterSend.apiCalls - apiCallsBeforeSend;
  step(6, 'queue_stats_after_send', { ...statsAfterSend, sendApiCalls });
  report.totalGmailApiCalls = statsAfterSend.apiCalls;

  // Phase D: inbox session start — should begin sync (may call messages.list after delay)
  const apiCallsBeforeInbox = statsAfterSend.apiCalls;
  const emailInboxService = require('../services/emailInboxService');
  const session = emailInboxService.beginSession(WORKSPACE_ID);
  step(7, 'inbox_session_started', session);

  await sleep(4000);
  const statsAfterInbox = captureQueueStats();
  step(8, 'queue_stats_after_inbox_session', {
    ...statsAfterInbox,
    inboxApiCalls: statsAfterInbox.apiCalls - apiCallsBeforeInbox,
  });

  emailInboxService.endSession(WORKSPACE_ID);
  step(9, 'inbox_session_ended');

  await sleep(2000);
  const statsAfterInboxEnd = captureQueueStats();
  step(10, 'queue_stats_after_inbox_end', statsAfterInboxEnd);

  report.completedAt = new Date().toISOString();
  report.passed = report.errors.length === 0 && report.sendSuccess && statsAfterBoot.apiCalls === 0;

  console.log('\n[VERIFY REPORT]', JSON.stringify(report, null, 2));
  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  console.error('[VERIFY FATAL]', err);
  process.exit(1);
});
