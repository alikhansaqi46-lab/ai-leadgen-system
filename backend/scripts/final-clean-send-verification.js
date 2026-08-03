/**
 * Final clean production send verification — waits for cooldown, restarts backend, sends once.
 * Usage: node backend/scripts/final-clean-send-verification.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const WORKSPACE_ID = process.env.TRACE_WORKSPACE_ID || 'usr_super_admin_1783323507243';
const TO_EMAIL = process.env.TRACE_TO_EMAIL || 'leadflow.my@gmail.com';
const PORT = parseInt(process.env.PORT, 10) || 5001;
const LOG_DIR = path.join(__dirname, '..', 'logs');
const OUT_LOG = path.join(LOG_DIR, 'final-verify.out.log');
const ERR_LOG = path.join(LOG_DIR, 'final-verify.err.log');
const REPORT_PATH = path.join(LOG_DIR, 'final-verify-report.json');

const COOLDOWN_UNTIL_UTC = process.env.FORCE_SEND_AFTER_UTC || '2026-07-08T08:38:00.000Z';

const report = {
  testStartedAt: new Date().toISOString(),
  cooldownUntilUtc: COOLDOWN_UNTIL_UTC,
  phases: [],
  gmailApiCallsFromServerLog: [],
  send: null,
  delivery: null,
  startupGmailApiCallCount: 0,
  passed: false,
};

function phase(label, data = {}) {
  const entry = { at: new Date().toISOString(), label, ...data };
  report.phases.push(entry);
  console.log('[FINAL-VERIFY]', JSON.stringify(entry));
  return entry;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return out.trim();
    }
    execSync(`fuser -k ${port}/tcp 2>/dev/null || true`);
  } catch (_) {}
}

function grepGmailApiCalls(logText) {
  const lines = logText.split('\n').filter((l) => l.includes('[GmailAPI]'));
  const endpoints = [];
  for (const line of lines) {
    const m = line.match(/"endpoint":"([^"]+)"/);
    if (m) endpoints.push(m[1]);
    else if (line.includes('messages.send')) endpoints.push('messages.send');
    else if (line.includes('messages.list')) endpoints.push('messages.list');
    else if (line.includes('messages.get')) endpoints.push('messages.get');
    else endpoints.push('unknown');
  }
  return { count: lines.length, lines, endpoints };
}

async function waitForCooldown() {
  const target = Date.parse(COOLDOWN_UNTIL_UTC);
  if (Number.isNaN(target)) throw new Error(`Invalid COOLDOWN_UNTIL_UTC: ${COOLDOWN_UNTIL_UTC}`);
  const now = Date.now();
  const waitMs = target - now + 5000;
  if (waitMs > 0) {
    phase('waiting_for_cooldown', { waitMs, until: COOLDOWN_UNTIL_UTC, nowUtc: new Date().toISOString() });
    await sleep(waitMs);
  }
  phase('cooldown_window_elapsed', { nowUtc: new Date().toISOString() });
}

function startBackend() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  try { fs.unlinkSync(OUT_LOG); } catch (_) {}
  try { fs.unlinkSync(ERR_LOG); } catch (_) {}

  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  child.stdout.on('data', (d) => fs.appendFileSync(OUT_LOG, d));
  child.stderr.on('data', (d) => fs.appendFileSync(ERR_LOG, d));

  return child;
}

async function waitForServer(maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${PORT}/api/email/status`, { headers: { 'x-user-id': WORKSPACE_ID } }, (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) resolve();
          else reject(new Error(`status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch (_) {
      await sleep(500);
    }
  }
  throw new Error('Server did not become ready');
}

async function verifyDelivery(gmail, gmailMessageId, rfcTo) {
  const getRes = await gmail.users.messages.get({
    userId: 'me',
    id: gmailMessageId,
    format: 'metadata',
    metadataHeaders: ['To', 'Subject', 'From'],
  });
  const headers = Object.fromEntries(
    (getRes.data.payload?.headers || []).map((h) => [String(h.name).toLowerCase(), h.value])
  );
  const labelIds = getRes.data.labelIds || [];

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['SENT'],
    q: `rfc822msgid:${gmailMessageId} OR to:${rfcTo}`,
    maxResults: 5,
  });

  return {
    messageExists: Boolean(getRes.data.id),
    labelIds,
    inSent: labelIds.includes('SENT'),
    headers,
    sentFolderMatches: (listRes.data.messages || []).length,
    threadId: getRes.data.threadId,
  };
}

async function runSendTest() {
  const { sendViaGmailApi, getGmailClient } = require('../services/emailOAuthService');
  const { getQueueStats } = require('../utils/gmailApiQueue');

  const queueBefore = getQueueStats(WORKSPACE_ID);
  phase('queue_before_send', queueBefore);

  const apiCallsBefore = queueBefore.apiCalls;
  const endpointsCalled = [];
  const origLog = console.log;
  console.log = (...args) => {
    const s = args.map(String).join(' ');
    if (s.includes('[GmailAPI] call')) {
      const m = s.match(/"endpoint":"([^"]+)"/);
      endpointsCalled.push(m ? m[1] : 'parse_failed');
    }
    origLog.apply(console, args);
  };

  const started = Date.now();
  let sendResult = null;
  let sendError = null;

  try {
    sendResult = await sendViaGmailApi(WORKSPACE_ID, {
      to: TO_EMAIL,
      subject: `[FINAL-VERIFY] Clean production send ${started}`,
      text: 'Final clean verification — one recipient, preview off, post-cooldown.',
      html: '<p>Final clean verification — one recipient, preview off, post-cooldown.</p>',
      skipDeliveryVerification: true,
    });
  } catch (err) {
    sendError = {
      message: err.message,
      status: err.status,
      rateLimited: err.rateLimited,
      retryAfter: err.retryAfter,
      reason: err.reason,
      code: err.code,
      errors: err.errors,
      responseData: err.details?.responseData || err.response?.data || null,
      stack: err.stack?.split('\n').slice(0, 8),
    };
  } finally {
    console.log = origLog;
  }

  const elapsedMs = Date.now() - started;
  const queueAfter = getQueueStats(WORKSPACE_ID);
  const sendApiCalls = queueAfter.apiCalls - apiCallsBefore;

  report.send = {
    success: Boolean(sendResult?.messageId),
    elapsedMs,
    messageId: sendResult?.messageId || null,
    rfcMessageId: sendResult?.rfcMessageId || null,
    gmailThreadId: sendResult?.gmailThreadId || null,
    recipientEmail: sendResult?.recipientEmail || TO_EMAIL,
    totalGmailApiCallsForSend: sendApiCalls,
    endpointsCalled: endpointsCalled.length ? endpointsCalled : (sendApiCalls ? ['messages.send'] : []),
    queueBefore,
    queueAfter,
    error: sendError,
  };

  phase('send_complete', {
    success: report.send.success,
    elapsedMs,
    apiCalls: sendApiCalls,
    messageId: report.send.messageId,
    error: sendError?.message || null,
  });

  if (sendResult?.messageId) {
    try {
      const client = await getGmailClient(WORKSPACE_ID);
      const delivery = await verifyDelivery(client.gmail, sendResult.messageId, TO_EMAIL);
      report.delivery = { verified: true, ...delivery };
      phase('delivery_verified', delivery);
    } catch (delErr) {
      report.delivery = { verified: false, error: delErr.message };
      phase('delivery_check_failed', { error: delErr.message });
    }
  }

  return report.send.success;
}

async function main() {
  phase(0, 'test_plan', {
    workspaceId: WORKSPACE_ID,
    to: TO_EMAIL,
    port: PORT,
    cooldownUntilUtc: COOLDOWN_UNTIL_UTC,
  });

  await waitForCooldown();

  phase(1, 'killing_old_backend_processes');
  killPort(PORT);
  await sleep(3000);

  phase(2, 'starting_fresh_backend');
  const serverProc = startBackend();
  await waitForServer();
  await sleep(8000);

  const startupLogs = (fs.existsSync(OUT_LOG) ? fs.readFileSync(OUT_LOG, 'utf8') : '')
    + (fs.existsSync(ERR_LOG) ? fs.readFileSync(ERR_LOG, 'utf8') : '');
  const startupGmail = grepGmailApiCalls(startupLogs);
  report.startupGmailApiCallCount = startupGmail.count;
  report.gmailApiCallsFromServerLog = startupGmail.endpoints;
  phase(3, 'startup_verification', {
    gmailApiCallCount: startupGmail.count,
    endpoints: startupGmail.endpoints,
    serverLogLines: startupGmail.lines.length,
  });

  const sendOk = await runSendTest();

  report.testCompletedAt = new Date().toISOString();
  report.passed = sendOk
    && report.startupGmailApiCallCount === 0
    && report.send?.totalGmailApiCallsForSend === 1
    && report.send?.endpointsCalled?.every((e) => e === 'messages.send');

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  phase('report_written', { path: REPORT_PATH, passed: report.passed });

  try { serverProc.kill(); } catch (_) {}
  killPort(PORT);

  console.log('\n========== FINAL VERIFICATION REPORT ==========');
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  console.error('[FINAL-VERIFY FATAL]', err);
  process.exit(1);
});
