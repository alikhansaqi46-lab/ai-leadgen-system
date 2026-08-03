/**
 * WhatsApp CRM Campaign Routes (S6).
 *
 * Endpoints:
 *   GET  /api/campaign/stats              → analytics summary
 *   GET  /api/campaign/leads              → all campaign records (with lead join)
 *   POST /api/campaign/status             → update lead status { leadId, status }
 *   POST /api/campaign/sent              → record message sent { leadId }
 *   POST /api/campaign/reply             → record reply received { leadId, body }
 *   POST /api/campaign/follow-ups        → schedule follow-ups { leadId, days1, days2 }
 *   POST /api/campaign/follow-up/cancel  → cancel follow-ups { leadId }
 *   GET  /api/campaign/overdue           → leads needing follow-up
 *
 * Test mode architecture:
 *   All endpoints accept testMode flag. When testMode=true, records are tagged
 *   separately so they don't pollute live campaign analytics.
 */

const express = require('express');
const router = express.Router();
const campaignStorage = require('../utils/campaignStorage');
const conversationStorage = require('../utils/conversationStorage');
const leadStorage = require('../utils/leadStorage');
const followUpStorage = require('../utils/followUpStorage');
const userStorage = require('../utils/userStorage');
const unifiedSend = require('../services/unifiedSend');
const personalContactStorage = require('../utils/personalContactStorage');
const whatsappTransport = require('../services/whatsappTransport');

// Start Campaign orchestrator (POST /api/campaign/start)
router.use(require('./campaignStart'));

const { workspaceOf } = require('../utils/workspaceContext');

const campaignBulkSender = require('../services/campaign/bulk/campaignBulkSender');
const {
  isContactRecipient: isPersonalContactRecipient,
  contactConversationId,
  contactAsRecipient,
  executeWhatsAppRecipient,
} = require('../services/campaign/bulk/recipientExecutor');

async function recordContactConversation({ workspaceId, contact, recipient, channel, body, subject, sendResult, imageUrl }) {
  const leadId = contactConversationId(contact.id);
  let conv = await conversationStorage.findConversation({ workspaceId, leadId, channel });
  if (!conv) {
    conv = await conversationStorage.createConversation({
      leadId,
      channel,
      status: 'open',
      subject: subject || `${channel.toUpperCase()} with ${contact.name || contact.email || contact.whatsappNumber || contact.smsNumber || 'Contact'}`,
    }, { workspaceId });
  }
  const message = await conversationStorage.addMessage(conv.id, {
    direction: 'outbound',
    body,
    channel,
    source: 'contact_campaign',
    status: 'sent',
    externalMessageId: sendResult?.messageId || null,
    messageType: channel === 'email' ? 'email' : 'text',
    metadata: {
      entityType: 'contact',
      contactId: contact.id,
      contact,
      subject: sendResult?.subject || subject || null,
      html: sendResult?.displayHtml || sendResult?.html || null,
      isInitialCampaign: true,
      messageId: sendResult?.messageId || null,
      rfcMessageId: sendResult?.rfcMessageId || null,
      gmailThreadId: sendResult?.gmailThreadId || null,
      recipientEmail: sendResult?.recipientEmail || personalContactStorage.resolveDeliveryEmail(contact) || contact.email || null,
      imageUrl: imageUrl || null,
      attachments: imageUrl ? [{ type: 'image', url: imageUrl, disposition: channel === 'email' ? 'inline' : 'media' }] : [],
      campaign: {
        source: 'contact_campaign',
        channel,
        subject: sendResult?.subject || subject || null,
        recipientId: recipient?.id || null,
        contactId: contact.id,
        sentAt: new Date().toISOString(),
      },
    },
  }, { workspaceId });
  return { conversationId: conv.id, messageId: sendResult?.messageId || message.id, rfcMessageId: sendResult?.rfcMessageId || null, gmailThreadId: sendResult?.gmailThreadId || null, html: sendResult?.html, displayHtml: sendResult?.displayHtml, subject: sendResult?.subject || subject };
}

/** Helper: get lead details for a campaign record. */
async function enrichCampaign(record, workspaceId) {
  if (!record) return null;
  try {
    const leads = await leadStorage.getLeads({ workspaceId, limit: 1 });
    const lead = leads.find((l) => l.id === record.leadId);
    return { ...record, lead: lead || null };
  } catch {
    return { ...record, lead: null };
  }
}

/** GET /api/campaign/stats — Analytics summary. */
router.get('/stats', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const stats = await campaignStorage.getAnalytics({ workspaceId });
    const defaults = {
      total: 0, sent: 0, replied: 0, interested: 0, meeting: 0, deal: 0, lost: 0,
      messagesSent: 0, repliesReceived: 0, followUpsPending: 0,
      byStatus: { new: 0, sent: 0, replied: 0, interested: 0, meeting: 0, deal: 0, lost: 0 },
      channels: { email: { sent: 0, replies: 0 }, whatsapp: { sent: 0, replies: 0 }, sms: { sent: 0, replies: 0 } },
    };
    res.json({ success: true, stats: { ...defaults, ...stats, byStatus: { ...defaults.byStatus, ...(stats.byStatus || {}) }, channels: { ...defaults.channels, ...(stats.channels || {}) } } });
  } catch (error) {
    console.error('[Campaign] stats error:', error.message);
    res.json({
      success: false,
      stats: {
        total: 0, sent: 0, replied: 0, interested: 0, meeting: 0, deal: 0, lost: 0,
        messagesSent: 0, repliesReceived: 0, followUpsPending: 0,
        byStatus: { new: 0, sent: 0, replied: 0, interested: 0, meeting: 0, deal: 0, lost: 0 },
        channels: { email: { sent: 0, replies: 0 }, whatsapp: { sent: 0, replies: 0 }, sms: { sent: 0, replies: 0 } },
      },
      error: error.message,
    });
  }
});

/** GET /api/campaign/channel-stats — Per-channel message counts (sent / replies). */
router.get('/channel-stats', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const counts = await conversationStorage.getMessageCountsByChannel({ workspaceId });
    res.json({ success: true, counts });
  } catch (error) {
    console.error('[Campaign] channel-stats error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/campaign/leads — All campaign records with lead data. */
router.get('/leads', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const records = await campaignStorage.getAll({ workspaceId });
    const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
    const leadMap = new Map(leads.map((l) => [l.id, l]));
    const enriched = records.map((r) => ({ ...r, lead: leadMap.get(r.leadId) || null }));
    res.json({ success: true, campaigns: enriched, count: enriched.length });
  } catch (error) {
    console.error('[Campaign] leads error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/campaign/status — Update lead status. */
router.post('/status', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const { leadId, status, revenue } = req.body || {};
    if (!leadId || !status) {
      return res.status(400).json({ error: 'leadId and status are required' });
    }
    const valid = ['new', 'sent', 'replied', 'interested', 'meeting', 'deal', 'lost'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${valid.join(', ')}` });
    }
    const record = await campaignStorage.updateStatus(leadId, status, { workspaceId, revenue });
    if (!record) {
      return res.status(404).json({ error: 'Failed to update campaign status' });
    }

    // Auto-cancel follow-ups when lead replies or becomes deal/lost
    if (['replied', 'deal', 'lost'].includes(status)) {
      await campaignStorage.cancelFollowUps(leadId, { workspaceId });
    }

    // Create/update conversation for interested/meeting/deal
    if (['interested', 'meeting', 'deal'].includes(status)) {
      const existing = await conversationStorage.findConversation({ workspaceId, leadId, channel: 'whatsapp' });
      if (!existing) {
        await conversationStorage.createConversation({ leadId, channel: 'whatsapp', status: 'open', subject: `WhatsApp with ${status}` }, { workspaceId });
      }
    }

    let handover = null;
    if (status === 'deal') {
      try {
        const { buildHandoverPackage } = require('../services/handoverPackage');
        handover = await buildHandoverPackage(leadId, { workspaceId });
        const timelineStorage = require('../utils/timelineStorage');
        await timelineStorage.recordEvent({
          leadId,
          type: 'ai_action',
          payload: { action: 'handover_package_ready', generatedAt: handover.generatedAt },
        }, { workspaceId }).catch(() => null);
      } catch (err) {
        console.error('[Campaign] handover package failed (non-fatal):', err.message);
      }
    }

    // Silent Owner Intelligence — never surfaces to customer UI
    if (['deal', 'meeting', 'replied', 'interested'].includes(status)) {
      try {
        const ownerIntelligence = require('../services/ownerIntelligence');
        setImmediate(() => {
          ownerIntelligence.scanAndNotify()
            .then((r) => {
              if (r?.created > 0) console.log(`[OwnerIntelligence] event-driven created ${r.created}`);
            })
            .catch((err) => console.warn('[OwnerIntelligence] event-driven scan:', err.message));
        });
      } catch (_) { /* ignore */ }
    }

    res.json({ success: true, campaign: record, handover });
  } catch (error) {
    console.error('[Campaign] status error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/campaign/handover/:leadId — Customer handover package (real CRM snapshot). */
router.get('/handover/:leadId', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const { buildHandoverPackage } = require('../services/handoverPackage');
    const handover = await buildHandoverPackage(req.params.leadId, { workspaceId });
    res.json({ success: true, handover });
  } catch (error) {
    console.error('[Campaign] handover error:', error.message);
    const status = /not found/i.test(error.message) ? 404 : 500;
    res.status(status).json({ error: error.message });
  }
});

/** POST /api/campaign/sent — Record a message was sent to a lead. */
router.post('/sent', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const { leadId, testMode = false } = req.body || {};
    if (!leadId) return res.status(400).json({ error: 'leadId is required' });
    const record = await campaignStorage.recordSent(leadId, { workspaceId, testMode });
    // Schedule follow-ups automatically on first send
    if (record.messageCount === 1) {
      await campaignStorage.scheduleFollowUps(leadId, { days1: 2, days2: 5 }, { workspaceId });
    }
    res.json({ success: true, campaign: record });
  } catch (error) {
    console.error('[Campaign] sent error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/campaign/reply — Record a reply was received from a lead. */
router.post('/reply', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const { leadId, body, channel = 'whatsapp', testMode = false } = req.body || {};
    if (!leadId) return res.status(400).json({ error: 'leadId is required' });
    const record = await campaignStorage.recordReply(leadId, { workspaceId, testMode, channel });

    // Add message to conversation if one exists (use actual channel, not hardcoded whatsapp)
    const conv = await conversationStorage.findConversation({ workspaceId, leadId, channel });
    const msgType = channel === 'email' ? 'email' : 'text';
    if (conv) {
      await conversationStorage.addMessage(conv.id, { direction: 'inbound', body: body || 'Lead replied', channel, source: 'webhook', messageType: msgType }, { workspaceId });
    } else {
      // Create conversation and add message
      const newConv = await conversationStorage.createConversation({ leadId, channel, status: 'open' }, { workspaceId });
      await conversationStorage.addMessage(newConv.id, { direction: 'inbound', body: body || 'Lead replied', channel, source: 'webhook', messageType: msgType }, { workspaceId });
    }

    // Cancel follow-ups since lead replied
    await campaignStorage.cancelFollowUps(leadId, { workspaceId });

    res.json({ success: true, campaign: record });
  } catch (error) {
    console.error('[Campaign] reply error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/campaign/follow-ups — Schedule follow-ups. */
router.post('/follow-ups', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const { leadId, days1 = 2, days2 = 5 } = req.body || {};
    if (!leadId) return res.status(400).json({ error: 'leadId is required' });
    const record = await campaignStorage.scheduleFollowUps(leadId, { days1, days2 }, { workspaceId });
    res.json({ success: true, campaign: record });
  } catch (error) {
    console.error('[Campaign] follow-ups error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/campaign/follow-up/cancel — Cancel follow-ups. */
router.post('/follow-up/cancel', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const { leadId } = req.body || {};
    if (!leadId) return res.status(400).json({ error: 'leadId is required' });
    const record = await campaignStorage.cancelFollowUps(leadId, { workspaceId });
    res.json({ success: true, campaign: record });
  } catch (error) {
    console.error('[Campaign] follow-up/cancel error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/campaign/overdue — Leads needing follow-up. */
router.get('/overdue', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const overdue = await campaignStorage.getOverdueFollowUps({ workspaceId });
    res.json({ success: true, overdue, count: overdue.length });
  } catch (error) {
    console.error('[Campaign] overdue error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/campaign/conversations — All WhatsApp conversations with last message preview. */
router.get('/conversations', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const convs = await conversationStorage.getConversations({ workspaceId });
    const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
    const leadMap = new Map(leads.map((l) => [l.id, l]));
    const campaigns = await campaignStorage.getAll({ workspaceId });
    const campaignMap = new Map(campaigns.map((c) => [c.leadId, c]));

    const enriched = await Promise.all(convs.map(async (c) => {
      const messages = await conversationStorage.getMessages(c.id, { workspaceId });
      const lastMessage = messages[messages.length - 1];
      const campaign = campaignMap.get(c.leadId) || null;
      return {
        ...c,
        lead: leadMap.get(c.leadId) || null,
        messageCount: messages.length,
        lastMessage: lastMessage ? { body: lastMessage.body, direction: lastMessage.direction, createdAt: lastMessage.createdAt } : null,
        pipelineStatus: campaign?.status || 'new',
      };
    }));

    res.json({ success: true, conversations: enriched, count: enriched.length });
  } catch (error) {
    console.error('[Campaign] conversations error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/campaign/conversations/:id/messages — Full message thread. */
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const messages = await conversationStorage.getMessages(req.params.id, { workspaceId });
    res.json({ success: true, messages, count: messages.length });
  } catch (error) {
    console.error('[Campaign] messages error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/* ==================== TEST MODE ==================== */

const testModeStorage = require('../utils/testModeStorage');

/** GET /api/campaign/test-mode — Get current test mode status. */
router.get('/test-mode', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const record = await testModeStorage.get(workspaceId);
    res.json({
      success: true,
      testMode: {
        active: record.active,
        testNumber: record.testNumber,
        messagesUsed: record.messagesUsed,
        messagesLimit: record.messagesLimit,
        remaining: Math.max(0, record.messagesLimit - record.messagesUsed),
      },
    });
  } catch (error) {
    console.error('[Campaign] test-mode get error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/campaign/test-mode/number — Set test WhatsApp number. */
router.post('/test-mode/number', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const { testNumber } = req.body || {};
    if (!testNumber) return res.status(400).json({ error: 'testNumber is required' });
    console.log(`[Campaign] Setting test number for workspace ${workspaceId}: ${testNumber}`);
    const record = await testModeStorage.setNumber(workspaceId, testNumber);
    res.json({ success: true, testMode: record });
  } catch (error) {
    console.error('[Campaign] test-mode number error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/campaign/test-mode/send — Send a test message (uses test quota). */
router.post('/test-mode/send', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message is required' });

    const record = await testModeStorage.get(workspaceId);
    if (!record.active || !record.testNumber) {
      return res.status(400).json({ error: 'Test mode not active. Set a test number first.' });
    }

    // Check quota BEFORE sending (but don't consume yet)
    if (record.messagesUsed >= record.messagesLimit) {
      return res.status(429).json({ error: 'Test limit reached', remaining: 0 });
    }

    // Get WhatsApp session for this workspace
    const hasCredentials = whatsappTransport.isConfigured(workspaceId);
    console.log(`[Campaign] Test-mode send for workspace=${workspaceId} — connected=${hasCredentials}`);

    let result;
    if (hasCredentials) {
      console.log(`[Campaign] Sending REAL test message to ${record.testNumber}`);
      console.log(`[Campaign] Message: ${message.substring(0, 60)}...`);

      result = await whatsappTransport.sendText({
        workspaceId,
        to: record.testNumber,
        message,
        testMode: false,
      });
      console.log(`[Campaign] Test message sent successfully. Message ID: ${result.messageId}`);
    } else {
      return res.status(503).json({
        error: 'WhatsApp not configured',
        message: 'Configure Meta Cloud API credentials in WhatsApp Settings before sending test messages.',
        setupRequired: true,
      });
    }

    // Only consume quota AFTER successful send
    const quota = await testModeStorage.useMessage(workspaceId);
    if (!quota.ok) {
      console.error('[Campaign] Failed to consume quota after successful send:', quota.error);
    }

    res.json({
      success: true,
      message: 'Test message sent successfully',
      messageId: result.messageId,
      testNumber: record.testNumber,
      remaining: quota.remaining,
      sentAt: new Date().toISOString(),
      status: result.status,
    });
  } catch (error) {
    console.error('[Campaign] test-mode send error:', error.message);
    console.error('[Campaign] Full error details:', error);
    // Quota NOT consumed on error
    res.status(500).json({
      error: 'Failed to send test message',
      message: error.message
    });
  }
});

/** POST /api/campaign/test-mode/reset — Reset test message counter. */
router.post('/test-mode/reset', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const record = await testModeStorage.resetCounter(workspaceId);
    res.json({ success: true, testMode: record });
  } catch (error) {
    console.error('[Campaign] test-mode reset error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/campaign/test-mode/deactivate — Deactivate test mode. */
router.post('/test-mode/deactivate', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const record = await testModeStorage.deactivate(workspaceId);
    res.json({ success: true, testMode: record });
  } catch (error) {
    console.error('[Campaign] test-mode deactivate error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/campaign/follow-up/process-due — Send all overdue follow-ups. */
router.post('/follow-up/process-due', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    if (!whatsappTransport.isConfigured(workspaceId)) {
      return res.status(503).json({ error: 'WhatsApp not configured', message: 'Configure Meta Cloud API credentials in WhatsApp Settings first' });
    }

    const overdue = await campaignStorage.getOverdueFollowUps({ workspaceId });
    const results = [];

    for (const item of overdue) {
      try {
        const leadId = item.leadId;
        const lead = await leadStorage.getLeads({ workspaceId, limit: 10000 }).then((leads) => leads.find((l) => l.id === leadId));
        if (!lead || !lead.phone) {
          results.push({ leadId, status: 'skipped', reason: 'No phone number' });
          continue;
        }

        // Build personalized follow-up message
        const name = (lead.name || 'there').split(/\s+/)[0];
        const niche = String(lead.niche || lead.category || 'business').trim().toLowerCase();
        const body = `Hi ${name}, just following up on my earlier message 🙂 Would love to show you how other ${niche}s are getting more leads. Open to a quick chat?`;

        // Send via unifiedSend (records conversation, campaign, timeline)
        const sendResult = await unifiedSend.send({
          leadId,
          channel: 'whatsapp',
          body,
          providerSend: async () => whatsappTransport.sendText({
            workspaceId,
            to: lead.phone,
            message: body,
          }),
          metadata: { source: 'follow_up' },
          scheduleFollowUps: false, // Don't re-schedule on follow-up send
          workspaceId,
        });

        // Mark follow-up as sent (handles both old columns and new table)
        if (item.id && item.status === 'pending') {
          // New table row
          await followUpStorage.markFollowUpSent(item.id, { workspaceId });
        } else {
          // Old campaign row shape
          const followUpNum = !item.followUp1Sent ? 1 : 2;
          await campaignStorage.markFollowUpSent(leadId, followUpNum, { workspaceId });
        }

        results.push({ leadId, status: 'sent', messageId: sendResult.messageId });
      } catch (err) {
        console.error(`[Campaign] Follow-up send failed for ${item.leadId}:`, err.message);
        results.push({ leadId: item.leadId, status: 'failed', error: err.message });
      }
    }

    res.json({ success: true, processed: results.length, sent: results.filter((r) => r.status === 'sent').length, results });
  } catch (error) {
    console.error('[Campaign] process-due error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// =====================================================================
// Preview & Trust Mode — Unified Campaign Send
// =====================================================================
const previewSend = require('../services/previewSend');

/**
 * POST /api/campaign/send-with-preview
 *
 * Unified send that handles both live campaigns and preview copies.
 * Body:
 *   channel: 'whatsapp' | 'email' | 'sms'
 *   leads: Array<{ id, phone?, email?, name, city, niche }>
 *   message: string (personalized template)
 *   subject?: string (for email)
 *   previewMode?: boolean (default false)
 *   sessionId?: string
 */
router.post('/send-with-preview', async (req, res) => {
  const startedAt = Date.now();
  try {
    const workspaceId = workspaceOf(req);
    const userId = (req.auth && req.auth.userId) || workspaceId;
    const {
      channel = 'whatsapp',
      leads = [],
      message,
      subject,
      previewMode = false,
      sessionId = 'default',
      imageUrl,
    } = req.body || {};

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'Leads array is required' });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const MAX_BATCH = 50;
    if (leads.length > MAX_BATCH) {
      return res.status(400).json({ error: 'Batch too large', message: `Maximum ${MAX_BATCH} messages per batch.` });
    }

    // Load preview settings if preview mode is enabled
    let previewSettings = null;
    if (previewMode) {
      console.log('[Campaign] previewMode=true, loading settings for userId:', userId);
      try {
        previewSettings = await userStorage.getPreviewSettings(userId);
        console.log('[Campaign] Loaded previewSettings:', JSON.stringify(previewSettings));
      } catch (psErr) {
        console.error('[Campaign] FAILED to load preview settings:', psErr.message);
      }
      // Auto-create preview settings if they don't exist or emailPreview is not set
      if (!previewSettings || Object.keys(previewSettings).length === 0 || !previewSettings.emailPreview) {
        console.log('[Campaign] previewSettings missing or emailPreview=false. Attempting auto-create for userId:', userId);
        const user = await userStorage.findById(userId);
        const previewEmail = (user && user.email) || null;
        console.log('[Campaign] User lookup result:', user ? { id: user.id, email: user.email } : 'null');
        if (previewEmail) {
          const newSettings = {
            emailPreview: true,
            whatsappPreview: !!previewSettings?.whatsappPreview,
            smsPreview: !!previewSettings?.smsPreview,
            previewEmail,
            previewPhone: previewSettings?.previewPhone || '',
          };
          await userStorage.updatePreviewSettings(userId, newSettings);
          previewSettings = newSettings;
          console.log('[Campaign] Auto-created preview settings for user:', userId, '→ previewEmail:', previewEmail);
        } else {
          console.error('[Campaign] Cannot auto-create preview settings: user has no email');
        }
      }
    } else {
      console.log('[Campaign] previewMode=false, skipping preview settings load');
    }

    // Load sender email (separate from account email) for email campaigns
    const senderEmail = channel === 'email' ? (await userStorage.getSenderEmail(userId)) : null;

    // ------------------------------------------------------------------
    // WhatsApp — clean bulk architecture (CampaignBulkSender + RecipientExecutor)
    // ------------------------------------------------------------------
    if (channel === 'whatsapp') {
      const waConversationIds = new Set();
      let waPreviewSent = false;
      let waPreviewResult = null;

      const bulk = await campaignBulkSender.execute({
        recipients: leads,
        delayMs: 1500,
        executeRecipient: async (submitted) => {
          const exec = await executeWhatsAppRecipient({ workspaceId, recipient: submitted, message, imageUrl });

          // Record the send (conversations + campaign pipeline) — behavior unchanged
          let recorded;
          if (exec.kind === 'contact') {
            recorded = await recordContactConversation({
              workspaceId,
              contact: exec.contact,
              recipient: exec.recipient,
              channel: 'whatsapp',
              body: exec.message,
              subject,
              sendResult: exec.transportResult,
              imageUrl,
            });
          } else {
            recorded = await unifiedSend.send({
              leadId: exec.recipient.id,
              channel: 'whatsapp',
              body: exec.message,
              providerSend: async () => exec.transportResult,
              metadata: {
                imageUrl: imageUrl || null,
                mediaUrl: imageUrl || null,
                messageType: imageUrl ? 'image' : 'text',
                attachments: imageUrl ? [{ url: imageUrl, type: 'image' }] : undefined,
              },
              workspaceId,
            });
          }

          // Preview copy once per batch (first successful recipient)
          if (previewMode && !waPreviewSent && previewSettings) {
            waPreviewResult = await previewSend.sendPreviewCopy({
              channel: 'whatsapp',
              body: exec.message,
              lead: exec.recipient,
              previewSettings,
              workspaceId,
              userId,
              providerSend: async () => {
                const previewPhone = String(previewSettings.previewPhone || '').replace(/\D/g, '');
                const caption = previewSend.buildPreviewBody('whatsapp', exec.message, exec.recipient);
                if (imageUrl) {
                  return whatsappTransport.sendImage({ workspaceId, to: previewPhone, imageUrl, caption, testMode: false });
                }
                return whatsappTransport.sendText({ workspaceId, to: previewPhone, message: caption, testMode: false });
              },
            });
            waPreviewSent = waPreviewResult && waPreviewResult.sent === true;
          }

          if (recorded?.conversationId) waConversationIds.add(recorded.conversationId);
          return {
            leadId: submitted.id,
            contactId: exec.contact?.id || undefined,
            name: exec.recipient.name || submitted.name,
            status: 'sent',
            messageId: recorded?.messageId || exec.transportResult?.messageId,
            conversationId: recorded?.conversationId,
          };
        },
      });

      console.log('[Campaign] whatsapp bulk finished', {
        workspaceId,
        total: bulk.total,
        sent: bulk.sent,
        failed: bulk.failed,
        elapsedMs: Date.now() - startedAt,
      });
      return res.json({
        success: bulk.sent > 0,
        total: bulk.total,
        sent: bulk.sent,
        failed: bulk.failed,
        skipped: 0,
        previewSent: waPreviewSent,
        previewResult: waPreviewResult || null,
        previewError: waPreviewResult && !waPreviewResult.sent ? (waPreviewResult.reason || 'Unknown preview error') : null,
        results: bulk.results,
        conversationId: Array.from(waConversationIds)[0] || null,
        conversationIds: Array.from(waConversationIds),
      });
    }

    const results = [];
    const conversationIds = new Set();
    let sentCount = 0;
    let previewSent = false;
    let previewResult = null;

    for (let i = 0; i < leads.length; i++) {
      const batchRecipient = { index: i + 1, total: leads.length };
      let lead = leads[i];
      const isContactRecipient = isPersonalContactRecipient(lead);
      let personalContact = null;
      let recipientPhoneForLog = '';
      if (isContactRecipient) {
        const contactId = lead.contactId || String(lead.id || '').replace(/^contact:/, '');
        personalContact = await personalContactStorage.get(contactId, { workspaceId });
        if (!personalContact) {
          const fallbackPhone = lead.phone || lead.whatsapp || lead.whatsappNumber || lead.smsNumber || '';
          const fallbackEmail = lead.email || '';
          const hasFallbackForChannel = channel === 'email' ? Boolean(fallbackEmail) : Boolean(fallbackPhone);
          if (!hasFallbackForChannel) {
            results.push({ leadId: lead.id, contactId, name: lead.name, status: 'failed', error: 'Contact not found in this workspace and submitted recipient has no usable contact method' });
            continue;
          }
          personalContact = {
            id: contactId,
            name: lead.name || 'Contact',
            email: fallbackEmail,
            whatsappNumber: fallbackPhone,
            smsNumber: fallbackPhone,
            company: lead.company || lead.niche || '',
            notes: 'Fallback recipient payload used because contact record was not found',
          };
            console.warn('[Campaign] Contact record missing; using submitted recipient payload', {
              ...batchRecipient,
              contactId,
            leadId: lead.id,
            channel,
            phone: fallbackPhone,
            hasEmail: Boolean(fallbackEmail),
          });
        }
        lead = contactAsRecipient(personalContact);
      }
      const personalizedMessage = String(message)
        .replace(/{name}/g, lead.name || 'there')
        .replace(/{city}/g, lead.city || '')
        .replace(/{niche}/g, lead.niche || lead.business || 'business')
        .replace(/{company}/g, lead.company || lead.companyName || 'our company');

      let result;
      let deliveryMeta = {};
      try {
        // Personal Contact campaigns are not leads. Send directly and record a contact conversation.
        if (isContactRecipient && personalContact) {
          if (channel === 'email') {
            const { sendEmailToLead } = require('../services/emailService');
            const attachments = imageUrl ? [{
              filename: 'campaign-image.png',
              path: imageUrl,
              cid: 'campaign-image@leadflow.ai',
            }] : [];
            if (!personalContact.email) throw new Error('Contact has no email address');
            const recipientEmail = personalContactStorage.resolveDeliveryEmail(personalContact);
            if (!recipientEmail) {
              throw new Error(`Contact "${personalContact.name || personalContact.id}" has an invalid email address (${personalContact.email || 'empty'})`);
            }
            console.log('[Campaign] Contact email campaign send', {
              contactId: personalContact.id,
              contactName: personalContact.name,
              recipientEmail,
              previewMode,
              workspaceId,
            });
            const sendResult = await sendEmailToLead({ ...lead, id: lead.id, email: recipientEmail, emailNormalized: recipientEmail }, {
              message: personalizedMessage,
              subject: subject || 'Outreach',
              workspaceId,
              attachments,
              senderEmail,
            });
            deliveryMeta = {
              recipientEmail: sendResult.recipientEmail || recipientEmail,
              deliveryVerified: sendResult.deliveryVerified,
            };
            result = await recordContactConversation({
              workspaceId,
              contact: personalContact,
              recipient: lead,
              channel,
              body: personalizedMessage,
              subject: sendResult.subject || subject || 'Outreach',
              sendResult,
              imageUrl,
            });
          } else if (channel === 'sms') {
            const { sendSms } = require('../services/smsService');
            const to = (personalContact.smsNumber || personalContact.whatsappNumber || '').replace(/\D/g, '');
            if (!to) throw new Error('Contact has no SMS number');
            const formatted = to.startsWith('1') && to.length === 11 ? `+${to}` : to.length === 10 ? `+1${to}` : `+${to}`;
            recipientPhoneForLog = formatted;
            const sendResult = await sendSms({ to: formatted, body: personalizedMessage, workspaceId, mediaUrl: imageUrl || undefined });
            result = await recordContactConversation({ workspaceId, contact: personalContact, recipient: lead, channel, body: personalizedMessage, subject, sendResult, imageUrl });
          } else {
            throw new Error(`Channel ${channel} not supported`);
          }
        } else
        // Send to lead via unifiedSend (records campaign + conversation)
        if (channel === 'email') {
          const { sendEmailToLead } = require('../services/emailService');
          const attachments = imageUrl ? [{
            filename: 'campaign-image.png',
            path: imageUrl,
            cid: 'campaign-image@leadflow.ai',
          }] : [];

          result = await unifiedSend.send({
            leadId: lead.id,
            channel: 'email',
            body: personalizedMessage,
            subject: subject || 'Outreach',
            providerSend: async () => sendEmailToLead(lead, {
              message: personalizedMessage,
              subject: subject || 'Outreach',
              workspaceId,
              attachments,
              senderEmail,
            }),
            metadata: { imageUrl },
            workspaceId,
          });
        } else if (channel === 'sms') {
          const { sendSms } = require('../services/smsService');
          const to = (lead.phone || '').replace(/\D/g, '');
          if (!to) throw new Error('Lead has no phone number');
          const formatted = to.startsWith('1') && to.length === 11 ? `+${to}` : to.length === 10 ? `+1${to}` : `+${to}`;
          recipientPhoneForLog = formatted;

          result = await unifiedSend.send({
            leadId: lead.id,
            channel: 'sms',
            body: personalizedMessage,
            providerSend: async () => sendSms({ to: formatted, body: personalizedMessage, workspaceId, mediaUrl: imageUrl || undefined }),
            metadata: { imageUrl },
            workspaceId,
          });
        } else {
          throw new Error(`Channel ${channel} not supported`);
        }

        if (result && result.success === false) {
          // Provider send failed (e.g. ACK 463, number not registered).
          // Record as failed but continue the loop to the next recipient.
          console.log(`[Campaign] Recipient FAILED: index=${i + 1}/${leads.length} lead=${lead.id} name=${lead.name} phone=${recipientPhoneForLog || lead.phone || lead.whatsapp || ''} channel=${channel} error=${result.error}`);
          results.push({
            leadId: lead.id,
            contactId: personalContact?.id || undefined,
            name: lead.name,
            status: 'failed',
            error: result.error || 'Send failed',
          });
        } else {
          results.push({
            leadId: lead.id,
            contactId: personalContact?.id || undefined,
            name: lead.name,
            recipientEmail: deliveryMeta.recipientEmail || result?.recipientEmail || lead.email || undefined,
            status: 'sent',
            messageId: result?.messageId,
            deliveryVerified: deliveryMeta.deliveryVerified ?? result?.deliveryVerified ?? null,
            conversationId: result?.conversationId,
          });
          if (result?.conversationId) conversationIds.add(result.conversationId);
          sentCount++;
        }

        // Send preview copy once per batch (to the first lead's message)
        console.log('[Campaign] Preview send check:', { previewMode, previewSent, previewSettingsExists: !!previewSettings, channel });
        if (previewMode && !previewSent && previewSettings) {
          console.log('[Campaign] Preview send condition PASSED. previewSettings:', JSON.stringify(previewSettings));
          // For email, pass the actual campaign HTML and attachments for an exact replica
          const previewAttachments = (channel === 'email' && imageUrl)
            ? [{ filename: 'campaign-image.png', path: imageUrl, cid: 'campaign-image@leadflow.ai' }]
            : [];
          console.log('[Campaign] previewAttachments:', JSON.stringify(previewAttachments), '| html passed:', !!result?.html, '| subject passed:', !!(result?.subject || subject));

          previewResult = await previewSend.sendPreviewCopy({
            channel,
            body: personalizedMessage,
            lead,
            previewSettings,
            senderEmail,
            workspaceId,
            userId,
            // html: original HTML with cid: refs for Gmail MIME construction
            // displayHtml: HTML with HTTP URLs for Inbox browser rendering
            html: channel === 'email' ? (result?.html || null) : null,
            displayHtml: channel === 'email' ? (result?.displayHtml || null) : null,
            subject: channel === 'email' ? (result?.subject || subject || null) : null,
            attachments: previewAttachments,
            providerSend: async () => ({ messageId: 'preview-local', status: 'sent' }),
            workspaceId,
          });
          console.log('[Campaign] previewResult received:', JSON.stringify(previewResult));
          previewSent = previewResult && previewResult.sent === true;
          console.log('[Campaign] previewSent set to:', previewSent);
        } else {
          console.log('[Campaign] Preview send SKIPPED. Condition result:', { previewMode, previewSent, hasPreviewSettings: !!previewSettings });
        }
      } catch (err) {
        console.error('[Campaign] Recipient EXCEPTION', {
          ...batchRecipient,
          leadId: lead.id,
          name: lead.name,
          phone: recipientPhoneForLog || lead.phone || lead.whatsapp || '',
          channel,
          error: err.message,
        });
        results.push({
          leadId: lead.id,
          name: lead.name,
          status: 'failed',
          error: err.message,
          source: err.source || err.service || null,
          rateLimited: Boolean(err.rateLimited || err.status === 429),
          retryAfter: err.retryAfter || null,
        });
      }

      // Rate-limit delay between messages
      if (i < leads.length - 1) {
        const delayMs = 500;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    const { getQueueStats } = require('../utils/gmailApiQueue');
    const failedCount = results.filter((r) => r.status === 'failed').length;
    const skippedCount = results.filter((r) => r.status === 'skipped' || r.status === 'cancelled').length;
    console.log('[Campaign] send-with-preview finished', {
      workspaceId,
      total: leads.length,
      sent: sentCount,
      failed: failedCount,
      skipped: skippedCount,
      elapsedMs: Date.now() - startedAt,
      gmailQueue: channel === 'email' ? getQueueStats(workspaceId) : undefined,
    });
    res.json({
      success: sentCount > 0,
      total: leads.length,
      sent: sentCount,
      failed: failedCount,
      skipped: skippedCount,
      previewSent,
      previewResult: previewResult || null,
      previewError: previewResult && !previewResult.sent ? (previewResult.reason || 'Unknown preview error') : null,
      results,
      conversationId: Array.from(conversationIds)[0] || null,
      conversationIds: Array.from(conversationIds),
    });
  } catch (error) {
    const { respondWithExternalError } = require('../utils/externalApiErrors');
    return respondWithExternalError(res, error, { route: 'POST /api/campaign/send-with-preview', workspaceId: workspaceOf(req) }, 'Campaign send failed');
  }
});

module.exports = router;
