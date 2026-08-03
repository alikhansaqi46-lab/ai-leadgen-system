/**
 * WhatsApp Meta Cloud API Service
 * Production-ready client for the official Meta WhatsApp Cloud API.
 * Supports: text, image, document, video, template messages, media upload,
 * business/phone-number info, and human-readable Meta error mapping.
 *
 * All credentials are supplied per-call (never hardcoded) — resolved by
 * whatsappTransport.js from environment variables or encrypted per-workspace storage.
 */

const axios = require('axios');

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || 'v22.0';
const BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const authHeaders = (token, extra = {}) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  ...extra,
});

/**
 * Map Meta Graph API errors to human-readable messages.
 * Covers: expired/invalid tokens, rate limits, phone-number issues,
 * template errors, and permission errors.
 */
function toHumanError(error, context = 'WhatsApp API request') {
  const e = error.response?.data?.error;
  if (!e) {
    if (error.code === 'ECONNABORTED') return new Error(`${context} timed out — Meta servers did not respond in time.`);
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') return new Error(`${context} failed — no network connection to Meta.`);
    return new Error(error.message || `${context} failed`);
  }

  const code = e.code;
  const sub = e.error_subcode;
  const msg = e.message || 'Unknown Meta error';

  // Token errors
  if (code === 190) {
    if (sub === 463) return new Error('Access token has EXPIRED. Generate a new permanent token in Meta App Dashboard and update your credentials.');
    if (sub === 467) return new Error('Access token is INVALID or was revoked. Check your WHATSAPP_TOKEN.');
    return new Error(`Invalid access token (${msg}). Verify WHATSAPP_TOKEN / stored credentials.`);
  }
  if (code === 10 || code === 200 || (code >= 200 && code < 300)) {
    return new Error(`Permission error: the app lacks required permissions (whatsapp_business_messaging / whatsapp_business_management). ${msg}`);
  }
  // Rate limits
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80007 || code === 130429) {
    return new Error(`Rate limit reached (${msg}). Slow down sending and retry later.`);
  }
  // Phone number / recipient issues
  if (code === 131026) return new Error('Recipient phone number is not registered on WhatsApp.');
  if (code === 131047) return new Error('Message failed: more than 24h since the customer last messaged you. You must use an approved template message instead.');
  if (code === 131051) return new Error('Unsupported message type for this recipient.');
  if (code === 132000) return new Error(`Template error: template does not exist or parameter count mismatch for the selected language. ${msg}`);
  if (code === 132001) return new Error(`Template error: template is not approved (or paused) for this language. ${msg}`);
  if (code === 132005 || code === 132007) return new Error(`Template error: ${msg}`);
  if (code === 132012) return new Error(`Template parameter format error: ${msg}`);
  if (code === 131008) return new Error('Required parameter is missing in the request.');
  if (code === 131009) return new Error(`Parameter value is not valid: ${msg}`);
  if (code === 133000 || code === 133004) return new Error(`Phone number issue: ${msg}`);
  if (code === 100) return new Error(`Invalid request parameter: ${msg}`);

  const err = new Error(`Meta API error ${code}${sub ? `/${sub}` : ''}: ${msg}`);
  err.metaCode = code;
  err.metaSubcode = sub;
  err.fbtraceId = e.fbtrace_id || null;
  return err;
}

function cleanPhone(to) {
  return String(to || '').replace(/\D/g, '');
}

function assertPhone(to) {
  const phone = cleanPhone(to);
  if (!phone || phone.length < 6) throw new Error('Invalid phone number');
  return phone;
}

function okResult(response, extra = {}) {
  return {
    success: true,
    messageId: response.data.messages?.[0]?.id || null,
    status: 'sent', // refined to delivered/read/failed by webhook status updates
    contact: response.data.contacts?.[0] || null,
    ...extra,
  };
}

/** Central message poster used by all send functions. */
async function postMessage({ token, phoneNumberId, payload, timeout = 20000 }) {
  try {
    const response = await axios.post(
      `${BASE_URL}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload },
      { headers: authHeaders(token), timeout }
    );
    return okResult(response);
  } catch (error) {
    throw toHumanError(error, 'WhatsApp send');
  }
}

function testResult(prefix) {
  return { success: true, messageId: `${prefix}-${Date.now()}`, status: 'test', testMode: true };
}

/** Send a WhatsApp text message. */
async function sendTextMessage({ token, phoneNumberId, to, message, testMode = false }) {
  if (testMode) {
    console.log(`TEST MODE: Would send text to ${to}: ${String(message).substring(0, 60)}...`);
    return testResult('test');
  }
  return postMessage({
    token, phoneNumberId,
    payload: { to: assertPhone(to), type: 'text', text: { body: String(message) } },
    timeout: 15000,
  });
}

/**
 * Send a WhatsApp template message (must be pre-approved in Meta Business Manager).
 * templateParams: array of strings for the BODY component ({{1}}, {{2}}, ...) — used for personalization.
 * headerParams: optional array of strings for a TEXT header component.
 */
async function sendTemplateMessage({
  token, phoneNumberId, to, templateName, languageCode = 'en_US',
  templateParams = [], headerParams = [], testMode = false,
}) {
  if (testMode) {
    console.log(`TEST MODE: Would send template "${templateName}" to ${to}`);
    return testResult('test');
  }
  const components = [];
  if (headerParams.length > 0) {
    components.push({ type: 'header', parameters: headerParams.map((text) => ({ type: 'text', text: String(text) })) });
  }
  if (templateParams.length > 0) {
    components.push({ type: 'body', parameters: templateParams.map((text) => ({ type: 'text', text: String(text) })) });
  }
  return postMessage({
    token, phoneNumberId,
    payload: {
      to: assertPhone(to),
      type: 'template',
      template: { name: templateName, language: { code: languageCode }, ...(components.length ? { components } : {}) },
    },
    timeout: 15000,
  });
}

/** Send a reply to an incoming message (optionally quoting the original). */
async function sendReply({ token, phoneNumberId, to, message, replyToMessageId = null }) {
  const payload = { to: assertPhone(to), type: 'text', text: { body: String(message) } };
  if (replyToMessageId) payload.context = { message_id: replyToMessageId };
  return postMessage({ token, phoneNumberId, payload, timeout: 15000 });
}

/** Send an image (public URL link or uploaded media id). */
async function sendImageMessage({ token, phoneNumberId, to, imageUrl, caption = '', mediaId, testMode = false }) {
  if (testMode) return testResult('test-img');
  const image = {};
  if (mediaId) image.id = mediaId;
  else if (imageUrl) image.link = imageUrl;
  else throw new Error('Either mediaId or imageUrl is required for WhatsApp image messages');
  if (caption) image.caption = caption;
  return postMessage({ token, phoneNumberId, payload: { to: assertPhone(to), type: 'image', image }, timeout: 15000 });
}

/** Send a document (public URL link or uploaded media id). */
async function sendDocumentMessage({ token, phoneNumberId, to, documentUrl, mediaId, filename = 'document.pdf', caption = '', testMode = false }) {
  if (testMode) return testResult('test-doc');
  const document = {};
  if (mediaId) document.id = mediaId;
  else if (documentUrl) document.link = documentUrl;
  else throw new Error('Either mediaId or documentUrl is required');
  if (filename) document.filename = filename;
  if (caption) document.caption = caption;
  return postMessage({ token, phoneNumberId, payload: { to: assertPhone(to), type: 'document', document } });
}

/** Send a video (public URL link or uploaded media id). */
async function sendVideoMessage({ token, phoneNumberId, to, videoUrl, mediaId, caption = '', testMode = false }) {
  if (testMode) return testResult('test-vid');
  const video = {};
  if (mediaId) video.id = mediaId;
  else if (videoUrl) video.link = videoUrl;
  else throw new Error('Either mediaId or videoUrl is required');
  if (caption) video.caption = caption;
  return postMessage({ token, phoneNumberId, payload: { to: assertPhone(to), type: 'video', video }, timeout: 30000 });
}

/** Upload media to Meta; returns { id } usable as mediaId in send functions. */
async function uploadMedia({ token, phoneNumberId, filePath, mimeType = 'image/jpeg' }) {
  const FormData = require('form-data');
  const fs = require('fs');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', fs.createReadStream(filePath), { contentType: mimeType, filename: require('path').basename(filePath) });
  form.append('type', mimeType);
  try {
    const response = await axios.post(`${BASE_URL}/${phoneNumberId}/media`, form, {
      headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
      timeout: 30000,
    });
    return response.data;
  } catch (error) {
    throw toHumanError(error, 'WhatsApp media upload');
  }
}

/** Phone-number level info: display name status, quality, throughput, webhook config. */
async function getBusinessInfo(token, phoneNumberId) {
  try {
    const url = `${BASE_URL}/${phoneNumberId}?fields=id,display_phone_number,quality_rating,verified_name,code_verification_status,name_status,platform_type,throughput,webhook_configuration`;
    const response = await axios.get(url, { headers: authHeaders(token), timeout: 10000 });
    const d = response.data || {};
    return {
      success: true,
      data: {
        id: d.id || phoneNumberId,
        display_phone_number: d.display_phone_number || null,
        quality_rating: d.quality_rating || null,
        verified_name: d.verified_name || null,
        code_verification_status: d.code_verification_status || null,
        name_status: d.name_status || null,
        platform_type: d.platform_type || null,
        messaging_limit: d.throughput?.level || d.throughput || null,
        webhook_configuration: d.webhook_configuration || null,
      },
    };
  } catch (error) {
    throw toHumanError(error, 'Fetching phone number info');
  }
}

/** WABA-level info: business name, currency, timezone. */
async function getWabaInfo(token, wabaId) {
  try {
    const url = `${BASE_URL}/${wabaId}?fields=id,name,currency,timezone_id,message_template_namespace,account_review_status,business_verification_status`;
    const response = await axios.get(url, { headers: authHeaders(token), timeout: 10000 });
    return { success: true, data: response.data || {} };
  } catch (error) {
    throw toHumanError(error, 'Fetching WABA info');
  }
}

/** List message templates for a WABA. */
async function getMessageTemplates(token, wabaId) {
  try {
    const url = `${BASE_URL}/${wabaId}/message_templates`;
    const response = await axios.get(url, { headers: authHeaders(token), timeout: 10000 });
    return { success: true, templates: response.data.data || [] };
  } catch (error) {
    throw toHumanError(error, 'Fetching message templates');
  }
}

/** Validate credentials by reading the phone number object. */
async function validateCredentials(token, phoneNumberId) {
  try {
    const url = `${BASE_URL}/${phoneNumberId}?fields=id,display_phone_number,verified_name,name_status,quality_rating`;
    const response = await axios.get(url, { headers: authHeaders(token), timeout: 10000 });
    const d = response.data || {};
    return {
      valid: true,
      data: {
        phoneNumberId: d.id || phoneNumberId,
        displayPhoneNumber: d.display_phone_number || null,
        verifiedName: d.verified_name || null,
        nameStatus: d.name_status || null,
        qualityRating: d.quality_rating || null,
      },
    };
  } catch (error) {
    return { valid: false, error: toHumanError(error, 'Validating credentials').message };
  }
}

/** Format phone number for the Cloud API (digits only; US 10-digit gets country code 1). */
function formatPhoneNumber(phone) {
  const cleaned = String(phone || '').replace(/\D/g, '');
  if (cleaned.length === 10) return `1${cleaned}`;
  return cleaned;
}

module.exports = {
  GRAPH_API_VERSION,
  sendTextMessage,
  sendTemplateMessage,
  sendReply,
  sendImageMessage,
  sendDocumentMessage,
  sendVideoMessage,
  uploadMedia,
  getBusinessInfo,
  getWabaInfo,
  getMessageTemplates,
  validateCredentials,
  formatPhoneNumber,
  toHumanError,
};
