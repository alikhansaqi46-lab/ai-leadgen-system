/**
 * Non-invasive verification: exercises Gmail inbox sync only (no email sent).
 * Confirms whether Gmail API / IMAP connectivity currently works from this
 * Node process, independent of any frontend rendering changes.
 *
 * Usage: node backend/scripts/verify-inbox-sync-only.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const WORKSPACE_ID = process.env.TRACE_WORKSPACE_ID || 'usr_super_admin_1783323507243';

async function main() {
  const emailInboxService = require('../services/emailInboxService');
  const { getQueueStats } = require('../utils/gmailApiQueue');

  console.log('[VERIFY] starting inbox session for', WORKSPACE_ID);
  const session = emailInboxService.beginSession(WORKSPACE_ID);
  console.log('[VERIFY] session:', session);

  console.log('[VERIFY] calling syncNow()...');
  const start = Date.now();
  try {
    const result = await emailInboxService.syncNow(WORKSPACE_ID);
    console.log('[VERIFY] syncNow result:', JSON.stringify(result, null, 2));
    console.log('[VERIFY] elapsedMs:', Date.now() - start);
  } catch (err) {
    console.error('[VERIFY] syncNow FAILED:', err.message);
  }

  console.log('[VERIFY] queue stats:', getQueueStats(WORKSPACE_ID));

  emailInboxService.endSession(WORKSPACE_ID);
  console.log('[VERIFY] session ended');
  process.exit(0);
}

main().catch((err) => {
  console.error('[VERIFY FATAL]', err);
  process.exit(1);
});
