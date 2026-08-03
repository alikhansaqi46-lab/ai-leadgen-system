/**
 * Twilio webhook signature verification.
 *
 * Header: X-Twilio-Signature
 * Algo: Base64(HMAC-SHA1(authToken, url + sortedPostParamsConcat))
 *
 * Auth token from TWILIO_AUTH_TOKEN env or workspace SMS credentials (default).
 */

const crypto = require('crypto');
const integrationStorage = require('../utils/integrationStorage');

function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function getTwilioAuthToken(workspaceId = 'default') {
  const env = (process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_SMS_AUTH_TOKEN || '').trim();
  if (env) return env;
  try {
    const creds = integrationStorage.getCredentials(workspaceId, 'sms');
    return (creds && creds.authToken) || '';
  } catch (_) {
    return '';
  }
}

function buildCanonicalUrl(req) {
  const configured = (process.env.TWILIO_WEBHOOK_BASE_URL || process.env.API_BASE_URL || '').replace(/\/$/, '');
  if (configured) {
    return `${configured}${req.originalUrl || req.url}`;
  }
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  return `${proto}://${host}${req.originalUrl || req.url}`;
}

function computeTwilioSignature(authToken, url, params) {
  const keys = Object.keys(params || {}).sort();
  let data = url;
  for (const k of keys) {
    const v = params[k];
    data += k + (Array.isArray(v) ? v.join('') : String(v == null ? '' : v));
  }
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Express middleware for Twilio POST webhooks.
 * Uses req.body (urlencoded). Skip GET.
 */
function verifyTwilioSignature(req, res, next) {
  if (req.method !== 'POST') return next();

  const token = getTwilioAuthToken('default');
  const signature = req.headers['x-twilio-signature'];

  if (!token) {
    if (isProduction()) {
      console.error('[Twilio Webhook] TWILIO_AUTH_TOKEN required in production');
      return res.status(503).send('Twilio signature verification not configured');
    }
    console.warn('[Twilio Webhook] TWILIO_AUTH_TOKEN not set — skipping signature check (dev only)');
    return next();
  }

  if (!signature) {
    console.warn('[Twilio Webhook] missing X-Twilio-Signature');
    return res.status(403).send('Forbidden');
  }

  const url = buildCanonicalUrl(req);
  const expected = computeTwilioSignature(token, url, req.body || {});
  if (!timingSafeEqualStr(signature, expected)) {
    console.warn('[Twilio Webhook] signature mismatch');
    return res.status(403).send('Forbidden');
  }
  return next();
}

module.exports = {
  verifyTwilioSignature,
  computeTwilioSignature,
  buildCanonicalUrl,
  getTwilioAuthToken,
};
