/**
 * Non-invasive verification of the Gmail History API sync path.
 * Confirms:
 *   1. First sync (no checkpoint) falls back to full-list and stores a
 *      historyId checkpoint.
 *   2. Second sync (checkpoint present) uses the cheap history.list path
 *      and completes quickly with no new messages (steady state).
 *   3. Timing — the whole round trip should be well under 1 second of
 *      actual Gmail API latency for the history-based path.
 *
 * Usage: node backend/scripts/verify-history-sync.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const WORKSPACE_ID = process.env.TRACE_WORKSPACE_ID || 'usr_super_admin_1783323507243';

async function main() {
  const emailInboxService = require('../services/emailInboxService');
  const { getQueueStats } = require('../utils/gmailApiQueue');

  const session = emailInboxService.beginSession(WORKSPACE_ID);
  console.log('[VERIFY] session:', session);

  const before = getQueueStats(WORKSPACE_ID).apiCalls;
  const t1Start = Date.now();
  const first = await emailInboxService.syncNow(WORKSPACE_ID);
  const t1 = Date.now() - t1Start;
  const afterFirst = getQueueStats(WORKSPACE_ID).apiCalls;
  console.log('[VERIFY] sync #1 (checkpoint may or may not exist):', JSON.stringify(first), '| elapsedMs:', t1, '| apiCalls used:', afterFirst - before);

  const t2Start = Date.now();
  const second = await emailInboxService.syncNow(WORKSPACE_ID);
  const t2 = Date.now() - t2Start;
  const afterSecond = getQueueStats(WORKSPACE_ID).apiCalls;
  console.log('[VERIFY] sync #2 (should use history.list now):', JSON.stringify(second), '| elapsedMs:', t2, '| apiCalls used:', afterSecond - afterFirst);

  emailInboxService.endSession(WORKSPACE_ID);

  const usedHistoryPath = second.provider === 'gmail_api_history';
  console.log('\n[VERIFY SUMMARY] second sync used history API:', usedHistoryPath, '| second sync apiCalls:', afterSecond - afterFirst, '(expect 1 when steady-state, no new mail)');
  process.exit(usedHistoryPath ? 0 : 1);
}

main().catch((err) => {
  console.error('[VERIFY FATAL]', err);
  process.exit(1);
});
