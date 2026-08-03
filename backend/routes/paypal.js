/**
 * PayPal Subscription Routes
 * POST /api/paypal/create-subscription  → create a PayPal subscription for a plan
 * POST /api/paypal/webhook             → receive PayPal webhook events
 * GET  /api/paypal/subscription-status → get current user subscription
 * POST /api/paypal/cancel-subscription → cancel active subscription
 *
 * Environment:
 *   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_BASE_URL
 *   PAYPAL_PLAN_STARTER, PAYPAL_PLAN_PRO, PAYPAL_PLAN_AGENCY (plan IDs from PayPal dashboard)
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const userStorage = require('../utils/userStorage');

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE = (process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');

const PLAN_IDS = {
  starter: process.env.PAYPAL_PLAN_STARTER || '',
  pro: process.env.PAYPAL_PLAN_PRO || '',
  agency: process.env.PAYPAL_PLAN_AGENCY || '',
};

/* ---------------- helpers ---------------- */

async function getPayPalAccessToken() {
  const response = await axios.post(
    `${PAYPAL_BASE}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: { username: PAYPAL_CLIENT_ID, password: PAYPAL_CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );
  return response.data.access_token;
}

function getBearer(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'];
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim();
}

/* ---------------- public routes ---------------- */

router.get('/plans', async (req, res) => {
  try {
    const plans = [
      { key: 'starter', name: 'Starter', price: '$20/month', planId: PLAN_IDS.starter, features: ['500 leads/month', 'WhatsApp outreach', 'Email campaigns', 'Basic analytics'] },
      { key: 'pro', name: 'Pro', price: '$50/month', planId: PLAN_IDS.pro, features: ['2,000 leads/month', 'All Starter features', 'AI message generation', 'Multi-channel inbox', 'CSV exports'] },
      { key: 'agency', name: 'Agency', price: '$100/month', planId: PLAN_IDS.agency, features: ['Unlimited leads', 'All Pro features', 'White-label reports', 'Priority support', 'Sub-accounts'] },
    ];
    res.json({ success: true, plans });
  } catch (err) {
    console.error('[PayPal] Plans error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/create-subscription', async (req, res) => {
  try {
    const { planKey, userId, email } = req.body;
    if (!planKey || !PLAN_IDS[planKey]) {
      return res.status(400).json({ error: 'Invalid plan key.' });
    }
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
      return res.status(503).json({ error: 'PayPal is not configured on the server.' });
    }

    const token = await getPayPalAccessToken();
    const planId = PLAN_IDS[planKey];

    const response = await axios.post(
      `${PAYPAL_BASE}/v1/billing/subscriptions`,
      {
        plan_id: planId,
        subscriber: { email_address: email || '' },
        application_context: {
          brand_name: 'LeadFlow AI',
          locale: 'en-US',
          user_action: 'SUBSCRIBE_NOW',
          return_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/app/settings?subscription=success`,
          cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/pricing?canceled=1`,
        },
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      }
    );

    const subscriptionId = response.data.id;
    const approvalUrl = response.data.links.find((l) => l.rel === 'approve')?.href;

    // Pre-associate the subscription with the user so the webhook can confirm it later
    if (userId) {
      await userStorage.setSubscription(userId, {
        subscription_status: 'pending',
        subscription_plan: planKey,
        subscription_id: subscriptionId,
      });
    }

    res.json({ success: true, subscriptionId, approvalUrl });
  } catch (err) {
    console.error('[PayPal] Create subscription error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create PayPal subscription.' });
  }
});

/* ---------------- webhook (public, signature-verified) ---------------- */

router.post('/webhook', async (req, res) => {
  try {
    const { verifyPayPalWebhook } = require('../middleware/paypalWebhook');
    const valid = await verifyPayPalWebhook(req);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid PayPal webhook signature' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    console.log('[PayPal Webhook]', body.event_type, body.resource?.id);

    const resource = body.resource || {};
    const subscriptionId = resource.id;
    const status = resource.status; // ACTIVE, CANCELLED, SUSPENDED, EXPIRED

    let adminAudit = null;
    try { adminAudit = require('../utils/adminAudit'); } catch (_) { /* optional */ }

    function amountFromPayPalResource(res) {
      const candidates = [
        res?.billing_info?.last_payment?.amount?.value,
        res?.amount?.value,
        res?.amount?.total,
        res?.plan?.payment_definitions?.[0]?.amount?.value,
      ];
      for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n) && n > 0) return n;
      }
      return null;
    }

    if (body.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED' || body.event_type === 'BILLING.SUBSCRIPTION.CREATED') {
      const user = await userStorage.findBySubscriptionId(subscriptionId);
      if (user) {
        await userStorage.setSubscription(user.id, {
          subscription_status: 'active',
          subscription_plan: user.subscription_plan || 'starter',
          subscription_id: subscriptionId,
          subscription_expires_at: resource.billing_info?.next_billing_time || null,
        });
        console.log('[PayPal] Subscription activated for user:', user.email);
        if (adminAudit) {
          const plan = user.subscription_plan || 'starter';
          const amount = amountFromPayPalResource(resource);
          await adminAudit.recordPaymentEvent({
            userId: user.id,
            email: user.email,
            eventType: body.event_type,
            planKey: plan,
            amount: amount != null ? amount : 0,
            status: 'completed',
            externalId: subscriptionId,
            raw: { event: body.event_type, amountSource: amount != null ? 'paypal_resource' : 'missing' },
          }).catch(() => null);
        }
      }
    }

    if (body.event_type === 'BILLING.SUBSCRIPTION.CANCELLED' || body.event_type === 'BILLING.SUBSCRIPTION.SUSPENDED' || body.event_type === 'BILLING.SUBSCRIPTION.EXPIRED') {
      const user = await userStorage.findBySubscriptionId(subscriptionId);
      if (user) {
        await userStorage.setSubscription(user.id, {
          subscription_status: status === 'CANCELLED' ? 'cancelled' : 'past_due',
          subscription_id: subscriptionId,
        });
        console.log('[PayPal] Subscription cancelled for user:', user.email);
        if (adminAudit) {
          await adminAudit.recordPaymentEvent({
            userId: user.id,
            email: user.email,
            eventType: body.event_type,
            planKey: user.subscription_plan,
            amount: 0,
            status: status === 'CANCELLED' ? 'cancelled' : 'past_due',
            externalId: subscriptionId,
          }).catch(() => null);
        }
      }
    }

    if (body.event_type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
      const user = await userStorage.findBySubscriptionId(subscriptionId);
      if (user) {
        await userStorage.setSubscription(user.id, {
          subscription_status: 'past_due',
          subscription_id: subscriptionId,
        });
        if (adminAudit) {
          await adminAudit.recordPaymentEvent({
            userId: user.id,
            email: user.email,
            eventType: body.event_type,
            planKey: user.subscription_plan,
            amount: 0,
            status: 'failed',
            externalId: subscriptionId,
          }).catch(() => null);
          await adminAudit.pushNotification({
            severity: 'critical',
            category: 'billing',
            title: `Payment failed: ${user.email}`,
            body: `Subscription ${subscriptionId}`,
            source: 'paypal',
          }).catch(() => null);
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('[PayPal Webhook] Error:', err.response?.data || err.message);
    // Return 500 so PayPal retries on transient failures; signature failures already 401
    res.sendStatus(500);
  }
});

/* ---------------- protected routes ---------------- */

router.get('/subscription-status', async (req, res) => {
  try {
    const token = getBearer(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const { verifyToken } = require('../services/authService');
    const payload = verifyToken(token);
    const user = await userStorage.findById(payload.sub);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    res.json({
      success: true,
      status: user.subscription_status || 'none',
      plan: user.subscription_plan || null,
      expiresAt: user.subscription_expires_at || null,
    });
  } catch (err) {
    console.error('[PayPal] Status error:', err.message);
    res.status(401).json({ error: 'Invalid token.' });
  }
});

router.post('/cancel-subscription', async (req, res) => {
  try {
    const token = getBearer(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const { verifyToken } = require('../services/authService');
    const payload = verifyToken(token);
    const user = await userStorage.findById(payload.sub);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const subId = user.subscription_id;
    if (!subId) return res.status(400).json({ error: 'No active subscription.' });

    if (PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET) {
      const accessToken = await getPayPalAccessToken();
      await axios.post(
        `${PAYPAL_BASE}/v1/billing/subscriptions/${subId}/cancel`,
        { reason: 'User requested cancellation' },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );
    }

    await userStorage.setSubscription(user.id, { subscription_status: 'cancelled', subscription_id: subId });
    res.json({ success: true, message: 'Subscription cancelled.' });
  } catch (err) {
    console.error('[PayPal] Cancel error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to cancel subscription.' });
  }
});

module.exports = router;
