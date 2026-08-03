/**
 * Meta WhatsApp Cloud API webhook signature verification.
 *
 * Meta signs POST bodies with HMAC-SHA256 using the App Secret.
 * Header: X-Hub-Signature-256: sha256=<hex>
 *
 * Requires WHATSAPP_APP_SECRET (or META_APP_SECRET) and req.rawBody (Buffer)
 * captured by express.json verify hook in server.js.
 */

const crypto = require('crypto');

function getAppSecret() {
  return (process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET || '').trim();
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Express middleware for POST /webhook signature check.
 * GET verification (hub.challenge) is unaffected.
 */
function verifyWhatsAppSignature(req, res, next) {
  if (req.method !== 'POST') return next();

  const secret = getAppSecret();
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

  if (!secret) {
    if (isProd) {
      console.error('[WhatsApp Webhook] WHATSAPP_APP_SECRET is required in production');
      return res.status(503).send('Webhook signature verification not configured');
    }
    console.warn('[WhatsApp Webhook] WHATSAPP_APP_SECRET not set — skipping signature check (dev only)');
    return next();
  }

  const header = req.headers['x-hub-signature-256'];
  if (!header || typeof header !== 'string') {
    console.warn('[WhatsApp Webhook] Missing X-Hub-Signature-256');
    return res.status(401).send('Missing signature');
  }

  const raw = req.rawBody;
  if (!raw || !Buffer.isBuffer(raw)) {
    console.error('[WhatsApp Webhook] rawBody missing — ensure express.json verify hook is configured');
    return res.status(500).send('Server misconfigured for signature verification');
  }

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (!timingSafeEqualStr(header, expected)) {
    console.warn('[WhatsApp Webhook] Invalid signature');
    return res.status(401).send('Invalid signature');
  }

  return next();
}

module.exports = { verifyWhatsAppSignature, getAppSecret };
