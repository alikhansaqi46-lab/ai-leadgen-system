/**
 * SMS Routes — Twilio-powered messaging via the Unified Integration Framework.
 *
 * Endpoints:
 *   POST /api/sms/send              → send single SMS
 *   POST /api/sms/send-bulk         → bulk SMS with rate-limiting
 *   GET  /api/sms/status            → configuration status
 *   POST /api/sms/webhook           → Twilio inbound SMS
 *   POST /api/sms/status-callback   → Twilio delivery status updates
 *
 * Credentials come exclusively from integrationStorage (no env fallback for
 * runtime sends). The Settings → Integrations → SMS → Connect flow stores them.
 */

const express = require('express');
const router = express.Router();
const integrationStorage = require('../utils/integrationStorage');
const leadStorage = require('../utils/leadStorage');
const unifiedSend = require('../services/unifiedSend');
const conversationStorage = require('../utils/conversationStorage');
const campaignStorage = require('../utils/campaignStorage');
const timelineStorage = require('../utils/timelineStorage');
const { sendSms, isSmsConfigured } = require('../services/smsService');
const contactStorage = require('../utils/contactStorage');

const { workspaceOf } = require('../utils/workspaceContext');

function formatPhoneNumber(phone) {
  if (!phone || phone === 'N/A') return '';
  const digits = (phone + '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('1') && digits.length === 11
    ? `+${digits}`
    : digits.length === 10
      ? `+1${digits}`
      : `+${digits}`;
}

// =====================================================================
// Status
// =====================================================================
router.get('/status', (req, res) => {
  const workspaceId = workspaceOf(req);
  const configured = isSmsConfigured(workspaceId);
  const stored = integrationStorage.get(workspaceId, 'sms');
  res.json({
    configured,
    account: stored?.account || null,
    phoneNumber: stored?.credentials?.phoneNumber || null,
    connected: configured,
  });
});

// =====================================================================
// Send single SMS
// =====================================================================
router.post('/send', async (req, res) => {
  try {
    const { leadId, phone, message, testMode = false, imageUrl } = req.body;
    const workspaceId = workspaceOf(req);

    if (!testMode && !isSmsConfigured(workspaceId)) {
      return res.status(503).json({ error: 'SMS not configured', setupRequired: true });
    }

    if (!message) {
      return res.status(400).json({ error: 'Message body is required' });
    }

    // Resolve phone
    let toPhone = phone;
    let lead = null;
    if (leadId) {
      const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
      lead = leads.find((l) => l.id === leadId);
      if (lead && lead.phone && lead.phone !== 'N/A') {
        toPhone = lead.phone;
      }
    } else if (phone) {
      lead = await contactStorage.findLeadByContact({ workspaceId, channel: 'sms', value: phone });
    }

    const formattedTo = formatPhoneNumber(toPhone);
    if (!formattedTo) {
      return res.status(400).json({ error: 'Valid phone number is required' });
    }

    const providerSend = async () => {
      return sendSms({
        to: formattedTo,
        body: message,
        workspaceId,
        statusCallback: `${process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5001}`}/api/sms/status-callback`,
        testMode,
        mediaUrl: imageUrl || undefined,
      });
    };

    let result;
    if (lead) {
      result = await unifiedSend.send({
        leadId: lead.id,
        channel: 'sms',
        body: message,
        providerSend,
        metadata: { testMode, imageUrl },
        scheduleFollowUps: !testMode,
        workspaceId,
      });
    } else {
      result = await providerSend();
    }

    res.json({
      success: true,
      message: testMode ? '🧪 TEST: SMS would be sent' : `SMS sent to ${formattedTo}`,
      messageId: result.messageId,
      status: result.status || 'sent',
      testMode: result.testMode || false,
      conversationId: result.conversationId || null,
    });
  } catch (error) {
    console.error('[SMS] send error:', error.message);
    res.status(500).json({ error: 'Failed to send SMS', message: error.message });
  }
});

// =====================================================================
// Send bulk SMS
// =====================================================================
router.post('/send-bulk', async (req, res) => {
  try {
    const { leads, message, testMode = false, delayMs = 1000, imageUrl } = req.body;
    const workspaceId = workspaceOf(req);

    if (!testMode && !isSmsConfigured(workspaceId)) {
      return res.status(503).json({ error: 'SMS not configured', setupRequired: true });
    }

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'Leads array is required' });
    }

    const MAX_BATCH = 50;
    if (leads.length > MAX_BATCH) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH} messages per batch` });
    }

    const results = [];
    const failed = [];
    let sentCount = 0;

    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      const phone = lead.phone || lead.phoneNumber;
      if (!phone || phone === 'N/A' || phone === 'Not Available') {
        results.push({ leadId: lead.id, name: lead.name, status: 'failed', error: 'No phone number' });
        failed.push(lead);
        continue;
      }

      const formattedTo = formatPhoneNumber(phone);
      let success = false;
      let lastError = null;
      let result = null;

      try {
        const providerSend = async () => {
          return sendSms({
            to: formattedTo,
            body: message,
            workspaceId,
            statusCallback: `${process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5001}`}/api/sms/status-callback`,
            testMode,
            mediaUrl: imageUrl || undefined,
          });
        };

        let body = message;
        body = body
          .replace(/{name}/g, lead.name || 'there')
          .replace(/{city}/g, lead.city || '')
          .replace(/{niche}/g, lead.niche || lead.business || 'business')
          .replace(/{company}/g, lead.company || lead.companyName || 'our company')
          .replace(/{product}/g, lead.product || 'our services');

        if (lead.id) {
          const usResult = await unifiedSend.send({
            leadId: lead.id,
            channel: 'sms',
            body,
            providerSend,
            metadata: { testMode, imageUrl },
            scheduleFollowUps: false,
            workspaceId,
          });
          result = usResult;
        } else {
          result = await providerSend();
        }

        success = true;
      } catch (error) {
        lastError = error;
        console.error(`[SMS] Failed to ${formattedTo}:`, error.message);
      }

      if (success) {
        results.push({ leadId: lead.id, name: lead.name, phone: formattedTo, status: 'sent', messageId: result.messageId });
        sentCount++;
      } else {
        results.push({ leadId: lead.id, name: lead.name, status: 'failed', error: lastError?.message || 'Unknown error' });
        failed.push({ ...lead, error: lastError?.message });
      }

      if (i < leads.length - 1) {
        const actualDelay = testMode ? Math.min(delayMs, 500) : delayMs;
        await new Promise((r) => setTimeout(r, actualDelay));
      }
    }

    res.json({
      success: sentCount > 0,
      total: leads.length,
      sent: sentCount,
      failed: failed.length,
      skipped: leads.length - sentCount - failed.length,
      testMode,
      results,
    });
  } catch (error) {
    console.error('[SMS] bulk send error:', error.message);
    res.status(500).json({ error: 'Bulk send failed', message: error.message });
  }
});

// =====================================================================
// Twilio inbound SMS webhook
// =====================================================================
function normalizeSmsDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/** Resolve workspace for inbound Twilio SMS from the destination number. */
function resolveSmsWorkspaceId(twilioTo) {
  const digits = normalizeSmsDigits(twilioTo);
  if (digits) {
    const matched = integrationStorage.findWorkspaceByCredential('sms', (creds) => {
      const stored = normalizeSmsDigits(creds.phoneNumber || creds.from || '');
      return stored && (stored === digits || stored.endsWith(digits) || digits.endsWith(stored));
    });
    if (matched) return matched;
  }
  return process.env.DEFAULT_WORKSPACE_ID || 'default';
}

// =====================================================================
// Twilio inbound SMS webhook
// =====================================================================
router.post('/webhook', async (req, res) => {
  res.status(200).send('<Response/>');

  try {
    const from = req.body.From;
    const to = req.body.To;
    const body = req.body.Body || '';
    const messageSid = req.body.MessageSid;
    const workspaceId = resolveSmsWorkspaceId(to);

    if (!from || !body) return;

    const normalizedPhone = formatPhoneNumber(from);
    const lead = await contactStorage.findLeadByContact({ workspaceId, channel: 'sms', value: normalizedPhone })
      || await leadStorage.findByPhone(normalizedPhone, { workspaceId });
    const leadId = lead ? lead.id : `orphan_${normalizedPhone}`;

    // Update CRM
    if (lead) {
      await campaignStorage.recordReply(leadId, { workspaceId, channel: 'sms', messageText: body });
      await campaignStorage.cancelFollowUps(leadId, { workspaceId });
    }

    // Find/create conversation
    let conv = await conversationStorage.findConversation({ workspaceId, leadId, channel: 'sms' });
    if (!conv) {
      conv = await conversationStorage.createConversation(
        { leadId, channel: 'sms', status: 'open', subject: lead ? `SMS with ${lead.name}` : 'SMS conversation' },
        { workspaceId }
      );
    }

    // Store inbound message
    await conversationStorage.addMessage(
      conv.id,
      { direction: 'inbound', body, channel: 'sms', source: 'webhook', externalMessageId: messageSid },
      { workspaceId }
    );

    // Timeline event
    await timelineStorage.recordEvent({
      leadId,
      workspaceId,
      type: 'message_received',
      channel: 'sms',
      conversationId: conv.id,
      referenceId: messageSid,
      payload: { body: body.slice(0, 200), from: normalizedPhone, to },
    });

    console.log(`[SMS Webhook] Inbound from ${normalizedPhone}: "${body.slice(0, 80)}"`);
  } catch (error) {
    console.error('[SMS Webhook] processing error:', error.message);
  }
});

// =====================================================================
// Twilio delivery status callback
// =====================================================================
router.post('/status-callback', async (req, res) => {
  res.status(200).send('OK');

  try {
    const messageSid = req.body.MessageSid;
    const messageStatus = req.body.MessageStatus;
    const errorCode = req.body.ErrorCode || null;
    const workspaceId = resolveSmsWorkspaceId(req.body.To || req.body.From);

    if (!messageSid) return;

    // Update message status in conversation thread
    try {
      const mapped =
        messageStatus === 'delivered' || messageStatus === 'read' || messageStatus === 'sent'
          ? messageStatus
          : messageStatus === 'failed' || messageStatus === 'undelivered'
            ? messageStatus
            : messageStatus;
      const updated = await conversationStorage.updateMessageStatusByExternalId(messageSid, mapped, { workspaceId });
      if (updated && (mapped === 'delivered' || mapped === 'read') && updated.leadId) {
        await timelineStorage.recordEvent({
          leadId: updated.leadId,
          type: mapped === 'read' ? 'message_read' : 'message_delivered',
          channel: 'sms',
          conversationId: updated.conversationId,
          referenceId: messageSid,
          payload: { status: mapped, errorCode },
        }, { workspaceId }).catch(() => null);
      }
    } catch (err) {
      console.warn('[SMS Status] Could not update message status:', err.message);
    }

    // Record failure in timeline if applicable
    if (messageStatus === 'failed' || messageStatus === 'undelivered') {
      await timelineStorage.recordEvent({
        leadId: 'unknown',
        workspaceId,
        type: 'message_failed',
        channel: 'sms',
        referenceId: messageSid,
        payload: { status: messageStatus, errorCode },
      });
    }

    console.log(`[SMS Status] ${messageSid} → ${messageStatus}${errorCode ? ` (error ${errorCode})` : ''}`);
  } catch (error) {
    console.error('[SMS Status] error:', error.message);
  }
});

module.exports = router;
