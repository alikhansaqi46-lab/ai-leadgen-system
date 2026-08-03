/**
 * OpenAI API Key Management Routes
 *
 * GET  /api/openai/status        → User's OpenAI status (no keys exposed)
 * POST /api/openai/key           → Save/update user's OpenAI API key
 * DELETE /api/openai/key         → Delete user's key, revert to master
 * POST /api/openai/test          → Test a key (body key or saved key)
 * POST /api/openai/refill        → Admin only: refill free messages
 */

const express = require('express');
const router = express.Router();
const userStorage = require('../utils/userStorage');
const openAiKeyService = require('../services/openAiKeyService');

/* ---------------- helpers ---------------- */

function getBearer(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'];
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim();
}

function getUserId(req) {
  // In disabled auth mode, req.auth.userId is set without a token
  if (req.auth?.userId) return req.auth.userId;
  const token = getBearer(req);
  if (!token) return null;
  const { verifyToken } = require('../services/authService');
  const payload = verifyToken(token);
  return payload.sub || null;
}

/* ---------------- status ---------------- */

router.get('/status', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const status = await openAiKeyService.getOpenAiStatus(userId);
    if (!status) return res.status(404).json({ error: 'User not found.' });

    res.json({ success: true, ...status });
  } catch (err) {
    console.error('[OpenAI] Status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- save/update key ---------------- */

router.post('/key', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { apiKey } = req.body || {};

    if (!apiKey || !apiKey.startsWith('sk-')) {
      return res.status(400).json({ error: 'Invalid API key format. Must start with sk-' });
    }

    // Validate the key before saving
    const testResult = await openAiKeyService.testOpenAiKey(apiKey);
    if (!testResult.valid) {
      return res.status(400).json({
        error: 'The API key appears to be invalid.',
        detail: testResult.error,
      });
    }

    await userStorage.setOpenAiKey(userId, apiKey);
    res.json({ success: true, message: 'OpenAI API key saved and validated.' });
  } catch (err) {
    console.error('[OpenAI] Save key error:', err.message);
    res.status(500).json({ error: 'Failed to save API key.' });
  }
});

/* ---------------- delete key ---------------- */

router.delete('/key', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    await userStorage.deleteOpenAiKey(userId);
    res.json({ success: true, message: 'OpenAI API key removed. Reverted to master key (if available).' });
  } catch (err) {
    console.error('[OpenAI] Delete key error:', err.message);
    res.status(500).json({ error: 'Failed to delete API key.' });
  }
});

/* ---------------- test key ---------------- */

router.post('/test', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { apiKey } = req.body || {};

    // If no key provided in body, test the user's saved key
    let keyToTest = apiKey;
    if (!keyToTest) {
      keyToTest = await userStorage.getOpenAiKey(userId);
      if (!keyToTest) {
        // Fall back to master key
        keyToTest = process.env.OPENAI_API_KEY;
        if (!keyToTest) {
          return res.status(503).json({ error: 'No API key configured.' });
        }
      }
    }

    const result = await openAiKeyService.testOpenAiKey(keyToTest);
    res.json({ success: result.valid, ...result });
  } catch (err) {
    console.error('[OpenAI] Test key error:', err.message);
    res.status(500).json({ error: 'Failed to test API key.' });
  }
});

/* ---------------- admin: refill free messages ---------------- */

router.post('/refill', async (req, res) => {
  try {
    const callerId = getUserId(req);
    if (!callerId) return res.status(401).json({ error: 'Unauthorized' });

    const user = await userStorage.findById(callerId);
    if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    const { userId, amount } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const target = await userStorage.findById(userId);
    if (!target) return res.status(404).json({ error: 'Target user not found.' });

    await userStorage.resetFreeAiMessages(userId, amount || openAiKeyService.FREE_AI_MESSAGES);
    const remaining = await userStorage.getFreeAiMessages(userId);

    res.json({ success: true, userId, freeAiMessagesRemaining: remaining });
  } catch (err) {
    console.error('[OpenAI] Refill error:', err.message);
    res.status(500).json({ error: 'Failed to refill messages.' });
  }
});

module.exports = router;
