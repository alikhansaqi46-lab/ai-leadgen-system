/**
 * OpenAI Key Service — manages per-user API keys, free message quotas,
 * and automatic switching between Master API Key and customer API keys.
 *
 * Rules:
 * 1. New users get FREE_AI_MESSAGES (default 100) on signup.
 * 2. If user has their own API key (openai_api_enabled + openai_api_key):
 *    → Use their key. No free message limit.
 * 3. If user has no own key but free messages remain:
 *    → Use Master API Key (OPENAI_API_KEY env var).
 *    → Decrement free counter on each AI call.
 * 4. If user has no own key and free messages = 0:
 *    → Block AI calls. Return { blocked: true, reason: 'FREE_MESSAGES_EXHAUSTED' }.
 *
 * Security:
 * - Keys are NEVER exposed to the frontend.
 * - Per-user keys are encrypted in the database.
 */

const userStorage = require('../utils/userStorage');

const FREE_AI_MESSAGES = parseInt(process.env.FREE_AI_MESSAGES, 10) || 100;
const MASTER_API_KEY = process.env.OPENAI_API_KEY || null;
const MASTER_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MASTER_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

/**
 * Get the effective OpenAI configuration for a user.
 * Returns { apiKey, model, baseUrl, source, blocked, reason }.
 *
 * If blocked === true, do NOT make an OpenAI request.
 */
async function getOpenAiConfig(userId) {
  if (!userId) {
    return { blocked: true, reason: 'NO_USER_ID' };
  }

  // Check if user has their own API key
  const userKey = await userStorage.getOpenAiKey(userId);
  const user = await userStorage.findById(userId);

  if (userKey && user?.openai_api_enabled) {
    return {
      apiKey: userKey,
      model: MASTER_MODEL,
      baseUrl: MASTER_BASE,
      source: 'user',
      userId,
      workspaceId: userId,
      blocked: false,
      reason: null,
    };
  }

  // No user key — check free messages (clamp corrupted counters)
  let freeRemaining = await userStorage.getFreeAiMessages(userId);
  if (!Number.isFinite(freeRemaining) || freeRemaining < 0) freeRemaining = 0;
  if (freeRemaining > FREE_AI_MESSAGES) {
    freeRemaining = FREE_AI_MESSAGES;
    try { await userStorage.resetFreeAiMessages(userId, FREE_AI_MESSAGES); } catch (_) { /* best-effort */ }
  }

  if (freeRemaining <= 0) {
    return {
      blocked: true,
      reason: 'FREE_MESSAGES_EXHAUSTED',
      source: 'master',
    };
  }

  if (!MASTER_API_KEY) {
    return {
      blocked: true,
      reason: 'MASTER_KEY_NOT_CONFIGURED',
      source: 'master',
    };
  }

  return {
    apiKey: MASTER_API_KEY,
    model: MASTER_MODEL,
    baseUrl: MASTER_BASE,
    source: 'master',
    userId,
    workspaceId: userId,
    blocked: false,
    reason: null,
    freeMessagesRemaining: freeRemaining,
  };
}

/**
 * Consume one free AI message (if using master key).
 * Returns the updated remaining count.
 * Safe to call even if user has their own key (returns null in that case).
 */
async function consumeFreeMessage(userId, source) {
  if (source === 'master') {
    return await userStorage.decrementFreeAiMessages(userId);
  }
  return null;
}

/**
 * Get the user's OpenAI status for the frontend (no keys exposed).
 */
async function getOpenAiStatus(userId) {
  const user = await userStorage.findById(userId);
  if (!user) return null;

  let freeRemaining = await userStorage.getFreeAiMessages(userId);
  // Self-heal corrupted counters (e.g. inflated remaining > quota).
  if (!Number.isFinite(freeRemaining) || freeRemaining < 0) freeRemaining = 0;
  if (freeRemaining > FREE_AI_MESSAGES) {
    freeRemaining = FREE_AI_MESSAGES;
    try {
      await userStorage.resetFreeAiMessages(userId, FREE_AI_MESSAGES);
    } catch (_) { /* best-effort */ }
  }
  const masterConfigured = Boolean(MASTER_API_KEY);
  const source = user.openai_source || 'master';
  const usingOwnKey = Boolean(user.openai_api_enabled && source === 'user');

  return {
    enabled: user.openai_api_enabled || false,
    source,
    freeMessagesRemaining: usingOwnKey ? FREE_AI_MESSAGES : freeRemaining,
    freeMessagesTotal: FREE_AI_MESSAGES,
    freeMessagesUsed: usingOwnKey ? 0 : Math.max(0, FREE_AI_MESSAGES - freeRemaining),
    masterConfigured,
    unlimited: usingOwnKey,
  };
}

/**
 * Validate an OpenAI API key by making a lightweight models list request.
 */
async function testOpenAiKey(apiKey) {
  const axios = require('axios');
  try {
    await axios.get(`${MASTER_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15000,
    });
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: err.response?.data?.error?.message || err.message,
    };
  }
}

module.exports = {
  getOpenAiConfig,
  consumeFreeMessage,
  getOpenAiStatus,
  testOpenAiKey,
  FREE_AI_MESSAGES,
};
