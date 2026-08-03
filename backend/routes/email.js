/**
 * Email outreach routes (S4.3).
 * Mounted at /api/email behind requireAuth — all sends are workspace-scoped by the
 * authenticated caller. testMode previews the full path without delivering mail.
 */

const express = require('express');
const router = express.Router();
const { isEmailConfigured, isEmailConfiguredForWorkspace, sendEmailToLead } = require('../services/emailService');
const unifiedSend = require('../services/unifiedSend');
const leadStorage = require('../utils/leadStorage');
const emailTemplateStorage = require('../utils/emailTemplateStorage');
const conversationStorage = require('../utils/conversationStorage');
const timelineStorage = require('../utils/timelineStorage');
const integrationStorage = require('../utils/integrationStorage');
const userStorage = require('../utils/userStorage');
const contactStorage = require('../utils/contactStorage');
const { respondWithExternalError } = require('../utils/externalApiErrors');
const { verifyAndDecodeToken } = require('../utils/emailTracking');

const MAX_BATCH = 50;

const { workspaceOf } = require('../utils/workspaceContext');

// GET /api/email/status — is email delivery configured for this workspace?
router.get('/status', async (req, res) => {
  const workspaceId = workspaceOf(req);
  const stored = integrationStorage.get(workspaceId, 'email');
  // Only show "configured" when THIS workspace has stored OAuth credentials.
  // Do NOT fall back to env vars for the status display — that would make
  // every workspace appear connected to the same shared email.
  const configured = !!(stored?.connected && stored?.type === 'oauth2');
  const account = stored?.account || null;
  // sendable = true only if OAuth integration is connected.
  const sendable = configured;
  // Unified sender email: the user's explicitly configured sender email is the
  // single source of truth for the "From" address. OAuth account is auth-only.
  const userId = (req.auth && req.auth.userId) || workspaceId;
  const senderEmail = await userStorage.getSenderEmail(userId).catch(() => null);
  res.json({ configured, sendable, provider: 'gmail', account, senderEmail, type: stored?.type || null });
});

// POST /api/email/send — send (or preview) one email.
router.post('/send', async (req, res) => {
  try {
    const { lead, message, subject, campaign, testMode = false, imageUrl } = req.body;

    if (!lead || !lead.email) {
      return res.status(400).json({ error: 'Lead email is required' });
    }
    const workspaceId = workspaceOf(req);
    if (!testMode && !isEmailConfiguredForWorkspace(workspaceId)) {
      return res.status(503).json({
        error: 'Email not configured',
        message: 'Connect via OAuth in Settings.',
        setupRequired: true,
      });
    }

    // Resolve leadId (look up by email if not provided); create lead if missing so
    // EVERY sent email is recorded as a conversation.
    let leadId = lead.id;
    if (!leadId) {
      const matched = await contactStorage.findLeadByContact({ workspaceId, channel: 'email', value: lead.email });
      if (matched) leadId = matched.id;
    }
    if (!leadId) {
      const added = await leadStorage.addLeads([{ ...lead, workspaceId }], { workspaceId });
      if (added && added.length > 0) leadId = added[0].id;
    }

    // Build attachments if imageUrl provided
    const attachments = [];
    if (imageUrl) {
      attachments.push({
        filename: 'campaign-image.png',
        path: imageUrl,
        cid: 'campaign-image@leadflow.ai',
      });
    }

    // Resolve configured sender email (never use login email)
    const userId = (req.auth && req.auth.userId) || workspaceId;
    const senderEmail = await userStorage.getSenderEmail(userId).catch(() => null);

    const result = await unifiedSend.send({
      leadId,
      channel: 'email',
      body: message,
      subject,
      providerSend: async () => sendEmailToLead(lead, { message, subject, campaign, testMode, workspaceId, attachments, senderEmail }),
      metadata: { testMode, campaignName: campaign?.companyName, imageUrl, senderEmail },
      scheduleFollowUps: true,
      workspaceId,
    });

    res.json({
      success: true,
      message: testMode ? `🧪 TEST: email would be sent to ${lead.email}` : `Email sent to ${lead.email}`,
      messageId: result.messageId,
      testMode,
      email: lead.email,
      conversationId: result.conversationId || null,
    });
  } catch (error) {
    return respondWithExternalError(res, error, { route: 'POST /api/email/send', workspaceId: workspaceOf(req) }, 'Failed to send email');
  }
});

// POST /api/email/send-bulk — send (or preview) to multiple leads.
router.post('/send-bulk', async (req, res) => {
  try {
    const { leads, message, subject, campaign, testMode = false, imageUrl } = req.body;

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'Leads array is required' });
    }
    const workspaceId = workspaceOf(req);
    if (!testMode && !isEmailConfiguredForWorkspace(workspaceId)) {
      return res.status(503).json({
        error: 'Email not configured',
        message: 'Connect via OAuth in Settings.',
        setupRequired: true,
      });
    }
    if (leads.length > MAX_BATCH) {
      return res.status(400).json({
        error: 'Batch too large',
        message: `Maximum ${MAX_BATCH} emails per batch. You selected ${leads.length}.`,
      });
    }

    const results = [];
    const failed = [];
    let sent = 0;

    const allLeads = await leadStorage.getLeads({ workspaceId, limit: 10000 });

    // Build attachments once if imageUrl provided
    const attachments = [];
    if (imageUrl) {
      attachments.push({
        filename: 'campaign-image.png',
        path: imageUrl,
        cid: 'campaign-image@leadflow.ai',
      });
    }

    for (const lead of leads) {
      const email = lead.email;
      if (!email || email === 'N/A' || !email.includes('@')) {
        results.push({ leadId: lead.id, name: lead.name, status: 'failed', error: 'No valid email' });
        failed.push(lead);
        continue;
      }
      try {
        let leadId = lead.id;
        if (!leadId) {
          const matched = await contactStorage.findLeadByContact({ workspaceId, channel: 'email', value: email })
            || allLeads.find((l) => l.email && l.email.toLowerCase() === email.toLowerCase());
          if (matched) leadId = matched.id;
        }

        if (!leadId) {
        const added = await leadStorage.addLeads([{ ...lead, workspaceId }], { workspaceId });
        if (added && added.length > 0) leadId = added[0].id;
      }

      const r = await unifiedSend.send({
        leadId,
        channel: 'email',
        body: message,
        subject,
        providerSend: async () => sendEmailToLead(lead, { message, subject, campaign, testMode, workspaceId, attachments }),
        metadata: { testMode, campaignName: campaign?.companyName, imageUrl },
        scheduleFollowUps: false, // Bulk sends: don't re-schedule follow-ups for every lead
        workspaceId,
      });
        results.push({ leadId: lead.id || leadId, name: lead.name, email, status: 'sent', messageId: r.messageId });
        sent++;
      } catch (err) {
        results.push({ leadId: lead.id, name: lead.name, email, status: 'failed', error: err.message });
        failed.push(lead);
      }
    }

    res.json({
      success: sent > 0,
      total: leads.length,
      sent,
      failed: failed.length,
      skipped: leads.length - sent - failed.length,
      testMode,
      results,
    });
  } catch (error) {
    return respondWithExternalError(res, error, { route: 'POST /api/email/send-bulk', workspaceId: workspaceOf(req) }, 'Bulk send failed');
  }
});

// ===================== E2: Email Templates =====================

router.get('/templates', async (req, res) => {
  try {
    const templates = await emailTemplateStorage.list();
    res.json({ success: true, templates });
  } catch (error) {
    console.error('[Email] list templates error:', error.message);
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

router.post('/templates', async (req, res) => {
  try {
    const { name, subject, body, variables } = req.body;
    if (!name || !subject || !body) {
      return res.status(400).json({ error: 'name, subject, and body are required' });
    }
    const template = await emailTemplateStorage.create({ name, subject, body, variables: variables || ['name', 'city', 'niche'] });
    res.json({ success: true, template });
  } catch (error) {
    console.error('[Email] create template error:', error.message);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const updated = await emailTemplateStorage.update(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true, template: updated });
  } catch (error) {
    console.error('[Email] update template error:', error.message);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    const deleted = await emailTemplateStorage.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('[Email] delete template error:', error.message);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// ===================== E3: Email Intelligence =====================

// POST /api/email/receive — webhook for inbound email replies (via email forwarding or parsing service)
router.post('/receive', async (req, res) => {
  try {
    const { from, subject, text, html, inReplyTo, messageId } = req.body;
    if (!from || !text) {
      return res.status(400).json({ error: 'from and text are required' });
    }
    const workspaceId = workspaceOf(req);

    // Find lead by email
    const lead = await contactStorage.findLeadByContact({ workspaceId, channel: 'email', value: from });
    if (!lead) {
      console.warn(`[Email Receive] No lead found for email ${from}`);
      return res.status(404).json({ error: 'Lead not found' });
    }

    // Find or create email conversation
    let conv = await conversationStorage.findConversation({ workspaceId, leadId: lead.id, channel: 'email' });
    if (!conv) {
      conv = await conversationStorage.createConversation({ leadId: lead.id, channel: 'email', subject: subject || 'Re: Outreach' }, { workspaceId });
    }

    // Store inbound message
    const msg = await conversationStorage.addMessage(conv.id, {
      direction: 'inbound',
      body: text,
      channel: 'email',
      source: 'inbound',
      messageType: 'email',
      metadata: { html, inReplyTo, messageId, subject },
    }, { workspaceId });

    // Record timeline event
    await timelineStorage.recordEvent({
      leadId: lead.id,
      workspaceId,
      type: 'message_received',
      channel: 'email',
      conversationId: conv.id,
      referenceId: messageId || msg.id,
      payload: { subject, preview: text.slice(0, 200) },
    });

    res.json({ success: true, message: 'Inbound email recorded', conversationId: conv.id, messageId: msg.id });
  } catch (error) {
    console.error('[Email] receive error:', error.message);
    res.status(500).json({ error: 'Failed to process inbound email' });
  }
});

// POST /api/email/inbox/session/start — Inbox page opened; begin low-frequency Gmail sync
router.post('/inbox/session/start', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const emailInboxService = require('../services/emailInboxService');
    const result = emailInboxService.beginSession(workspaceId);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/email/inbox/session/stop — Inbox page closed/hidden; stop Gmail sync
router.post('/inbox/session/stop', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const emailInboxService = require('../services/emailInboxService');
    const result = emailInboxService.endSession(workspaceId);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/email/sync — manual inbox refresh (Inbox page only, requires active session)
router.post('/sync', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const emailInboxService = require('../services/emailInboxService');
    const result = await emailInboxService.syncNow(workspaceId);
    if (result.reason === 'inbox_session_inactive') {
      return res.status(409).json({
        success: false,
        error: 'Inbox session not active',
        message: 'Open the Inbox page to sync Gmail.',
        ...result,
      });
    }
    if (result.suspended) {
      return res.status(429).json({
        success: false,
        error: 'Gmail rate limit cooldown active',
        rateLimited: true,
        ...result,
      });
    }
    res.json({ success: true, ...result });
  } catch (error) {
    return respondWithExternalError(res, error, { route: 'POST /api/email/sync', workspaceId: workspaceOf(req) }, 'Failed to sync inbox');
  }
});

// GET /api/email/tracking/open — 1x1 transparent tracking pixel (HMAC-signed token)
router.get('/tracking/open', async (req, res) => {
  try {
    const { e } = req.query;
    if (!e) return res.status(400).end();
    const decoded = verifyAndDecodeToken(String(e));
    const { leadId, conversationId, messageId, workspaceId = 'default' } = decoded;
    if (!leadId) return res.status(400).end();

    await timelineStorage.recordEvent({
      leadId,
      workspaceId,
      type: 'email_opened',
      channel: 'email',
      conversationId,
      referenceId: messageId,
      payload: { openedAt: new Date().toISOString(), userAgent: req.headers['user-agent'], ip: req.ip },
    });

    // Return 1x1 transparent GIF
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  } catch (error) {
    console.error('[Email] open tracking error:', error.message);
    res.status(400).end();
  }
});

// GET /api/email/tracking/click — redirect with click logging (HMAC-signed token)
router.get('/tracking/click', async (req, res) => {
  try {
    const { e, url } = req.query;
    if (!e) return res.status(400).end();
    const decoded = verifyAndDecodeToken(String(e));
    const { leadId, conversationId, messageId, workspaceId = 'default', targetUrl } = decoded;
    if (!leadId) return res.status(400).end();

    // Prefer signed target from payload; query `url` is fallback only when unsigned/dev
    let redirectTo = typeof targetUrl === 'string' && targetUrl
      ? targetUrl
      : (url ? String(url) : '');
    if (!redirectTo) return res.status(400).end();

    try {
      const parsed = new URL(redirectTo);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).end();
      }
      if (parsed.username || parsed.password) return res.status(400).end();
    } catch (_) {
      return res.status(400).end();
    }

    // If both signed and query provided, prefer signed target (anti open-redirect)
    if (targetUrl && url && String(url) !== String(targetUrl)) {
      redirectTo = String(targetUrl);
    }

    await timelineStorage.recordEvent({
      leadId,
      workspaceId,
      type: 'link_clicked',
      channel: 'email',
      conversationId,
      referenceId: messageId,
      payload: { url: redirectTo, clickedAt: new Date().toISOString(), userAgent: req.headers['user-agent'], ip: req.ip },
    });

    res.redirect(302, redirectTo);
  } catch (error) {
    console.error('[Email] click tracking error:', error.message);
    res.status(400).end();
  }
});

module.exports = router;
