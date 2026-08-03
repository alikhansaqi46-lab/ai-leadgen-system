/**
 * PayPal webhook signature verification via PayPal API.
 *
 * Uses POST /v1/notifications/verify-webhook-signature with transmission headers
 * and PAYPAL_WEBHOOK_ID from the PayPal developer dashboard.
 *
 * In production: missing config or INVALID → reject.
 * In development: missing config → warn and allow (so local billing UI still works).
 */

const axios = require('axios');

const PAYPAL_CLIENT_ID = () => process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = () => process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE = () => (process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');
const PAYPAL_WEBHOOK_ID = () => (process.env.PAYPAL_WEBHOOK_ID || '').trim();

async function getAccessToken() {
  const response = await axios.post(
    `${PAYPAL_BASE()}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: { username: PAYPAL_CLIENT_ID(), password: PAYPAL_CLIENT_SECRET() },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );
  return response.data.access_token;
}

/**
 * @param {object} req - Express request with parsed JSON body and PayPal headers
 * @returns {Promise<boolean>}
 */
async function verifyPayPalWebhook(req) {
  const webhookId = PAYPAL_WEBHOOK_ID();
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

  if (!webhookId || !PAYPAL_CLIENT_ID() || !PAYPAL_CLIENT_SECRET()) {
    if (isProd) {
      console.error('[PayPal Webhook] PAYPAL_WEBHOOK_ID / client credentials required in production');
      return false;
    }
    console.warn('[PayPal Webhook] Verification not configured — skipping (dev only)');
    return true;
  }

  const transmissionId = req.headers['paypal-transmission-id'];
  const transmissionTime = req.headers['paypal-transmission-time'];
  const certUrl = req.headers['paypal-cert-url'];
  const authAlgo = req.headers['paypal-auth-algo'];
  const transmissionSig = req.headers['paypal-transmission-sig'];

  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    console.warn('[PayPal Webhook] Missing PayPal transmission headers');
    return false;
  }

  const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!event || typeof event !== 'object') {
    console.warn('[PayPal Webhook] Missing event body');
    return false;
  }

  const token = await getAccessToken();
  const verifyRes = await axios.post(
    `${PAYPAL_BASE()}/v1/notifications/verify-webhook-signature`,
    {
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: webhookId,
      webhook_event: event,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const status = verifyRes.data?.verification_status;
  if (status !== 'SUCCESS') {
    console.warn('[PayPal Webhook] verification_status=', status);
    return false;
  }
  return true;
}

module.exports = { verifyPayPalWebhook };
