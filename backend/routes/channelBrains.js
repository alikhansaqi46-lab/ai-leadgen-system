/**
 * Channel Brain Configuration Routes — per-channel independent AI brain settings.
 *
 * Each channel (whatsapp, email, sms) has its own completely independent:
 *   - Business Knowledge (companyDescription, products, services, pricing, etc.)
 *   - FAQs
 *   - System Prompt
 *   - Tone
 *   - Reply Rules
 *   - Follow-up Strategy
 *   - Campaign Instructions
 *   - Conversation Memory Settings
 *   - AI Enable/Disable
 *
 * Endpoints:
 *   GET  /api/channel-brains/:channel  → get brain config for a channel
 *   POST /api/channel-brains/:channel  → update brain config for a channel
 */

const express = require('express');
const router = express.Router();
const userStorage = require('../utils/userStorage');

const { workspaceOf } = require('../utils/workspaceContext');

const VALID_CHANNELS = ['whatsapp', 'email', 'sms'];

function userIdOf(req) {
  return (req.auth && req.auth.userId) || req.auth?.sub || workspaceOf(req);
}

/**
 * Default channel brain configuration.
 * Each channel brain starts with these defaults when no config is stored yet.
 */
const DEFAULT_CHANNEL_BRAIN_CONFIG = {
  // AI Enable/Disable
  aiEnabled: true,

  // Business Knowledge
  businessName: '',
  companyDescription: '',
  products: '',
  services: '',
  pricing: '',
  features: '',
  offers: '',
  promotions: '',

  // FAQs
  faqs: '',

  // System Prompt
  systemPrompt: '',

  // Tone
  tone: 'professional and friendly',
  writingStyle: 'concise, clear, and helpful',

  // Reply Rules
  replyRules: '',
  humanTakeoverKeywords: ['human', 'agent', 'call me', 'speak to someone', 'representative'],

  // Follow-up Strategy
  followUpEnabled: true,
  followUpDelay: 60, // minutes
  maxFollowUps: 3,
  followUpMessage: '',

  // Campaign Instructions
  campaignInstructions: '',

  // Conversation Memory Settings
  maxMemoryMessages: 50,
  memoryExpiryDays: 30,
};

/**
 * Validate that a channel is supported.
 */
function assertValidChannel(channel) {
  if (!VALID_CHANNELS.includes(channel)) {
    const err = new Error(`Invalid channel "${channel}". Supported: ${VALID_CHANNELS.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

/**
 * Merge stored config with defaults (fills in missing fields).
 */
function mergeBrainConfig(stored = {}) {
  return { ...DEFAULT_CHANNEL_BRAIN_CONFIG, ...stored };
}

// GET /api/channel-brains/:channel
router.get('/:channel', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const { channel } = req.params;
    assertValidChannel(channel);

    const stored = await userStorage.getChannelBrainConfig(userId, channel);
    const config = mergeBrainConfig(stored);

    res.json({ success: true, channel, config });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(`[ChannelBrains] GET ${req.params.channel} error:`, error.message);
    res.status(500).json({ error: 'Failed to load channel brain configuration' });
  }
});

// POST /api/channel-brains/:channel
router.post('/:channel', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const { channel } = req.params;
    assertValidChannel(channel);

    const body = req.body || {};
    // Only allow known keys from DEFAULT_CHANNEL_BRAIN_CONFIG
    const allowed = Object.keys(DEFAULT_CHANNEL_BRAIN_CONFIG);
    const updates = {};
    for (const key of allowed) {
      if (body[key] !== undefined) updates[key] = body[key];
    }

    const saved = await userStorage.updateChannelBrainConfig(userId, channel, updates);
    const config = mergeBrainConfig(saved);

    res.json({ success: true, channel, config });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(`[ChannelBrains] POST ${req.params.channel} error:`, error.message);
    res.status(500).json({ error: 'Failed to update channel brain configuration' });
  }
});

module.exports = router;