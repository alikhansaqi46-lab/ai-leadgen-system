/**
 * WhatsApp Routes — Official Meta WhatsApp Cloud API only.
 * No QR, no WhatsApp Web, no Baileys.
 */

const express = require('express');
const router = express.Router();
const whatsappTransport = require('../services/whatsappTransport');
const whatsappMeta = require('../services/whatsappMeta');
const {
  getBusinessInfo,
  getMessageTemplates,
  validateCredentials,
  formatPhoneNumber: metaFormatPhone,
} = whatsappMeta;
const timelineStorage = require('../utils/timelineStorage');
const aiProvider = require('../services/aiProvider');
const openAiKeyService = require('../services/openAiKeyService');

const conversationStorage = require('../utils/conversationStorage');
const campaignStorage = require('../utils/campaignStorage');
const leadStorage = require('../utils/leadStorage');
const unifiedSend = require('../services/unifiedSend');
const integrationStorage = require('../utils/integrationStorage');
const contactStorage = require('../utils/contactStorage');
const personalContactStorage = require('../utils/personalContactStorage');

const { workspaceOf } = require('../utils/workspaceContext');

function isPersonalContactRecipient(lead) {
  return lead?.source === 'contacts' || !!lead?.contactId || String(lead?.id || '').startsWith('contact:');
}

function contactConversationId(contactId) {
  return `contact:${String(contactId || '').replace(/^contact:/, '')}`;
}

async function recordWhatsAppContactSend({ workspaceId, contact, body, sendResult }) {
  const leadId = contactConversationId(contact.id);
  let conv = await conversationStorage.findConversation({ workspaceId, leadId, channel: 'whatsapp' });
  if (!conv) {
    conv = await conversationStorage.createConversation({
      leadId,
      channel: 'whatsapp',
      status: 'open',
      subject: `WhatsApp with ${contact.name || contact.whatsappNumber || 'Contact'}`,
    }, { workspaceId });
  }
  await conversationStorage.addMessage(conv.id, {
    direction: 'outbound',
    body,
    channel: 'whatsapp',
    source: 'contact_campaign',
    status: sendResult?.status || 'sent',
    externalMessageId: sendResult?.messageId || null,
    messageType: 'text',
    metadata: {
      entityType: 'contact',
      contactId: contact.id,
      messageId: sendResult?.messageId || null,
    },
  }, { workspaceId });
  return { conversationId: conv.id, messageId: sendResult?.messageId || null };
}

function formatPhoneNumber(phone) {
  return metaFormatPhone(phone);
}

/**
 * Resolve workspace from Meta webhook metadata.phone_number_id by matching
 * stored WhatsApp integration credentials. Falls back to null if unknown.
 */
function resolveWorkspaceFromWebhookBody(body) {
  try {
    const phoneNumberId = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    if (!phoneNumberId) return null;
    const workspaces = integrationStorage.listAllWorkspaces() || [];
    for (const ws of workspaces) {
      const creds = integrationStorage.getCredentials(ws, 'whatsapp');
      if (creds?.phoneNumberId && String(creds.phoneNumberId) === String(phoneNumberId)) {
        return ws;
      }
    }
    if (process.env.PHONE_NUMBER_ID && String(process.env.PHONE_NUMBER_ID) === String(phoneNumberId)) {
      return process.env.DEFAULT_WORKSPACE_ID || 'default';
    }
  } catch (err) {
    console.error('[WhatsApp Webhook] workspace resolve error:', err.message);
  }
  return null;
}

/** Compatibility helper used by ai.js / campaign callers */
function getUserCredentials(userId = 'default') {
  const creds = whatsappTransport.resolveCredentials(userId);
  return {
    token: creds.token || null,
    phoneNumberId: creds.phoneNumberId || null,
    wabaId: creds.wabaId || null,
    transport: 'meta',
    _source: creds.source,
  };
}

function isWhatsAppReady(workspaceId) {
  return whatsappTransport.isConfigured(workspaceId);
}

async function providerSendText(workspaceId, to, message, testMode = false) {
  return whatsappTransport.sendText({ workspaceId, to, message, testMode });
}

// ==================== CREDENTIALS ====================

function setUserCredentials(userId, credentials) {
  integrationStorage.set(userId, 'whatsapp', {
    type: 'api_key',
    connected: true,
    account: credentials.phoneNumberId || 'connected',
    credentials: {
      transport: 'meta',
      token: credentials.token,
      phoneNumberId: credentials.phoneNumberId,
      wabaId: credentials.wabaId || null,
    },
    connectedAt: new Date().toISOString(),
  });
}

// POST /api/whatsapp/credentials - Save Meta Cloud API credentials
router.post('/credentials', async (req, res) => {
  try {
    const { token, phoneNumberId, wabaId } = req.body;
    const userId = workspaceOf(req);

    if (!token || !phoneNumberId) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Both token and phoneNumberId are required',
      });
    }

    const validation = await validateCredentials(token, phoneNumberId);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid credentials',
        message: validation.error,
      });
    }

    setUserCredentials(userId, { token, phoneNumberId, wabaId: wabaId || null });

    res.json({
      success: true,
      message: 'WhatsApp credentials saved successfully',
      phoneNumberId: phoneNumberId.substring(0, 6) + '****',
    });
  } catch (error) {
    console.error('❌ Save credentials error:', error.message);
    res.status(500).json({
      error: 'Failed to save credentials',
      message: error.message,
    });
  }
});

// GET /api/whatsapp/credentials
router.get('/credentials', async (req, res) => {
  const userId = workspaceOf(req);
  const creds = getUserCredentials(userId);
  const hasCredentials = !!(creds.token && creds.phoneNumberId);
  res.json({
    configured: hasCredentials,
    transport: 'meta',
    hasToken: !!creds.token,
    hasPhoneNumberId: !!creds.phoneNumberId,
    hasWabaId: !!creds.wabaId,
    phoneNumberId: creds.phoneNumberId ? creds.phoneNumberId.substring(0, 6) + '****' : null,
    wabaId: creds.wabaId ? creds.wabaId.substring(0, 6) + '****' : null,
    credentialSource: creds._source,
  });
});

// DELETE /api/whatsapp/credentials
router.delete('/credentials', async (req, res) => {
  const userId = workspaceOf(req);
  integrationStorage.remove(userId, 'whatsapp');
  res.json({ success: true, message: 'WhatsApp credentials removed' });
});

// POST /api/whatsapp/validate
router.post('/validate', async (req, res) => {
  try {
    const { token, phoneNumberId } = req.body;
    if (!token || !phoneNumberId) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Both token and phoneNumberId are required',
      });
    }
    const validation = await validateCredentials(token, phoneNumberId);
    if (validation.valid) {
      res.json({ valid: true, message: 'Credentials are valid' });
    } else {
      res.status(400).json({ valid: false, error: validation.error });
    }
  } catch (error) {
    res.status(500).json({ valid: false, error: error.message });
  }
});

// ==================== SEND MESSAGE ====================

// POST /api/whatsapp/send - Send a single WhatsApp message
router.post('/send', async (req, res) => {
  try {
    const {
      phone,
      message,
      useTemplate = false,
      templateName = null,
      templateParams = [],
      languageCode = 'en_US',
      testMode = false,
    } = req.body;

    const userId = workspaceOf(req);
    if (!testMode && !isWhatsAppReady(userId)) {
      return res.status(503).json({
        error: 'WhatsApp not configured',
        message: 'Configure Meta Cloud API credentials in WhatsApp Settings first',
        setupRequired: true,
      });
    }

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const formattedPhone = formatPhoneNumber(phone);
    const credentials = getUserCredentials(userId);

    const lead = await contactStorage.findLeadByContact({ workspaceId: userId, channel: 'whatsapp', value: formattedPhone })
      || await leadStorage.findByPhone(formattedPhone, { workspaceId: userId });

    const providerSend = async () => {
      if (useTemplate && templateName && (credentials.token || testMode)) {
        return whatsappTransport.sendTemplate({
          workspaceId: userId,
          to: formattedPhone,
          templateName,
          languageCode,
          templateParams,
          testMode,
        });
      }
      if (!message) throw new Error('Message is required for text messages');
      return providerSendText(userId, formattedPhone, message, testMode);
    };

    let result;
    if (lead) {
      result = await unifiedSend.send({
        leadId: lead.id,
        channel: 'whatsapp',
        body: message || '[template]',
        providerSend,
        metadata: { templateName, languageCode, testMode },
        scheduleFollowUps: !testMode,
        workspaceId: userId,
      });
    } else {
      result = await providerSend();
    }

    res.json({
      success: true,
      message: testMode
        ? '🧪 TEST: Message would be sent'
        : `WhatsApp message sent to ${formattedPhone}`,
      messageId: result.messageId,
      status: result.status || 'sent',
      testMode: result.testMode || false,
      phone: formattedPhone,
      conversationId: result.conversationId || null,
    });

  } catch (error) {
    console.error('❌ WhatsApp send error:', error.message);

    const notOnWhatsApp = error.message.includes('not registered') ||
                          error.message.includes('not on WhatsApp');
    const invalidToken = error.message.includes('Invalid access token');
    const rateLimited = error.message.includes('Rate limit');

    res.status(500).json({
      error: 'Failed to send WhatsApp message',
      message: error.message,
      notOnWhatsApp,
      invalidToken,
      rateLimited,
      setupRequired: invalidToken
    });
  }
});

// Track sent phones within same session to prevent duplicate sends
// Entries are auto-evicted after 1 hour to prevent memory leaks
const sessionSentPhones = new Set();
const SESSION_PHONE_TTL_MS = 60 * 60 * 1000; // 1 hour
const sessionPhoneTimestamps = new Map(); // phoneSessionKey -> timestamp
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of sessionPhoneTimestamps) {
    if (now - ts > SESSION_PHONE_TTL_MS) {
      sessionPhoneTimestamps.delete(key);
      sessionSentPhones.delete(key);
    }
  }
}, 5 * 60 * 1000).unref?.(); // Cleanup every 5 minutes

/** In-memory WhatsApp campaign job controls (pause / resume / cancel) per workspace. */
// Entries are cleaned up after campaign completion (status=completed|idle|cancelled) + 30min TTL
const waCampaignJobs = new Map();
const CAMPAIGN_JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [wsId, job] of waCampaignJobs) {
    if (['completed', 'cancelled', 'idle'].includes(job.status)) {
      const updated = new Date(job.updatedAt || 0).getTime();
      if (now - updated > CAMPAIGN_JOB_TTL_MS) {
        waCampaignJobs.delete(wsId);
      }
    }
  }
}, 5 * 60 * 1000).unref?.(); // Cleanup every 5 minutes

function getCampaignJob(workspaceId) {
  if (!waCampaignJobs.has(workspaceId)) {
    waCampaignJobs.set(workspaceId, {
      status: 'idle', // idle | running | paused | cancelled | completed | scheduled
      scheduledAt: null,
      updatedAt: new Date().toISOString(),
      total: 0,
      sent: 0,
      failed: 0,
      payload: null,
    });
  }
  return waCampaignJobs.get(workspaceId);
}

async function waitWhilePaused(workspaceId) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = getCampaignJob(workspaceId);
    if (job.status === 'cancelled') return 'cancelled';
    if (job.status !== 'paused') return job.status;
    await new Promise((r) => setTimeout(r, 800));
  }
}

// POST /api/whatsapp/send-bulk - Send to multiple leads
router.post('/send-bulk', async (req, res) => {
  try {
    const {
      leads, // Array of { phone, name, city, niche, id, company }
      message,
      useTemplate = false,
      templateName = null,
      templateParams = [],
      languageCode = 'en_US',
      testMode = false,
      delayMs = 2000,
      sessionId = 'default' // client-provided session id for duplicate tracking
    } = req.body;

    const userId = workspaceOf(req);
    const credentials = getUserCredentials(userId);

    if (!testMode && !isWhatsAppReady(userId)) {
      console.log('[WhatsApp] Bulk send blocked: WhatsApp not configured');
      return res.status(503).json({
        error: 'WhatsApp not configured',
        message: 'Configure Meta Cloud API credentials in WhatsApp Settings first',
        setupRequired: true,
      });
    }

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'Leads array is required' });
    }

    // Safety limit
    const MAX_BATCH = 50;
    if (leads.length > MAX_BATCH) {
      return res.status(400).json({
        error: 'Batch too large',
        message: `Maximum ${MAX_BATCH} messages per batch. You selected ${leads.length}.`
      });
    }

    const job = getCampaignJob(userId);
    if (job.status === 'cancelled') {
      return res.status(409).json({ error: 'Campaign cancelled. Resume or start a new campaign first.' });
    }
    job.status = 'running';
    job.total = leads.length;
    job.sent = 0;
    job.failed = 0;
    job.scheduledAt = null;
    job.updatedAt = new Date().toISOString();
    waCampaignJobs.set(userId, job);

    console.log(`[WhatsApp] Starting bulk send: ${leads.length} leads, testMode=${testMode}, template=${useTemplate}`);

    const results = [];
    const failed = [];
    let sentCount = 0;
    let cancelledMidway = false;

    for (let i = 0; i < leads.length; i++) {
      const control = await waitWhilePaused(userId);
      if (control === 'cancelled') {
        cancelledMidway = true;
        results.push({ leadId: leads[i]?.id, name: leads[i]?.name, status: 'cancelled', error: 'Campaign cancelled' });
        for (let j = i + 1; j < leads.length; j++) {
          results.push({ leadId: leads[j]?.id, name: leads[j]?.name, status: 'cancelled', error: 'Campaign cancelled' });
        }
        break;
      }

      const lead = leads[i];
      const phone = lead.phone || lead.phoneNumber;

      if (!phone || phone === 'N/A' || phone === 'Not Available') {
        console.log(`[WhatsApp] Skipping ${lead.name || lead.id}: no phone number`);
        results.push({
          leadId: lead.id,
          name: lead.name,
          status: 'failed',
          error: 'No phone number'
        });
        failed.push(lead);
        continue;
      }

      const formattedPhone = formatPhoneNumber(phone);

      // Prevent duplicate sends within same session
      const phoneSessionKey = `${sessionId}__${formattedPhone}`;
      if (sessionSentPhones.has(phoneSessionKey)) {
        console.log(`[WhatsApp] Skipping duplicate: ${formattedPhone} already sent in this session`);
        results.push({
          leadId: lead.id,
          name: lead.name,
          phone: formattedPhone,
          status: 'skipped',
          error: 'Duplicate send in this session'
        });
        continue;
      }

      let retryCount = 0;
      const MAX_RETRIES = 1;
      let success = false;
      let lastError = null;
      let result = null;

      while (retryCount <= MAX_RETRIES && !success) {
        try {
          if (retryCount > 0) {
            console.log(`[WhatsApp] Retrying ${lead.name} (${formattedPhone}), attempt ${retryCount + 1}`);
            await new Promise(r => setTimeout(r, 3000)); // extra delay before retry
          }

          console.log(`[WhatsApp] Sending to ${formattedPhone} (${lead.name || 'Unknown'})`);

          const providerSend = async () => {
            let personalizedMessage = message || 'Hello!';
            personalizedMessage = personalizedMessage
              .replace(/{name}/g, lead.name || 'there')
              .replace(/{city}/g, lead.city || '')
              .replace(/{niche}/g, lead.niche || lead.business || 'business')
              .replace(/{company}/g, lead.company || lead.companyName || 'our company')
              .replace(/{product}/g, lead.product || 'our services')
              .replace(/{offer}/g, lead.offer || '');

            if (useTemplate && templateName && (credentials.token || testMode)) {
              const params = templateParams.length > 0
                ? templateParams.map((p) => String(p)
                  .replace(/{name}/g, lead.name || 'there')
                  .replace(/{city}/g, lead.city || '')
                  .replace(/{niche}/g, lead.niche || lead.business || 'business')
                  .replace(/{company}/g, lead.company || lead.companyName || 'our company'))
                : [lead.name || 'there', lead.city || '', lead.niche || ''];
              return whatsappTransport.sendTemplate({
                workspaceId: userId,
                to: formattedPhone,
                templateName,
                languageCode,
                templateParams: params,
                testMode,
              });
            }
            return providerSendText(userId, formattedPhone, personalizedMessage, testMode);
          };

          if (isPersonalContactRecipient(lead)) {
            const contactId = lead.contactId || String(lead.id || '').replace(/^contact:/, '');
            const personalContact = await personalContactStorage.get(contactId, { workspaceId: userId });
            if (!personalContact) {
              throw new Error(`Contact ${contactId} not found in workspace ${userId}`);
            }
            const sendResult = await providerSend();
            if (!testMode) {
              await recordWhatsAppContactSend({
                workspaceId: userId,
                contact: personalContact,
                body: message || '[template]',
                sendResult,
              });
            }
            result = {
              ...sendResult,
              messageId: sendResult.messageId,
              conversationId: undefined,
            };
          } else if (lead.id) {
            const usResult = await unifiedSend.send({
              leadId: lead.id,
              channel: 'whatsapp',
              body: message || '[template]',
              providerSend,
              metadata: { templateName, languageCode, testMode },
              scheduleFollowUps: false, // Bulk: don't reschedule for each lead
              workspaceId: userId,
            });
            result = usResult;
          } else {
            result = await providerSend();
          }

          success = true;
          sessionSentPhones.add(phoneSessionKey);
          sessionPhoneTimestamps.set(phoneSessionKey, Date.now());
          console.log(`[WhatsApp] Success: ${formattedPhone}`);

        } catch (error) {
          lastError = error;
          retryCount++;
          console.error(`[WhatsApp] Failed (${retryCount}/${MAX_RETRIES + 1}) to ${formattedPhone}:`, error.message);
        }
      }

      if (success) {
        results.push({
          leadId: lead.id,
          name: lead.name,
          phone: formattedPhone,
          status: 'sent',
          messageId: result.messageId
        });
        sentCount++;
        job.sent = sentCount;
      } else {
        results.push({
          leadId: lead.id,
          name: lead.name,
          status: 'failed',
          error: lastError?.message || 'Unknown error',
          notOnWhatsApp: lastError?.message?.includes('not registered') || lastError?.message?.includes('not on WhatsApp')
        });
        failed.push({ ...lead, error: lastError?.message });
        job.failed = failed.length;
      }
      job.updatedAt = new Date().toISOString();
      waCampaignJobs.set(userId, job);

      // Rate-limit safe delay between messages (except last one)
      if (i < leads.length - 1 && !cancelledMidway) {
        const actualDelay = testMode ? Math.min(delayMs, 500) : delayMs;
        console.log(`[WhatsApp] Delay ${actualDelay}ms before next message (${i + 1}/${leads.length})`);
        await new Promise(resolve => setTimeout(resolve, actualDelay));
      }
    }

    job.status = cancelledMidway ? 'cancelled' : 'completed';
    job.updatedAt = new Date().toISOString();
    waCampaignJobs.set(userId, job);

    console.log(`[WhatsApp] Bulk send complete: ${sentCount} sent, ${failed.length} failed, ${leads.length} total, cancelled=${cancelledMidway}`);

    res.json({
      success: sentCount > 0,
      total: leads.length,
      sent: sentCount,
      failed: failed.length,
      skipped: leads.length - sentCount - failed.length,
      cancelled: cancelledMidway,
      testMode,
      campaignJob: job,
      results
    });

  } catch (error) {
    console.error('[WhatsApp] Bulk send fatal error:', error.message);
    try {
      const userId = workspaceOf(req);
      const job = getCampaignJob(userId);
      job.status = 'idle';
      job.updatedAt = new Date().toISOString();
      waCampaignJobs.set(userId, job);
    } catch (_) { /* ignore */ }
    res.status(500).json({
      error: 'Bulk send failed',
      message: error.message
    });
  }
});

// ==================== TEMPLATES ====================

// GET /api/whatsapp/templates - Get approved templates
router.get('/templates', async (req, res) => {
  try {
    const userId = workspaceOf(req);
    const credentials = getUserCredentials(userId);

    if (!credentials.token || !credentials.wabaId) {
      return res.json({
        success: true,
        templates: [],
        configured: false,
        message: 'WhatsApp not connected. Configure credentials in Settings to load your approved templates.',
      });
    }

    const result = await getMessageTemplates(credentials.token, credentials.wabaId);
    res.json(result);

  } catch (error) {
    console.error('❌ Get templates error:', error.message);
    res.status(500).json({
      error: 'Failed to get templates',
      message: error.message
    });
  }
});

// ==================== STATUS & INFO ====================

// GET /api/whatsapp/status - Check WhatsApp Cloud API configuration status
router.get('/status', async (req, res) => {
  const userId = workspaceOf(req);
  const status = await whatsappTransport.getQrStatus(userId);
  const creds = getUserCredentials(userId);
  res.json({
    configured: status.configured,
    connected: status.connected,
    status: status.status,
    transport: 'meta',
    provider: 'meta',
    phone: status.phone || null,
    hasToken: !!creds.token,
    hasPhoneNumberId: !!creds.phoneNumberId,
    hasWabaId: !!creds.wabaId,
    credentialSource: creds._source,
    webhook: {
      verifyTokenConfigured: Boolean((process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '').trim()),
      signatureSecretConfigured: Boolean((process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET || '').trim()),
    },
  });
});

// GET /api/whatsapp/diagnostics
router.get('/diagnostics', async (req, res) => {
  const userId = workspaceOf(req);
  const status = await whatsappTransport.getQrStatus(userId);
  const stored = integrationStorage.get(userId, 'whatsapp');
  res.json({
    transport: 'meta',
    status: status.status,
    connected: status.connected,
    configured: status.configured,
    credentialSource: status.credentialSource,
    phoneNumberId: status.phoneNumberId,
    wabaId: status.wabaId,
    lastError: status.lastError,
    connectedAt: stored?.connectedAt || null,
    updatedAt: stored?.updatedAt || null,
  });
});

// GET /api/whatsapp/business-info
router.get('/business-info', async (req, res) => {
  try {
    const userId = workspaceOf(req);
    const credentials = getUserCredentials(userId);
    if (!credentials.token || !credentials.phoneNumberId) {
      return res.status(503).json({ error: 'WhatsApp not configured' });
    }
    const result = await getBusinessInfo(credentials.token, credentials.phoneNumberId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get business info', message: error.message });
  }
});

// ==================== AUTO-REPLY TEST ENDPOINT ====================

// POST /api/whatsapp/test-reply - Manually test auto-reply
router.post('/test-reply', async (req, res) => {
  try {
    const { phone, message = 'Hi' } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    const userId = workspaceOf(req);
    if (!isWhatsAppReady(userId)) {
      return res.status(503).json({
        error: 'WhatsApp not configured',
        message: 'Configure Meta Cloud API credentials in WhatsApp Settings first',
      });
    }

    let replyText = 'Hello! This is an auto reply from AI agent.';
    const lowerText = message.toLowerCase();
    if (lowerText.includes('hi') || lowerText.includes('hello')) {
      replyText = 'Hello! This is an auto reply from AI agent. How can I help you today?';
    }

    const result = await providerSendText(userId, phone, replyText, false);
    res.json({
      success: true,
      message: 'Test auto-reply sent',
      recipient: phone,
      replyText,
      messageId: result.messageId,
    });
  } catch (error) {
    console.error('❌ Test reply error:', error.message);
    res.status(500).json({
      error: 'Test reply failed',
      message: error.message,
    });
  }
});

// ==================== WEBHOOK (receiving messages & status updates) ====================

/**
 * Parse incoming message from Meta webhook payload
 * Structure: entry[0].changes[0].value.messages[0]
 */
function parseIncomingMessage(body) {
  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Status updates (delivered, read, sent)
    if (value?.statuses) {
      return { type: 'status', statuses: value.statuses, phoneNumberId: value?.metadata?.phone_number_id || null };
    }

    // Incoming messages
    const messages = value?.messages;
    if (messages && messages.length > 0) {
      const msg = messages[0];
      return {
        type: 'message',
        messageType: msg.type,
        from: msg.from,
        messageId: msg.id,
        timestamp: msg.timestamp,
        text: msg.text?.body || '',
        phoneNumberId: value?.metadata?.phone_number_id || null,
      };
    }

    return { type: 'unknown' };
  } catch (err) {
    console.error('❌ Error parsing webhook payload:', err.message);
    return { type: 'error', error: err.message };
  }
}

// POST /api/whatsapp/webhook - Receive Meta webhook events (Meta transport only)
router.post('/webhook', async (req, res) => {
  // Always acknowledge webhook immediately (Meta requires < 20s response)
  res.status(200).send('OK');

  try {
    const body = req.body;
    const workspaceId = resolveWorkspaceFromWebhookBody(body) || workspaceOf(req);
    console.log('📩 Webhook received at', new Date().toISOString(), 'workspace=', workspaceId);

    const parsed = parseIncomingMessage(body);

    // ── STATUS UPDATES (delivered, read, sent) ──
    if (parsed.type === 'status') {
      const timelineStorage = require('../utils/timelineStorage');
      for (const status of parsed.statuses) {
        console.log(`📊 Status update: ${status.status} for message ${status.id}`);
        const mappedStatus =
          status.status === 'read' ? 'read'
            : status.status === 'delivered' ? 'delivered'
              : status.status === 'failed' ? 'failed'
                : 'sent'; // sent / accepted
        try {
          const updated = await conversationStorage.updateMessageStatusByExternalId(status.id, mappedStatus, { workspaceId });
          if (updated) {
            console.log(`[Webhook] Updated message status to ${mappedStatus} for external ID ${status.id}`);
            const eventType =
              mappedStatus === 'read' ? 'message_read'
                : mappedStatus === 'delivered' ? 'message_delivered'
                  : mappedStatus === 'failed' ? 'message_failed'
                    : 'message_sent';
            if (updated.leadId) {
              await timelineStorage.recordEvent({
                leadId: updated.leadId,
                type: eventType,
                channel: updated.channel || 'whatsapp',
                conversationId: updated.conversationId,
                referenceId: status.id,
                payload: {
                  status: mappedStatus,
                  providerTimestamp: status.timestamp || null,
                  errors: status.errors || null,
                },
              }, { workspaceId }).catch((e) => console.error('[Webhook] timeline status event failed:', e.message));
            }
            if (mappedStatus === 'failed') {
              const errDetail = (status.errors || []).map((e) => `${e.code}: ${e.title || e.message || ''}`).join('; ');
              console.warn(`[Webhook] Message ${status.id} FAILED on Meta side: ${errDetail || 'no error details'}`);
            }
          }
        } catch (err) {
          console.error('[Webhook] Failed to update message status:', err.message);
        }
      }
      return;
    }

    // ── INCOMING MESSAGES ──
    if (parsed.type === 'message') {
      const { from, text, messageId } = parsed;
      console.log(`📨 Incoming message from ${from}: "${text}"`);

      if (!text || !from) {
        console.log('⚠️ No text or sender found, skipping');
        return;
      }

      const normalizedPhone = formatPhoneNumber(from);

      // 1. Find lead by phone
      const lead = await contactStorage.findLeadByContact({ workspaceId, channel: 'whatsapp', value: normalizedPhone })
        || await leadStorage.findByPhone(normalizedPhone, { workspaceId });
      if (!lead) {
        console.log(`[Webhook] No lead found for phone ${normalizedPhone}, storing orphan message`);
      }
      const leadId = lead ? lead.id : `orphan_${normalizedPhone}`;

      // 2. Update CRM pipeline: mark as replied, cancel follow-ups
      await campaignStorage.recordReply(leadId, { workspaceId, channel: 'whatsapp', messageText: text });
      await campaignStorage.cancelFollowUps(leadId, { workspaceId });
      console.log(`[Webhook] Pipeline updated for lead ${leadId}: status=replied, follow-ups cancelled`);

      // 3. Create or find conversation
      let conv = await conversationStorage.findConversation({ workspaceId, leadId, channel: 'whatsapp' });
      if (!conv) {
        conv = await conversationStorage.createConversation(
          { leadId, channel: 'whatsapp', status: 'open', subject: lead ? `WhatsApp with ${lead.name}` : 'WhatsApp conversation' },
          { workspaceId }
        );
        console.log(`[Webhook] Created new conversation ${conv.id} for lead ${leadId}`);
      }

      // 4. Store inbound message (auto-increments unreadCount)
      await conversationStorage.addMessage(
        conv.id,
        {
          direction: 'inbound',
          body: text,
          channel: 'whatsapp',
          source: 'webhook',
          externalMessageId: messageId || null,
        },
        { workspaceId }
      );
      console.log(`[Webhook] Inbound message stored in conversation ${conv.id}`);

      // Autonomous AI WhatsApp reply (server-side, same engine as Email)
      if (!String(leadId).startsWith('preview_')) {
        const autonomousReplyService = require('../services/autonomousReplyService');
        setImmediate(() => {
          autonomousReplyService.maybeAutoReplyToInbound({
            workspaceId,
            conversationId: conv.id,
            userId: workspaceId,
            expectedChannel: 'whatsapp',
          }).then((autoResult) => {
            if (autoResult.sent) {
              console.log(`[Webhook] Autonomous AI reply sent for conversation ${conv.id}`);
            }
          }).catch((autoErr) => {
            console.error('[Webhook] Autonomous AI reply failed (non-fatal):', autoErr.message);
          });
        });
      }
    }

  } catch (error) {
    console.error('❌ Webhook processing error:', error.message);
    console.error(error.stack);
  }
});

// GET /api/whatsapp/webhook - Meta webhook verification
router.get('/webhook', (req, res) => {
  // Meta sends: hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>
  // Support both flat querystring keys (default Express) and nested (qs library with allowDots)
  const mode = req.query['hub.mode'] || req.query?.hub?.mode;
  const token = (req.query['hub.verify_token'] || req.query?.hub?.verify_token || '').toString().trim();
  const challenge = req.query['hub.challenge'] || req.query?.hub?.challenge;

  const VERIFY_TOKEN = (process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '').toString().trim();
  if (!VERIFY_TOKEN) {
    console.error('[WhatsApp Webhook] WHATSAPP_WEBHOOK_VERIFY_TOKEN is not configured');
    return res.status(503).send('Webhook verification not configured');
  }

  console.log('[WhatsApp Webhook] Verification request received');
  console.log('  URL:', req.originalUrl);
  console.log('  hub.mode:', mode);
  console.log('  hub.verify_token received:', token ? token.substring(0, 15) + '...' : 'UNDEFINED');
  console.log('  hub.verify_token expected:', VERIFY_TOKEN.substring(0, 15) + '...');
  console.log('  hub.challenge:', challenge ? challenge.toString().substring(0, 30) : 'UNDEFINED');
  console.log('  Query keys:', Object.keys(req.query));

  if (mode === 'subscribe' && token && token === VERIFY_TOKEN) {
    console.log('[WhatsApp Webhook] ✅ Verification SUCCESS — returning challenge');
    return res.status(200).send(String(challenge));
  }

  // Detailed failure log for debugging
  const failures = [];
  if (mode !== 'subscribe') failures.push(`hub.mode="${mode}" (expected "subscribe")`);
  if (!token) failures.push('hub.verify_token is missing');
  else if (token !== VERIFY_TOKEN) failures.push('hub.verify_token does NOT match VERIFY_TOKEN');
  if (!challenge) failures.push('hub.challenge is missing');

  console.log('[WhatsApp Webhook] ❌ Verification FAILED:', failures.join(' | '));
  console.log('[WhatsApp Webhook] Action: Set WHATSAPP_WEBHOOK_VERIFY_TOKEN env var to match the token you entered in Meta Developers → Configuration → Webhook → Verify Token');
  return res.status(403).send('Forbidden');
});

// ==================== ENTERPRISE WORKSPACE ====================

// GET /api/whatsapp/workspace — Cloud API connection + account status
router.get('/workspace', async (req, res) => {
  try {
    const userId = workspaceOf(req);
    const stored = integrationStorage.get(userId, 'whatsapp');
    const status = await whatsappTransport.getQrStatus(userId);

    let live = null;
    if (status.configured) {
      live = await whatsappTransport.verifyConnection(userId).catch((err) => ({ ok: false, error: err.message }));
    }

    res.json({
      success: true,
      connectionStatus: status.configured && live?.ok !== false ? 'connected' : (status.configured ? 'error' : 'disconnected'),
      configured: status.configured,
      provider: 'meta',
      transport: 'meta',
      credentialSource: status.credentialSource,
      lastConnectedAt: stored?.connectedAt || stored?.updatedAt || null,
      account: {
        phoneNumberId: status.phoneNumberId || null,
        wabaId: status.wabaId || null,
        displayPhoneNumber: live?.displayPhoneNumber || null,
        displayName: live?.verifiedName || live?.waba?.name || null,
        businessName: live?.waba?.name || null,
        displayNameStatus: live?.displayNameStatus || null,
        qualityRating: live?.qualityRating || null,
        messagingLimit: live?.messagingLimit || null,
        verifiedStatus: live?.codeVerificationStatus || null,
        platformType: 'cloud_api',
      },
      tokenStatus: !status.configured ? 'not_configured' : (live?.ok ? 'valid' : (live?.tokenStatus || 'invalid')),
      connectionError: live?.ok === false ? (live.error || null) : null,
      webhook: {
        url: '/api/whatsapp/webhook',
        verifyTokenConfigured: Boolean((process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '').trim()),
        signatureSecretConfigured: Boolean((process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET || '').trim()),
        note: 'Subscribe this URL in Meta App Dashboard → WhatsApp → Configuration → Webhook (fields: messages)',
      },
      connect: {
        mode: 'cloud_api',
        note: 'Set Meta Cloud API credentials (token, phone number ID, WABA ID) below or via environment variables',
      },
      campaignJob: getCampaignJob(userId),
    });
  } catch (error) {
    console.error('[WhatsApp] workspace error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/whatsapp/stats — live counters from messages table
router.get('/stats', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const counts = await conversationStorage.getMessageCountsByChannel({ workspaceId });
    const wa = counts.whatsapp || { sent: 0, replies: 0, delivered: 0, read: 0, failed: 0 };
    const sent = Number(wa.sent) || 0;
    const delivered = Number(wa.delivered) || 0;
    const read = Number(wa.read) || 0;
    const failed = Number(wa.failed) || 0;
    const replied = Number(wa.replies) || 0;
    const job = getCampaignJob(workspaceId);
    const queued = job.status === 'running' || job.status === 'paused'
      ? Math.max(0, (job.total || 0) - (job.sent || 0) - (job.failed || 0))
      : 0;
    const total = sent + replied;
    const responseRate = sent > 0 ? Math.round((replied / sent) * 1000) / 10 : 0;
    // delivered already includes read statuses from message counts
    const successRate = sent > 0 ? Math.round((delivered / sent) * 1000) / 10 : 0;

    res.json({
      success: true,
      stats: {
        total,
        queued,
        sent,
        delivered,
        read,
        failed,
        replied,
        responseRate,
        successRate,
      },
      campaignJob: job,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[WhatsApp] stats error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/whatsapp/logs — recent WhatsApp message activity from DB
router.get('/logs', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const limit = Math.min(parseInt(req.query.limit || '80', 10), 200);
    const conversations = await conversationStorage.getConversations({ workspaceId });
    const waConvs = (conversations || []).filter((c) => c.channel === 'whatsapp').slice(0, 40);
    const logs = [];
    for (const conv of waConvs) {
      const messages = await conversationStorage.getMessages(conv.id, { workspaceId });
      for (const m of messages || []) {
        logs.push({
          id: m.id,
          conversationId: conv.id,
          leadId: conv.leadId,
          direction: m.direction,
          status: m.status || null,
          body: (m.body || '').slice(0, 240),
          externalMessageId: m.externalMessageId || null,
          messageType: m.messageType || 'text',
          createdAt: m.createdAt,
          error: m.metadata?.error || null,
        });
      }
    }
    logs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    let timeline = [];
    try {
      const events = await timelineStorage.getWorkspaceEvents({ workspaceId, limit: 200 });
      timeline = (events || [])
        .filter((e) => e.channel === 'whatsapp' || ['message_delivered', 'message_read', 'message_sent', 'message_received'].includes(e.type))
        .slice(0, 40)
        .map((e) => ({
          id: e.id,
          type: e.type,
          leadId: e.leadId,
          channel: e.channel,
          createdAt: e.createdAt || e.created_at,
          payload: e.payload || null,
        }));
    } catch (_) { /* optional */ }

    res.json({ success: true, logs: logs.slice(0, limit), timeline, count: Math.min(logs.length, limit) });
  } catch (error) {
    console.error('[WhatsApp] logs error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/whatsapp/campaign-control — pause | resume | cancel | schedule
router.post('/campaign-control', (req, res) => {
  const workspaceId = workspaceOf(req);
  const { action, scheduledAt, total, payload } = req.body || {};
  const job = getCampaignJob(workspaceId);
  const act = String(action || '').toLowerCase();

  if (act === 'start') {
    job.status = 'running';
    job.total = Number(total) || job.total || 0;
    job.sent = 0;
    job.failed = 0;
    job.scheduledAt = null;
    if (payload) job.payload = payload;
  } else if (act === 'pause') {
    if (job.status === 'running') job.status = 'paused';
  } else if (act === 'resume') {
    if (job.status === 'paused' || job.status === 'cancelled') job.status = 'running';
  } else if (act === 'cancel') {
    job.status = 'cancelled';
  } else if (act === 'schedule') {
    job.status = 'scheduled';
    job.scheduledAt = scheduledAt || null;
    if (payload) job.payload = payload;
    if (total != null) job.total = Number(total) || 0;
  } else if (act === 'complete') {
    job.status = 'completed';
  } else {
    return res.status(400).json({ error: 'action must be start|pause|resume|cancel|schedule|complete' });
  }
  job.updatedAt = new Date().toISOString();
  waCampaignJobs.set(workspaceId, job);
  res.json({ success: true, campaignJob: job });
});

// GET /api/whatsapp/campaign-control
router.get('/campaign-control', (req, res) => {
  res.json({ success: true, campaignJob: getCampaignJob(workspaceOf(req)) });
});

// POST /api/whatsapp/ai-compose — write | rewrite | translate (real OpenAI when configured)
router.post('/ai-compose', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const userId = req.auth?.userId || workspaceId;
    const { action = 'write', text = '', language = 'en', tone = 'professional', businessType = 'business', goal = 'booking' } = req.body || {};

    const oa = await openAiKeyService.getOpenAiConfig(userId);
    if (!oa || oa.blocked) {
      return res.status(503).json({ error: oa?.reason || 'OpenAI not available', blocked: true });
    }

    let userPrompt = '';
    if (action === 'rewrite') {
      userPrompt = `Rewrite this WhatsApp message in a ${tone} tone. Keep meaning. Language: ${language}. Keep placeholders {name}/{city}/{niche}.\n\nMessage:\n${text}\n\nReturn JSON: {"message":"..."}`;
    } else if (action === 'translate') {
      userPrompt = `Translate this WhatsApp message to ${language}. Keep placeholders {name}, {city}, {niche}.\n\nMessage:\n${text}\n\nReturn JSON: {"message":"..."}`;
    } else {
      userPrompt = `Write a WhatsApp outreach message for a ${businessType}. Goal: ${goal}. Tone: ${tone}. Language: ${language}. Use placeholders {name}, {city}, {niche} where natural. Return JSON: {"message":"..."}`;
    }

    const parsed = await aiProvider.callOpenAI(
      [
        { role: 'system', content: 'You write concise WhatsApp business messages. Always return valid JSON with a message field.' },
        { role: 'user', content: userPrompt },
      ],
      0.7,
      500,
      { apiKey: oa.apiKey, model: oa.model, baseUrl: oa.baseUrl },
    );
    const message = String(parsed?.message || parsed?.text || '').trim();
    if (!message) throw new Error('AI returned an empty message');
    if (oa.source === 'master') {
      try { await openAiKeyService.consumeFreeMessage(userId, 'master'); } catch (_) { /* ignore */ }
    }
    res.json({ success: true, action, message, language, tone });
  } catch (error) {
    console.error('[WhatsApp] ai-compose error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/whatsapp/send-media — image | document | video
router.post('/send-media', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const { testMode: mediaTestMode = false } = req.body || {};
    if (!mediaTestMode && !isWhatsAppReady(workspaceId)) {
      return res.status(503).json({ error: 'WhatsApp not configured. Set Meta Cloud API credentials in Settings.' });
    }
    const {
      phone, leadId, mediaType = 'image', mediaUrl, caption = '', filename,
      testMode = false,
    } = req.body || {};
    if (!phone || !mediaUrl) {
      return res.status(400).json({ error: 'phone and mediaUrl are required' });
    }

    let result;
    if (mediaType === 'document') {
      result = await whatsappTransport.sendDocument({
        workspaceId,
        to: phone,
        documentUrl: mediaUrl,
        filename: filename || 'document.pdf',
        caption,
        testMode: !!testMode,
      });
    } else if (mediaType === 'video') {
      result = await whatsappTransport.sendVideo({
        workspaceId,
        to: phone,
        videoUrl: mediaUrl,
        caption,
        testMode: !!testMode,
      });
    } else {
      result = await whatsappTransport.sendImage({
        workspaceId,
        to: phone,
        imageUrl: mediaUrl,
        caption,
        testMode: !!testMode,
      });
    }

    if (leadId && !testMode) {
      try {
        // Verify lead exists before creating conversation (avoid orphan conversations)
        const leadExists = leadId.startsWith('contact:') || leadId.startsWith('orphan_')
          || await leadStorage.getLead(leadId, { workspaceId }).catch(() => null)
          || await contactStorage.findLeadByContact({ workspaceId, channel: 'whatsapp', value: leadId }).catch(() => null);
        if (!leadExists && !leadId.startsWith('orphan_')) {
          console.warn(`[WhatsApp] send-media: lead ${leadId} not found, skipping conversation storage`);
        } else {
          let conv = await conversationStorage.findConversation({ workspaceId, leadId, channel: 'whatsapp' });
          if (!conv) {
            conv = await conversationStorage.createConversation(
              { leadId, channel: 'whatsapp', subject: 'WhatsApp Outreach' },
              { workspaceId },
            );
          }
          await conversationStorage.addMessage(conv.id, {
            direction: 'outbound',
            body: caption || `[${mediaType} attachment]`,
            channel: 'whatsapp',
            source: 'composer',
            externalMessageId: result.messageId || null,
            messageType: mediaType,
            metadata: {
              mediaUrl,
              mediaType,
              filename: filename || null,
              imageUrl: mediaType === 'image' ? mediaUrl : undefined,
              attachments: [{
                url: mediaUrl,
                type: mediaType,
                filename: filename || null,
              }],
            },
          }, { workspaceId });
          await campaignStorage.recordSent(leadId, { workspaceId, channel: 'whatsapp' }).catch(() => null);
        }
      } catch (persistErr) {
        console.warn('[WhatsApp] media persist failed:', persistErr.message);
      }
    }

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[WhatsApp] send-media error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/whatsapp/test-connection — validate live Meta credentials + account info
router.post('/test-connection', async (req, res) => {
  try {
    const userId = workspaceOf(req);
    if (!whatsappTransport.isConfigured(userId)) {
      return res.status(503).json({ success: false, valid: false, error: 'Credentials not configured' });
    }
    const result = await whatsappTransport.verifyConnection(userId);
    if (!result.ok) {
      return res.json({ success: false, valid: false, error: result.error });
    }
    res.json({ success: true, valid: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, valid: false, error: error.message });
  }
});

router.getUserCredentials = getUserCredentials;
module.exports = router;
