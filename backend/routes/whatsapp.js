/**
 * WhatsApp Meta Cloud API Routes
 * Production-ready endpoints for WhatsApp Business messaging
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const {
  sendTextMessage,
  sendTemplateMessage,
  getBusinessInfo,
  getMessageTemplates,
  validateCredentials,
  formatPhoneNumber
} = require('../services/whatsappMeta');

/**
 * Resolve the credential key (workspace) for a request.
 * Prefers the authenticated workspace (req.auth.workspaceId, set by auth middleware),
 * falls back to the legacy x-user-id header, then 'default'.
 * The webhook is unauthenticated and has neither, so it resolves to 'default'.
 */
function workspaceOf(req) {
  return (req.auth && req.auth.workspaceId) || req.headers['x-user-id'] || 'default';
}

// ==================== PERSISTENT USER CREDENTIALS STORAGE ====================
const CREDENTIALS_FILE = path.join(__dirname, '..', 'data', 'whatsapp_credentials.json');
const CREDENTIALS_TMP = path.join(__dirname, '..', 'data', 'whatsapp_credentials.json.tmp');

function ensureDataDir() {
  const dataDir = path.dirname(CREDENTIALS_FILE);
  if (!fs.existsSync(dataDir)) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      console.log('[WhatsApp] Created data directory:', dataDir);
    } catch (err) {
      console.error('[WhatsApp] Failed to create data directory:', err.message);
    }
  }
}

ensureDataDir();

// In-memory credential cache
let userCredentials = new Map();
let lastLoadTime = 0;

/**
 * Reload credentials from file into memory.
 * Called at startup, periodically, and on-demand when a lookup misses.
 */
function reloadCredentialsFromFile() {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      return;
    }
    const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw);
    const previousSize = userCredentials.size;
    Object.entries(parsed).forEach(([key, val]) => userCredentials.set(key, val));
    lastLoadTime = Date.now();
    if (userCredentials.size !== previousSize || previousSize === 0) {
      console.log('[WhatsApp] Reloaded', userCredentials.size, 'credential set(s) from file');
    }
  } catch (err) {
    console.error('[WhatsApp] Failed to reload credentials file:', err.message);
  }
}

// Initial load at startup
reloadCredentialsFromFile();

/**
 * Atomic file write: write to temp, then rename.
 * Prevents corruption if process crashes during write.
 */
function saveCredentialsFile() {
  ensureDataDir();
  try {
    const obj = {};
    userCredentials.forEach((val, key) => { obj[key] = val; });
    const json = JSON.stringify(obj, null, 2);
    fs.writeFileSync(CREDENTIALS_TMP, json, { encoding: 'utf8' });
    fs.renameSync(CREDENTIALS_TMP, CREDENTIALS_FILE);
    console.log('[WhatsApp] Credentials saved to file (atomic write)');
  } catch (err) {
    console.error('[WhatsApp] Failed to save credentials file:', err.message);
  }
}

/**
 * Get credentials for a user.
 * 1. Try in-memory cache
 * 2. If miss, reload from file (handles server restarts)
 * 3. If still miss, fall back to environment variables
 */
function getUserCredentials(userId = 'default') {
  if (userCredentials.has(userId)) {
    return userCredentials.get(userId);
  }

  // Miss in memory — try reloading from file (server may have restarted)
  reloadCredentialsFromFile();

  if (userCredentials.has(userId)) {
    return userCredentials.get(userId);
  }

  // Final fallback: environment variables (production-stable)
  return {
    token: process.env.WHATSAPP_TOKEN || null,
    phoneNumberId: process.env.PHONE_NUMBER_ID || null,
    wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || null
  };
}

function setUserCredentials(userId, credentials) {
  userCredentials.set(userId, {
    ...credentials,
    updatedAt: new Date().toISOString()
  });
  saveCredentialsFile();
}

// Auto-reload credentials every 10 seconds to survive Render restarts / filesystem sync issues
setInterval(() => {
  reloadCredentialsFromFile();
}, 10000);

// ==================== CREDENTIALS MANAGEMENT ====================

// POST /api/whatsapp/credentials - Save user credentials
router.post('/credentials', async (req, res) => {
  try {
    const { token, phoneNumberId, wabaId } = req.body;
    const userId = workspaceOf(req);

    if (!token || !phoneNumberId) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Both token and phoneNumberId are required'
      });
    }

    // Validate credentials before saving
    const validation = await validateCredentials(token, phoneNumberId);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid credentials',
        message: validation.error
      });
    }

    // Save credentials (in production, encrypt these!)
    setUserCredentials(userId, { token, phoneNumberId, wabaId: wabaId || null });

    res.json({
      success: true,
      message: 'WhatsApp credentials saved successfully',
      phoneNumberId: phoneNumberId.substring(0, 6) + '****' // Partially masked
    });
  } catch (error) {
    console.error('❌ Save credentials error:', error.message);
    res.status(500).json({
      error: 'Failed to save credentials',
      message: error.message
    });
  }
});

// GET /api/whatsapp/credentials - Check if credentials exist (safe - no token exposure)
router.get('/credentials', (req, res) => {
  const userId = workspaceOf(req);
  const creds = getUserCredentials(userId);

  const hasCredentials = !!(creds.token && creds.phoneNumberId);

  res.json({
    configured: hasCredentials,
    hasToken: !!creds.token,
    hasPhoneNumberId: !!creds.phoneNumberId,
    phoneNumberId: creds.phoneNumberId ? creds.phoneNumberId.substring(0, 6) + '****' : null
  });
});

// DELETE /api/whatsapp/credentials - Remove stored credentials
router.delete('/credentials', (req, res) => {
  const userId = workspaceOf(req);
  userCredentials.delete(userId);
  saveCredentialsFile();
  res.json({ success: true, message: 'Credentials removed' });
});

// POST /api/whatsapp/validate - Validate token without saving
router.post('/validate', async (req, res) => {
  try {
    const { token, phoneNumberId } = req.body;

    if (!token || !phoneNumberId) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Both token and phoneNumberId are required'
      });
    }

    console.log('[WhatsApp] Validating credentials for phoneNumberId:', phoneNumberId.substring(0, 6) + '****');
    const validation = await validateCredentials(token, phoneNumberId);

    if (validation.valid) {
      console.log('[WhatsApp] Validation SUCCESS');
      res.json({ valid: true, message: 'Credentials are valid' });
    } else {
      console.log('[WhatsApp] Validation FAILED:', validation.error);
      res.status(400).json({ valid: false, error: validation.error });
    }
  } catch (error) {
    console.error('[WhatsApp] Validation error:', error.message);
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
      testMode = false
    } = req.body;

    const userId = workspaceOf(req);
    const credentials = getUserCredentials(userId);

    if (!testMode && (!credentials.token || !credentials.phoneNumberId)) {
      return res.status(503).json({
        error: 'WhatsApp not configured',
        message: 'Please configure WhatsApp credentials first',
        setupRequired: true
      });
    }

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const formattedPhone = formatPhoneNumber(phone);
    let result;

    if (useTemplate && templateName) {
      // Send template message
      result = await sendTemplateMessage({
        token: credentials.token,
        phoneNumberId: credentials.phoneNumberId,
        to: formattedPhone,
        templateName,
        languageCode,
        templateParams,
        testMode
      });
    } else {
      // Send text message
      if (!message) {
        return res.status(400).json({ error: 'Message is required for text messages' });
      }
      result = await sendTextMessage({
        token: credentials.token,
        phoneNumberId: credentials.phoneNumberId,
        to: formattedPhone,
        message,
        testMode
      });
    }

    res.json({
      success: true,
      message: testMode
        ? '🧪 TEST: Message would be sent'
        : `WhatsApp message sent to ${formattedPhone}`,
      messageId: result.messageId,
      status: result.status,
      testMode: result.testMode || false,
      phone: formattedPhone
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
const sessionSentPhones = new Set();

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

    if (!testMode && (!credentials.token || !credentials.phoneNumberId)) {
      console.log('[WhatsApp] Bulk send blocked: credentials not configured');
      return res.status(503).json({
        error: 'WhatsApp not configured',
        message: 'Please configure WhatsApp credentials first',
        setupRequired: true
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

    console.log(`[WhatsApp] Starting bulk send: ${leads.length} leads, testMode=${testMode}, template=${useTemplate}`);

    const results = [];
    const failed = [];
    let sentCount = 0;

    for (let i = 0; i < leads.length; i++) {
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

          if (useTemplate && templateName) {
            const params = templateParams.length > 0
              ? templateParams
              : [lead.name || 'there', lead.city || '', lead.niche || ''];

            result = await sendTemplateMessage({
              token: credentials.token,
              phoneNumberId: credentials.phoneNumberId,
              to: formattedPhone,
              templateName,
              languageCode,
              templateParams: params,
              testMode
            });
          } else {
            let personalizedMessage = message || 'Hello!';
            personalizedMessage = personalizedMessage
              .replace(/{name}/g, lead.name || 'there')
              .replace(/{city}/g, lead.city || '')
              .replace(/{niche}/g, lead.niche || lead.business || 'business')
              .replace(/{company}/g, lead.company || lead.companyName || 'our company')
              .replace(/{product}/g, lead.product || 'our services')
              .replace(/{offer}/g, lead.offer || '');

            result = await sendTextMessage({
              token: credentials.token,
              phoneNumberId: credentials.phoneNumberId,
              to: formattedPhone,
              message: personalizedMessage,
              testMode
            });
          }

          success = true;
          sessionSentPhones.add(phoneSessionKey);
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
      } else {
        results.push({
          leadId: lead.id,
          name: lead.name,
          status: 'failed',
          error: lastError?.message || 'Unknown error',
          notOnWhatsApp: lastError?.message?.includes('not registered') || lastError?.message?.includes('not on WhatsApp')
        });
        failed.push({ ...lead, error: lastError?.message });
      }

      // Rate-limit safe delay between messages (except last one)
      if (i < leads.length - 1) {
        const actualDelay = testMode ? Math.min(delayMs, 500) : delayMs;
        console.log(`[WhatsApp] Delay ${actualDelay}ms before next message (${i + 1}/${leads.length})`);
        await new Promise(resolve => setTimeout(resolve, actualDelay));
      }
    }

    console.log(`[WhatsApp] Bulk send complete: ${sentCount} sent, ${failed.length} failed, ${leads.length} total`);

    res.json({
      success: sentCount > 0,
      total: leads.length,
      sent: sentCount,
      failed: failed.length,
      skipped: leads.length - sentCount - failed.length,
      testMode,
      results
    });

  } catch (error) {
    console.error('[WhatsApp] Bulk send fatal error:', error.message);
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
      // Return demo templates if no credentials
      return res.json({
        success: true,
        templates: [
          { name: 'hello_world', status: 'APPROVED', language: 'en_US', category: 'MARKETING' },
          { name: 'welcome_message', status: 'APPROVED', language: 'en_US', category: 'UTILITY' }
        ],
        demo: true,
        message: 'Showing demo templates. Configure credentials to see your real templates.'
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

// GET /api/whatsapp/status - Check WhatsApp configuration status
router.get('/status', (req, res) => {
  const userId = workspaceOf(req);

  // Force reload if missing (defensive for Render restarts)
  if (!userCredentials.has(userId)) {
    reloadCredentialsFromFile();
  }

  const credentials = getUserCredentials(userId);
  const hasCredentials = !!(credentials.token && credentials.phoneNumberId);
  const fromFile = userCredentials.has(userId);
  const fromEnv = !fromFile && !!(process.env.WHATSAPP_TOKEN && process.env.PHONE_NUMBER_ID);

  res.json({
    configured: hasCredentials,
    hasToken: !!credentials.token,
    hasPhoneNumberId: !!credentials.phoneNumberId,
    hasWabaId: !!credentials.wabaId,
    provider: 'meta',
    source: fromFile ? 'file' : (fromEnv ? 'env' : null),
    envFallback: fromEnv
  });
});

// GET /api/whatsapp/diagnostics - Debug credential state (safe, masked)
router.get('/diagnostics', (req, res) => {
  const userId = workspaceOf(req);
  const fileExists = fs.existsSync(CREDENTIALS_FILE);
  const fileSize = fileExists ? fs.statSync(CREDENTIALS_FILE).size : 0;

  const creds = getUserCredentials(userId);
  const fromFile = userCredentials.has(userId);

  res.json({
    fileExists,
    fileSize,
    filePath: CREDENTIALS_FILE,
    memoryCacheSize: userCredentials.size,
    lastLoadTime: lastLoadTime ? new Date(lastLoadTime).toISOString() : null,
    envVarsSet: {
      WHATSAPP_TOKEN: !!process.env.WHATSAPP_TOKEN,
      PHONE_NUMBER_ID: !!process.env.PHONE_NUMBER_ID,
      WHATSAPP_BUSINESS_ACCOUNT_ID: !!process.env.WHATSAPP_BUSINESS_ACCOUNT_ID
    },
    configured: !!(creds.token && creds.phoneNumberId),
    source: fromFile ? 'file' : 'env_or_none',
    tokenPreview: creds.token ? creds.token.substring(0, 8) + '****' : null,
    phoneNumberIdPreview: creds.phoneNumberId ? creds.phoneNumberId.substring(0, 6) + '****' : null
  });
});

// GET /api/whatsapp/business-info - Get WhatsApp Business info
router.get('/business-info', async (req, res) => {
  try {
    const userId = workspaceOf(req);
    const credentials = getUserCredentials(userId);

    if (!credentials.token || !credentials.phoneNumberId) {
      return res.status(503).json({
        error: 'WhatsApp not configured',
        message: 'Please configure WhatsApp credentials first'
      });
    }

    const result = await getBusinessInfo(credentials.token, credentials.phoneNumberId);
    res.json(result);

  } catch (error) {
    res.status(500).json({
      error: 'Failed to get business info',
      message: error.message
    });
  }
});

// ==================== AUTO-REPLY TEST ENDPOINT ====================

// POST /api/whatsapp/test-reply - Manually test auto-reply
router.post('/test-reply', async (req, res) => {
  try {
    const { phone, message = 'Hi' } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const userId = workspaceOf(req);
    const credentials = getUserCredentials(userId);

    if (!credentials.token || !credentials.phoneNumberId) {
      return res.status(503).json({
        error: 'WhatsApp not configured',
        message: 'Please save credentials first via POST /api/whatsapp/credentials'
      });
    }

    // Simulate the auto-reply logic
    let replyText = 'Hello! This is an auto reply from AI agent.';
    const lowerText = message.toLowerCase();
    if (lowerText.includes('hi') || lowerText.includes('hello')) {
      replyText = 'Hello! This is an auto reply from AI agent. How can I help you today?';
    }

    console.log(`🧪 TEST: Sending auto-reply to ${phone}: "${replyText}"`);

    const result = await sendReply({
      token: credentials.token,
      phoneNumberId: credentials.phoneNumberId,
      to: phone,
      message: replyText
    });

    res.json({
      success: true,
      message: 'Test auto-reply sent',
      recipient: phone,
      replyText: replyText,
      messageId: result.messageId
    });

  } catch (error) {
    console.error('❌ Test reply error:', error.message);
    res.status(500).json({
      error: 'Test reply failed',
      message: error.message
    });
  }
});

// ==================== WEBHOOK (receiving messages & status updates) ====================
const { sendReply } = require('../services/whatsappMeta');

/**
 * Parse incoming message from Meta webhook payload
 * Structure: entry[0].changes[0].value.messages[0]
 */
function parseIncomingMessage(body) {
  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Status updates (delivered, read, sent) - ignore for auto-reply
    if (value?.statuses) {
      return { type: 'status', statuses: value.statuses };
    }

    // Incoming messages
    const messages = value?.messages;
    if (messages && messages.length > 0) {
      const msg = messages[0];
      return {
        type: 'message',
        from: msg.from,           // sender's phone number
        messageId: msg.id,         // message ID for reply context
        timestamp: msg.timestamp,
        text: msg.text?.body || '',
        type: msg.type
      };
    }

    return { type: 'unknown' };
  } catch (err) {
    console.error('❌ Error parsing webhook payload:', err.message);
    return { type: 'error', error: err.message };
  }
}

// POST /api/whatsapp/webhook - Receive Meta webhook events
router.post('/webhook', async (req, res) => {
  try {
    // Always acknowledge webhook immediately (Meta requires < 20s response)
    res.status(200).send('OK');

    const body = req.body;
    console.log('📩 Webhook received at', new Date().toISOString());

    // Parse the incoming payload
    const parsed = parseIncomingMessage(body);

    // Handle status updates (delivered, read, sent)
    if (parsed.type === 'status') {
      parsed.statuses.forEach(status => {
        console.log(`📊 Status update: ${status.status} for message ${status.id}`);
      });
      return;
    }

    // Handle incoming messages
    if (parsed.type === 'message') {
      const { from, text, messageId } = parsed;
      console.log(`📨 Incoming message from ${from}: "${text}"`);

      // Skip if no text
      if (!text || !from) {
        console.log('⚠️ No text or sender found, skipping');
        return;
      }

      // Webhook is unauthenticated (Meta has no user token) → default workspace.
      const userId = workspaceOf(req);
      const credentials = getUserCredentials(userId);

      // Check if credentials exist
      if (!credentials.token || !credentials.phoneNumberId) {
        console.error('❌ No WhatsApp credentials configured. Cannot send auto-reply.');
        console.log('   Please configure credentials via POST /api/whatsapp/credentials');
        return;
      }

      // Build auto-reply message
      let replyText = 'Hello! This is an auto reply from AI agent.';

      // Simple keyword-based replies (expandable)
      const lowerText = text.toLowerCase();
      if (lowerText.includes('hi') || lowerText.includes('hello') || lowerText.includes('hey')) {
        replyText = 'Hello! This is an auto reply from AI agent. How can I help you today?';
      } else if (lowerText.includes('help')) {
        replyText = 'I can help you with:\n• General inquiries\n• Business information\n• Appointment booking\n\nWhat do you need?';
      } else if (lowerText.includes('price') || lowerText.includes('cost') || lowerText.includes('how much')) {
        replyText = 'Thank you for your interest! Please share more details about what you need, and I will provide pricing information.';
      } else if (lowerText.includes('thank')) {
        replyText = 'You are welcome! Let me know if you need anything else.';
      } else if (lowerText.includes('bye') || lowerText.includes('goodbye')) {
        replyText = 'Goodbye! Have a great day. Feel free to message us anytime.';
      }

      console.log(`🤖 Sending auto-reply to ${from}: "${replyText}"`);

      // Send the reply via Meta API
      const result = await sendReply({
        token: credentials.token,
        phoneNumberId: credentials.phoneNumberId,
        to: from,
        message: replyText,
        replyToMessageId: messageId
      });

      console.log(`✅ Auto-reply sent! Message ID: ${result.messageId}`);
    }

  } catch (error) {
    console.error('❌ Webhook processing error:', error.message);
    // Already responded 200 OK above, so just log the error
  }
});

// GET /api/whatsapp/webhook - Meta webhook verification
router.get('/webhook', (req, res) => {
  // Meta sends: hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>
  // Support both flat querystring keys (default Express) and nested (qs library with allowDots)
  const mode = req.query['hub.mode'] || req.query?.hub?.mode;
  const token = (req.query['hub.verify_token'] || req.query?.hub?.verify_token || '').toString().trim();
  const challenge = req.query['hub.challenge'] || req.query?.hub?.challenge;

  const VERIFY_TOKEN = (process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'leadgen-verify-token').toString().trim();

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

module.exports = router;
