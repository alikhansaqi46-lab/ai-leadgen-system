/**
 * Safe Owner Console error logger — never throws into request path.
 */

const adminAudit = require('../utils/adminAudit');

async function logAdminError(errOrMessage, { level = 'error', source = 'system', meta = {} } = {}) {
  try {
    const message = typeof errOrMessage === 'string'
      ? errOrMessage
      : (errOrMessage?.message || String(errOrMessage));
    const stack = typeof errOrMessage === 'object' && errOrMessage?.stack
      ? String(errOrMessage.stack).slice(0, 4000)
      : undefined;
    await adminAudit.recordErrorLog({
      level,
      source,
      message,
      meta: { ...meta, ...(stack ? { stack } : {}) },
    });
  } catch (e) {
    console.warn('[ErrorLogger] failed to persist:', e.message);
  }
}

module.exports = { logAdminError };
