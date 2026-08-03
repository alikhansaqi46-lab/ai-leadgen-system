/**
 * Gmail rate-limit backoff — delegates per-account pause state to gmailApiQueue.
 */

const { logExternalApiError, isRateLimitError } = require('./externalApiErrors');
const gmailApiQueue = require('./gmailApiQueue');

function isGmailBackoffActive(workspaceId) {
  if (workspaceId) {
    return gmailApiQueue.isPaused(workspaceId);
  }
  return gmailApiQueue.isAnyPaused();
}

function getGmailBackoffUntil(workspaceId) {
  if (workspaceId) {
    return gmailApiQueue.getPausedUntil(workspaceId);
  }
  return 0;
}

function activateGmailBackoff(err, context = {}) {
  if (!isRateLimitError(err)) return false;
  const workspaceId = context.workspaceId;
  if (workspaceId) {
    gmailApiQueue.pauseAccount(workspaceId, err);
  }
  logExternalApiError(err, {
    ...context,
    action: 'gmail_backoff_activated',
    backoffUntil: workspaceId
      ? new Date(gmailApiQueue.getPausedUntil(workspaceId)).toISOString()
      : null,
  });
  return true;
}

function clearGmailBackoff() {
  // Queue pause clears automatically when retryAfter elapses.
}

module.exports = {
  isGmailBackoffActive,
  getGmailBackoffUntil,
  activateGmailBackoff,
  clearGmailBackoff,
};
