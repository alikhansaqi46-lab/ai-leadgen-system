/**
 * WhatsApp Transport — Official Meta WhatsApp Cloud API ONLY.
 *
 * No QR, no WhatsApp Web, no Baileys. All messaging goes through the
 * Meta Graph API (see services/whatsappMeta.js).
 *
 * Credentials resolution (never hardcoded):
 *   1. Per-workspace encrypted credentials (integrationStorage, set via
 *      POST /api/whatsapp/credentials): { token, phoneNumberId, wabaId }
 *   2. Environment fallback: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
 *      WHATSAPP_WABA_ID
 *
 * Webhook security env vars: WHATSAPP_APP_SECRET (or META_APP_SECRET),
 * WHATSAPP_WEBHOOK_VERIFY_TOKEN.
 *
 * Call sites should use this module instead of whatsappMeta.js directly.
 */

const integrationStorage = require('../utils/integrationStorage');
const whatsappMeta = require('./whatsappMeta');

const DEFAULT_TRANSPORT = 'meta';

function cleanPhone(input) {
  return String(input || '').replace(/\D/g, '');
}

function formatPhoneNumber(phone) {
  return whatsappMeta.formatPhoneNumber(phone);
}

/** Backward-compatible candidate list used by some callers. */
function phoneCandidates(input) {
  const digits = cleanPhone(input);
  return digits ? [digits] : [];
}

function getTransportMode() {
  return DEFAULT_TRANSPORT;
}

/** Resolve effective credentials for a workspace: stored → env fallback. */
function resolveCredentials(workspaceId) {
  const stored = integrationStorage.getCredentials(workspaceId, 'whatsapp') || {};
  const token = stored.token || process.env.WHATSAPP_TOKEN || null;
  const phoneNumberId = stored.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || null;
  const wabaId = stored.wabaId || process.env.WHATSAPP_WABA_ID || null;
  const source = stored.token && stored.phoneNumberId ? 'workspace' : (token && phoneNumberId ? 'env' : 'none');
  return { token, phoneNumberId, wabaId, source };
}

function isConfigured(workspaceId) {
  const c = resolveCredentials(workspaceId);
  return Boolean(c.token && c.phoneNumberId);
}

function assertConfigured(workspaceId) {
  const creds = resolveCredentials(workspaceId);
  if (!creds.token || !creds.phoneNumberId) {
    throw new Error('WhatsApp Cloud API is not configured. Set credentials in WhatsApp Settings (token + phone number ID) or via WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID environment variables.');
  }
  return creds;
}

/**
 * Connection status snapshot (name kept for backward compatibility with
 * callers like config/providers.js — there is no QR anymore).
 */
async function getQrStatus(workspaceId) {
  const creds = resolveCredentials(workspaceId);
  const configured = Boolean(creds.token && creds.phoneNumberId);
  return {
    workspaceId: String(workspaceId || 'default'),
    transport: 'meta',
    status: configured ? 'connected' : 'disconnected',
    connected: configured,
    configured,
    credentialSource: creds.source,
    phone: null, // resolved live via getBusinessInfo when needed
    phoneNumberId: creds.phoneNumberId || null,
    wabaId: creds.wabaId || null,
    lastError: null,
  };
}

/** In-memory status only — safe for health probes. */
async function peekSessionStatus(workspaceId) {
  return getQrStatus(workspaceId);
}

/**
 * Live verification: token validity + phone number info + WABA info.
 * Used by the settings page and /validate, /test-connection routes.
 */
async function verifyConnection(workspaceId) {
  const creds = assertConfigured(workspaceId);
  const validation = await whatsappMeta.validateCredentials(creds.token, creds.phoneNumberId);
  if (!validation.valid) {
    return { ok: false, error: validation.error, tokenStatus: 'invalid' };
  }
  let business = null;
  try {
    business = (await whatsappMeta.getBusinessInfo(creds.token, creds.phoneNumberId)).data;
  } catch (err) {
    business = { error: err.message };
  }
  let waba = null;
  if (creds.wabaId) {
    try {
      waba = (await whatsappMeta.getWabaInfo(creds.token, creds.wabaId)).data;
    } catch (err) {
      waba = { error: err.message };
    }
  }
  return {
    ok: true,
    tokenStatus: 'valid',
    phoneNumberId: validation.data.phoneNumberId,
    displayPhoneNumber: validation.data.displayPhoneNumber,
    verifiedName: validation.data.verifiedName,
    displayNameStatus: validation.data.nameStatus,
    qualityRating: validation.data.qualityRating,
    messagingLimit: business?.messaging_limit || null,
    webhookConfiguration: business?.webhook_configuration || null,
    codeVerificationStatus: business?.code_verification_status || null,
    waba: waba ? { id: creds.wabaId, name: waba.name || null, accountReviewStatus: waba.account_review_status || null, error: waba.error || null } : null,
  };
}

// ==================== SENDING ====================

// testMode bypasses credential checks (no Meta call is made).
function credsForSend(workspaceId, testMode) {
  if (testMode) return { token: null, phoneNumberId: null, wabaId: null };
  return assertConfigured(workspaceId);
}

async function sendText({ workspaceId, to, message, testMode = false }) {
  const creds = credsForSend(workspaceId, testMode);
  return whatsappMeta.sendTextMessage({ ...creds, to, message, testMode });
}

async function sendImage({ workspaceId, to, imageUrl, caption = '', mediaId, testMode = false }) {
  const creds = credsForSend(workspaceId, testMode);
  return whatsappMeta.sendImageMessage({ ...creds, to, imageUrl, caption, mediaId, testMode });
}

async function sendDocument({ workspaceId, to, documentUrl, mediaId, filename, caption = '', testMode = false }) {
  const creds = credsForSend(workspaceId, testMode);
  return whatsappMeta.sendDocumentMessage({ ...creds, to, documentUrl, mediaId, filename, caption, testMode });
}

async function sendVideo({ workspaceId, to, videoUrl, mediaId, caption = '', testMode = false }) {
  const creds = credsForSend(workspaceId, testMode);
  return whatsappMeta.sendVideoMessage({ ...creds, to, videoUrl, mediaId, caption, testMode });
}

async function sendTemplate({ workspaceId, to, templateName, languageCode, templateParams, headerParams, testMode = false }) {
  const creds = credsForSend(workspaceId, testMode);
  return whatsappMeta.sendTemplateMessage({ ...creds, to, templateName, languageCode, templateParams, headerParams, testMode });
}

async function sendReply({ workspaceId, to, message, replyToMessageId = null }) {
  const creds = assertConfigured(workspaceId);
  return whatsappMeta.sendReply({ ...creds, to, message, replyToMessageId });
}

async function uploadMedia({ workspaceId, filePath, mimeType }) {
  const creds = assertConfigured(workspaceId);
  return whatsappMeta.uploadMedia({ ...creds, filePath, mimeType });
}

// Convenience aliases kept for existing callers (routes use *WithRetry names).
const sendTextWithRetry = sendText;
const sendImageWithRetry = sendImage;

module.exports = {
  DEFAULT_TRANSPORT,
  getTransportMode,
  resolveCredentials,
  isConfigured,
  verifyConnection,
  getQrStatus,
  peekSessionStatus,
  sendText,
  sendImage,
  sendDocument,
  sendVideo,
  sendTemplate,
  sendReply,
  uploadMedia,
  sendTextWithRetry,
  sendImageWithRetry,
  cleanPhone,
  formatPhoneNumber,
  phoneCandidates,
};
