/**
 * External Webhook Routes — Zapier / Make / Fiverr / Upwork integration.
 *
 * These endpoints are PUBLIC (called by external automation platforms).
 * Protect them with a shared webhook secret (WEBHOOK_SECRET env var).
 *
 * POST /api/webhook/order
 *   { source: 'fiverr'|'upwork'|'zapier', clientEmail, clientName, serviceType, requirements, budget, deadline }
 *   → Creates a lead + campaign record, returns confirmation.
 *
 * POST /api/webhook/inbound
 *   { channel: 'whatsapp'|'email'|'sms', from, body, externalId }
 *   → Creates/updates a conversation and appends an inbound message.
 */

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const leadStorage = require('../utils/leadStorage');
const conversationStorage = require('../utils/conversationStorage');
const campaignStorage = require('../utils/campaignStorage');
const { webhookWorkspaceId } = require('../utils/workspaceContext');

function configuredWebhookSecret() {
  return (process.env.WEBHOOK_SECRET || '').trim();
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyWebhookSecret(req, res, next) {
  const expected = configuredWebhookSecret();
  if (!expected) {
    console.error('[Webhook] WEBHOOK_SECRET is not configured — rejecting request');
    return res.status(503).json({ error: 'Webhook verification not configured' });
  }
  const provided = req.headers['x-webhook-secret'];
  if (!provided || !timingSafeEqualStr(provided, expected)) {
    return res.status(401).json({ error: 'Invalid webhook secret.' });
  }
  next();
}

// POST /api/webhook/order
router.post('/order', verifyWebhookSecret, async (req, res) => {
  try {
    const {
      source = 'unknown',
      clientEmail,
      clientName,
      clientPhone,
      serviceType,
      requirements,
      budget,
      deadline,
      workspaceId: bodyWorkspaceId,
    } = req.body || {};

    const workspaceId = webhookWorkspaceId(bodyWorkspaceId);

    if (!clientEmail) {
      return res.status(400).json({ error: 'clientEmail is required.' });
    }

    // Create a lead from the order
    const leadId = `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const lead = {
      id: leadId,
      name: clientName || clientEmail.split('@')[0],
      email: clientEmail,
      phone: clientPhone || null,
      niche: serviceType || 'Service',
      source: `webhook:${source}`,
      workspaceId,
      createdAt: new Date().toISOString(),
      data: {
        requirements: requirements || '',
        budget: budget || '',
        deadline: deadline || '',
        sourcePlatform: source,
      },
    };

    await leadStorage.addLeads([lead], { workspaceId });

    // Initialize a campaign record for tracking
    try {
      await campaignStorage.getOrCreate({ leadId, workspaceId });
    } catch {
      // Campaign storage may not exist in all driver modes; ignore
    }

    console.log(`[Webhook] Order from ${source} recorded for ${clientEmail} (lead ${leadId})`);

    res.json({
      success: true,
      message: 'Order received and lead created.',
      leadId,
      source,
      workspaceId,
    });
  } catch (err) {
    console.error('[Webhook] Order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/webhook/inbound
router.post('/inbound', verifyWebhookSecret, async (req, res) => {
  try {
    const {
      channel = 'whatsapp',
      from,
      body,
      externalId,
      workspaceId: bodyWorkspaceId,
    } = req.body || {};

    const workspaceId = webhookWorkspaceId(bodyWorkspaceId);

    if (!from || !body) {
      return res.status(400).json({ error: 'from and body are required.' });
    }

    // Find or create a lead by phone/email
    let leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
    let lead = leads.find((l) => (channel === 'email' ? l.email === from : l.phone === from));

    if (!lead) {
      const leadId = `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      lead = {
        id: leadId,
        name: from,
        [channel === 'email' ? 'email' : 'phone']: from,
        source: `webhook:inbound:${channel}`,
        workspaceId,
        createdAt: new Date().toISOString(),
        data: {},
      };
      await leadStorage.addLeads([lead], { workspaceId });
    }

    // Find or create conversation
    let conversation = await conversationStorage.findConversation({
      workspaceId,
      leadId: lead.id,
      channel,
    });

    if (!conversation) {
      conversation = await conversationStorage.createConversation(
        { leadId: lead.id, channel, subject: null },
        { workspaceId }
      );
    }

    const message = await conversationStorage.addMessage(
      conversation.id,
      {
        direction: 'inbound',
        channel,
        body: String(body),
        source: 'webhook',
      },
      { workspaceId }
    );

    res.json({
      success: true,
      message: 'Inbound message recorded.',
      conversationId: conversation.id,
      messageId: message.id,
      leadId: lead.id,
    });
  } catch (err) {
    console.error('[Webhook] Inbound error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
