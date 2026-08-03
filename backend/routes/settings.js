/**
 * Settings Routes — Preview & Trust Mode preferences.
 *
 * Endpoints:
 *   GET  /api/settings/preview  → read current preview settings
 *   POST /api/settings/preview  → update preview settings
 */

const express = require('express');
const router = express.Router();
const userStorage = require('../utils/userStorage');
const { mergeAiAgentConfig, DEFAULT_AI_AGENT_CONFIG, assessAiKnowledgeStatus } = require('../utils/aiAgentConfig');

const { workspaceOf } = require('../utils/workspaceContext');

function userIdOf(req) {
  return (req.auth && req.auth.userId) || req.auth?.sub || workspaceOf(req);
}

// GET /api/settings/preview
router.get('/preview', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const settings = await userStorage.getPreviewSettings(userId);
    const user = await userStorage.findById(userId);
    const defaults = {
      whatsappPreview: false,
      emailPreview: false,
      smsPreview: false,
      previewPhone: user?.whatsapp_number || user?.whatsappNumber || '',
      previewEmail: user?.email || '',
    };
    res.json({ success: true, settings: { ...defaults, ...settings } });
  } catch (error) {
    console.error('[Settings] Get preview settings error:', error.message);
    res.status(500).json({ error: 'Failed to load preview settings' });
  }
});

// POST /api/settings/preview
router.post('/preview', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const { whatsappPreview, emailPreview, smsPreview, previewPhone, previewEmail } = req.body || {};
    const current = await userStorage.getPreviewSettings(userId);
    const updated = {
      ...current,
      ...(typeof whatsappPreview === 'boolean' && { whatsappPreview }),
      ...(typeof emailPreview === 'boolean' && { emailPreview }),
      ...(typeof smsPreview === 'boolean' && { smsPreview }),
      ...(previewPhone !== undefined && { previewPhone: String(previewPhone).trim() }),
      ...(previewEmail !== undefined && { previewEmail: String(previewEmail).trim() }),
    };
    await userStorage.updatePreviewSettings(userId, updated);
    res.json({ success: true, settings: updated });
  } catch (error) {
    console.error('[Settings] Update preview settings error:', error.message);
    res.status(500).json({ error: 'Failed to update preview settings' });
  }
});

// GET /api/settings/email
router.get('/email', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const settings = await userStorage.getEmailSettings(userId);
    res.json({ success: true, settings });
  } catch (error) {
    console.error('[Settings] Get email settings error:', error.message);
    res.status(500).json({ error: 'Failed to load email settings' });
  }
});

// POST /api/settings/email
router.post('/email', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const { includeUnsubscribeFooter } = req.body || {};
    const current = await userStorage.getEmailSettings(userId);
    const updated = {
      ...current,
      ...(typeof includeUnsubscribeFooter === 'boolean' && { includeUnsubscribeFooter }),
    };
    await userStorage.updateEmailSettings(userId, updated);
    res.json({ success: true, settings: updated });
  } catch (error) {
    console.error('[Settings] Update email settings error:', error.message);
    res.status(500).json({ error: 'Failed to update email settings' });
  }
});

// GET /api/settings/ai-agent
router.get('/ai-agent', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const user = await userStorage.findById(userId).catch(() => null);
    const stored = await userStorage.getAiAgentConfig(userId);
    const settings = mergeAiAgentConfig(stored, user);
    const knowledgeStatus = assessAiKnowledgeStatus(stored, user);
    res.json({ success: true, settings, knowledgeStatus });
  } catch (error) {
    console.error('[Settings] Get AI agent config error:', error.message);
    res.json({
      success: false,
      settings: mergeAiAgentConfig({}, null),
      knowledgeStatus: assessAiKnowledgeStatus({}, null),
      error: 'Failed to load AI Sales Agent settings',
    });
  }
});

// POST /api/settings/ai-agent
router.post('/ai-agent', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const body = req.body || {};
    const allowed = Object.keys(DEFAULT_AI_AGENT_CONFIG);
    const updates = {};
    for (const key of allowed) {
      if (body[key] !== undefined) updates[key] = body[key];
    }
    const saved = await userStorage.updateAiAgentConfig(userId, updates);
    const user = await userStorage.findById(userId);
    res.json({
      success: true,
      settings: mergeAiAgentConfig(saved, user),
      knowledgeStatus: assessAiKnowledgeStatus(saved, user),
    });
  } catch (error) {
    console.error('[Settings] Update AI agent config error:', error.message);
    res.status(500).json({ error: 'Failed to update AI Sales Agent settings' });
  }
});

module.exports = router;
