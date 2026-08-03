/**
 * Workspace resolution for HTTP handlers.
 *
 * Prefer req.auth from auth middleware. The legacy `x-user-id` header is only
 * honored when AUTH_MODE is disabled/dev (local compatibility). Real auth modes
 * ignore the header to prevent cross-tenant spoofing.
 */

function authMode() {
  return (process.env.AUTH_MODE || 'disabled').toLowerCase();
}

function workspaceOf(req) {
  if (req && req.auth && req.auth.workspaceId) {
    return String(req.auth.workspaceId);
  }
  if (req && req.auth && req.auth.userId) {
    return String(req.auth.userId);
  }
  if (req && req.auth && req.auth.sub) {
    return String(req.auth.sub);
  }

  const mode = authMode();
  if (mode === 'disabled' || mode === 'dev') {
    const header = req && (req.headers['x-user-id'] || req.headers['X-User-Id']);
    if (header) return String(header);
  }

  return process.env.DEFAULT_WORKSPACE_ID || 'default';
}

/** Workspace for unauthenticated webhooks — never trust client body/header alone. */
function webhookWorkspaceId(explicit) {
  const allowed = (process.env.WEBHOOK_WORKSPACE_ID || process.env.DEFAULT_WORKSPACE_ID || 'default').trim();
  if (explicit && String(explicit) === allowed) return allowed;
  return allowed;
}

module.exports = { workspaceOf, webhookWorkspaceId, authMode };
