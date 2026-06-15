/**
 * Email outreach routes (S4.3).
 * Mounted at /api/email behind requireAuth — all sends are workspace-scoped by the
 * authenticated caller. testMode previews the full path without delivering mail.
 */

const express = require('express');
const router = express.Router();
const { isEmailConfigured, sendEmailToLead } = require('../services/emailService');

const MAX_BATCH = 50;

// GET /api/email/status — is email delivery configured on this backend?
router.get('/status', (req, res) => {
  res.json({ configured: isEmailConfigured(), provider: 'gmail' });
});

// POST /api/email/send — send (or preview) one email.
router.post('/send', async (req, res) => {
  try {
    const { lead, message, subject, campaign, testMode = false } = req.body;

    if (!lead || !lead.email) {
      return res.status(400).json({ error: 'Lead email is required' });
    }
    if (!testMode && !isEmailConfigured()) {
      return res.status(503).json({
        error: 'Email not configured',
        message: 'Set EMAIL_USER and EMAIL_PASS environment variables, then restart the server.',
        setupRequired: true,
      });
    }

    const result = await sendEmailToLead(lead, { message, subject, campaign, testMode });
    res.json({
      success: true,
      message: testMode ? `🧪 TEST: email would be sent to ${lead.email}` : `Email sent to ${lead.email}`,
      messageId: result.messageId,
      testMode,
      email: lead.email,
    });
  } catch (error) {
    console.error('[Email] send error:', error.message);
    res.status(500).json({ error: 'Failed to send email', message: error.message });
  }
});

// POST /api/email/send-bulk — send (or preview) to multiple leads.
router.post('/send-bulk', async (req, res) => {
  try {
    const { leads, message, subject, campaign, testMode = false } = req.body;

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'Leads array is required' });
    }
    if (!testMode && !isEmailConfigured()) {
      return res.status(503).json({
        error: 'Email not configured',
        message: 'Set EMAIL_USER and EMAIL_PASS environment variables, then restart the server.',
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

    for (const lead of leads) {
      const email = lead.email;
      if (!email || email === 'N/A' || !email.includes('@')) {
        results.push({ leadId: lead.id, name: lead.name, status: 'failed', error: 'No valid email' });
        failed.push(lead);
        continue;
      }
      try {
        const r = await sendEmailToLead(lead, { message, subject, campaign, testMode });
        results.push({ leadId: lead.id, name: lead.name, email, status: 'sent', messageId: r.messageId });
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
    console.error('[Email] bulk send error:', error.message);
    res.status(500).json({ error: 'Bulk send failed', message: error.message });
  }
});

module.exports = router;
