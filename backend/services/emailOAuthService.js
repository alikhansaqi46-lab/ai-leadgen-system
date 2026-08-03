/**
 * Email OAuth Service — Google OAuth2 for Gmail via the Unified Integration Framework.
 *
 * Responsibilities:
 *   1. Exchange authorization code for access + refresh tokens.
 *   2. Refresh expired access tokens using refresh_token.
 *   3. Send emails via the Gmail API (googleapis) — more reliable than SMTP XOAUTH2.
 *   4. Fallback to nodemailer SMTP transporter with XOAUTH2.
 *
 * All tokens are stored in integrationStorage (unified store).
 */

const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const crypto = require('crypto');
const integrationStorage = require('../utils/integrationStorage');
const { parseEmailAddress } = require('../utils/emailValidation');
const { enrichExternalError } = require('../utils/externalApiErrors');
const { runGmailOperation, invalidateWorkspaceAccountCache, logGmailApiCall } = require('../utils/gmailApiQueue');

const GMAIL_DEBUG = process.env.GMAIL_DEBUG === 'true';
const SEND_AS_CACHE_TTL_MS = 5 * 60 * 1000;
const CLIENT_CACHE_TTL_MS = 5 * 60 * 1000;
const sendAsCache = new Map();
const clientCache = new Map();

function formatAddressName(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^"?([^"<]+)"?\s*</);
  return (match ? match[1] : '').trim();
}

async function fetchSendAsAddressesDirect(gmail, workspaceId, accountKey) {
  const cacheKey = String(accountKey || 'default').toLowerCase();
  const cached = sendAsCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.emails;
  }

  logGmailApiCall(workspaceId, 'settings.sendAs.list');
  const res = await gmail.users.settings.sendAs.list({ userId: 'me' });
  console.log('[GmailAPI] response received: settings.sendAs.list', { accountKey: cacheKey, count: (res.data.sendAs || []).length });
  const emails = new Set((res.data.sendAs || [])
    .filter((item) => item.verificationStatus === 'accepted' || item.isDefault)
    .map((item) => String(item.sendAsEmail || '').toLowerCase())
    .filter(Boolean));
  sendAsCache.set(cacheKey, { emails, expires: Date.now() + SEND_AS_CACHE_TTL_MS });
  return emails;
}

async function getVerifiedSendAsAddresses(workspaceId, gmail = null, oauthUser = null, requestedFromEmail = null) {
  const oauthEmail = String(oauthUser || '').toLowerCase();
  const requested = String(requestedFromEmail || '').toLowerCase();
  if (oauthEmail && (!requested || requested === oauthEmail)) {
    return new Set([oauthEmail]);
  }

  const accountKey = oauthEmail || resolveAccountKeyForCache(workspaceId);

  if (gmail) {
    try {
      return await fetchSendAsAddressesDirect(gmail, workspaceId, accountKey);
    } catch (err) {
      console.warn('[GmailAPI] Could not verify Gmail send-as aliases; using OAuth account as From:', err.message);
      return oauthEmail ? new Set([oauthEmail]) : null;
    }
  }

  try {
    return await runGmailApiCall(workspaceId, 'settings.sendAs.list', (gmailClient, user) =>
      fetchSendAsAddressesDirect(gmailClient, workspaceId, user || accountKey)
    );
  } catch (err) {
    console.warn('[GmailAPI] Could not verify Gmail send-as aliases; using OAuth account as From:', err.message);
    return oauthEmail ? new Set([oauthEmail]) : null;
  }
}

function resolveAccountKeyForCache(workspaceId) {
  const rec = integrationStorage.get(workspaceId, 'email');
  return String(rec?.account || rec?.credentials?.email || workspaceId || 'default').toLowerCase();
}

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }
  return new OAuth2Client(clientId, clientSecret);
}

/**
 * Exchange an authorization code for tokens.
 * Returns { accessToken, refreshToken, expiryDate }.
 */
async function exchangeCode(code, redirectUri) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
  };
}

/**
 * Refresh an access token using the stored refresh token.
 * Updates integrationStorage with the new access token.
 */
async function refreshAccessToken(workspaceId) {
  const rec = integrationStorage.get(workspaceId, 'email');
  if (!rec || !rec.connected || rec.type !== 'oauth2') {
    throw new Error('No OAuth email credentials stored for this workspace');
  }

  const refreshToken = rec.credentials?.refreshToken;
  if (!refreshToken) {
    markEmailNeedsReconnect(workspaceId, 'missing_refresh_token');
    throw new Error('No refresh token available. User must reconnect.');
  }

  const client = getOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });

  try {
    const { credentials } = await client.refreshAccessToken();
    console.log('[EmailOAuth] Token refreshed. Scopes:', credentials.scope || 'N/A');
    const updated = {
      ...rec,
      needsReconnect: false,
      credentials: {
        ...rec.credentials,
        accessToken: credentials.access_token,
        // Preserve refresh token; Google may omit it on refresh.
        refreshToken: credentials.refresh_token || refreshToken,
        expiryDate: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null,
        scope: credentials.scope || rec.credentials?.scope || null,
      },
      updatedAt: new Date().toISOString(),
    };
    integrationStorage.set(workspaceId, 'email', updated);
    invalidateGmailClientCache(workspaceId);
    return updated.credentials;
  } catch (err) {
    const msg = String(err?.message || err);
    if (/invalid_grant/i.test(msg)) {
      markEmailNeedsReconnect(workspaceId, 'invalid_grant');
      throw new Error('Gmail connection expired. Reconnect Gmail in Settings → Integrations, then try again.');
    }
    throw err;
  }
}

function markEmailNeedsReconnect(workspaceId, reason) {
  try {
    const rec = integrationStorage.get(workspaceId, 'email');
    if (!rec) return;
    integrationStorage.set(workspaceId, 'email', {
      ...rec,
      needsReconnect: true,
      reconnectReason: reason || 'unknown',
      updatedAt: new Date().toISOString(),
    });
    invalidateGmailClientCache(workspaceId);
  } catch (err) {
    console.warn('[EmailOAuth] markEmailNeedsReconnect failed:', err.message);
  }
}

/**
 * Ensure Gmail credentials are usable before a send.
 * Forces a refresh when expired/near-expiry, or when no expiry is stored.
 */
async function ensureFreshGmailCredentials(workspaceId) {
  let rec = integrationStorage.get(workspaceId, 'email');
  if (!rec || !rec.connected || rec.type !== 'oauth2') {
    throw new Error('Gmail is not connected. Connect Gmail in Settings → Integrations.');
  }
  if (!rec.credentials?.refreshToken) {
    markEmailNeedsReconnect(workspaceId, 'missing_refresh_token');
    throw new Error('Gmail connection expired. Reconnect Gmail in Settings → Integrations, then try again.');
  }
  const expiry = rec.credentials?.expiryDate ? new Date(rec.credentials.expiryDate).getTime() : 0;
  const now = Date.now();
  const shouldRefresh = !expiry || expiry - now < 10 * 60 * 1000 || rec.needsReconnect;
  if (shouldRefresh) {
    await refreshAccessToken(workspaceId);
  }
  return integrationStorage.get(workspaceId, 'email');
}

/**
 * Create a nodemailer transporter using OAuth2 credentials.
 * Automatically refreshes the token if expired.
 */
async function getOAuthTransporter(workspaceId) {
  let rec = integrationStorage.get(workspaceId, 'email');
  if (!rec || !rec.connected || rec.type !== 'oauth2') {
    return null;
  }

  // Refresh if expired or about to expire (within 5 minutes)
  const expiry = rec.credentials?.expiryDate ? new Date(rec.credentials.expiryDate).getTime() : 0;
  const now = Date.now();
  if (expiry && expiry - now < 5 * 60 * 1000) {
    await refreshAccessToken(workspaceId);
    rec = integrationStorage.get(workspaceId, 'email');
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const accessToken = rec.credentials?.accessToken;
  const user = rec.account || rec.credentials?.email;

  if (!clientId || !clientSecret || !accessToken || !user) {
    return null;
  }

  const refreshToken = rec.credentials?.refreshToken;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user,
      clientId,
      clientSecret,
      refreshToken,
      accessToken,
    },
    tls: require('../config/tls').getTlsOptions(),
  });

  return transporter;
}

/**
 * Check whether OAuth email is configured for a workspace.
 */
function isOAuthEmailConfigured(workspaceId) {
  const rec = integrationStorage.get(workspaceId, 'email');
  return !!(
    rec
    && rec.connected
    && rec.type === 'oauth2'
    && rec.credentials?.accessToken
    && rec.credentials?.refreshToken
    && !rec.needsReconnect
  );
}

function invalidateGmailClientCache(workspaceId) {
  clientCache.delete(String(workspaceId || 'default'));
  invalidateWorkspaceAccountCache(workspaceId);
  const rec = integrationStorage.get(workspaceId, 'email');
  const accountKey = String(rec?.account || rec?.credentials?.email || workspaceId || 'default').toLowerCase();
  sendAsCache.delete(accountKey);
}

/**
 * Build Gmail API client credentials (no Gmail API HTTP calls).
 */
async function buildGmailClientInternal(workspaceId) {
  if (GMAIL_DEBUG) {
    console.log('[GmailClient] Workspace ID:', workspaceId);
  }

  await ensureFreshGmailCredentials(workspaceId);
  let rec = integrationStorage.get(workspaceId, 'email');
  if (!rec || !rec.connected || rec.type !== 'oauth2') {
    return null;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = rec.credentials?.refreshToken;
  const user = rec.account || rec.credentials?.email;
  const expiry = rec.credentials?.expiryDate ? new Date(rec.credentials.expiryDate).getTime() : 0;

  if (!clientId || !clientSecret || !refreshToken || !user) {
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({
    refresh_token: refreshToken,
    access_token: rec.credentials?.accessToken,
    expiry_date: expiry || undefined,
  });

  if (GMAIL_DEBUG) {
    try {
      const axios = require('axios');
      const tokenInfoRes = await axios.get(`https://oauth2.googleapis.com/tokeninfo?access_token=${rec.credentials?.accessToken}`);
      console.log('[GmailClient] tokeninfo.email:', tokenInfoRes.data.email || 'N/A');
    } catch (tokenInfoErr) {
      console.warn('[GmailClient] tokeninfo check failed:', tokenInfoErr.message);
    }
  }

  return { gmail: google.gmail({ version: 'v1', auth: oauth2Client }), user };
}

/**
 * Get an authenticated Gmail API client for a workspace (cached, no queued API calls).
 */
async function getGmailClient(workspaceId) {
  const cacheKey = String(workspaceId || 'default');
  const cached = clientCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.client;
  }

  const client = await buildGmailClientInternal(workspaceId);
  if (client) {
    clientCache.set(cacheKey, { client, expires: Date.now() + CLIENT_CACHE_TTL_MS });
  }
  return client;
}

/**
 * Execute one Gmail API HTTP request through the per-account queue.
 */
async function runGmailApiCall(workspaceId, operation, apiFn, options = {}) {
  const priority = options.priority === 'low' ? 'low' : 'high';
  return runGmailOperation(workspaceId, operation, async () => {
    const client = await getGmailClient(workspaceId);
    if (!client) {
      throw new Error('Gmail OAuth not configured for this workspace');
    }
    console.log('[GmailAPI] request started:', operation, { workspaceId, priority });
    try {
      const result = await apiFn(client.gmail, client.user);
      console.log('[GmailAPI] response received:', operation, { workspaceId, priority });
      return result;
    } catch (err) {
      console.error('[GmailAPI] request failed:', operation, { workspaceId, priority, message: err.message });
      throw enrichExternalError(err, { operation, workspaceId });
    }
  }, { priority });
}

async function verifySentMessageRecipientsDirect(gmail, gmailMessageId, expectedRecipients = []) {
  const expected = [...new Set((expectedRecipients || []).map(parseEmailAddress).filter(Boolean))];
  if (!gmail || !gmailMessageId || !expected.length) {
    return { verified: false, reason: 'missing_verification_inputs', toHeader: '', expected, actual: [] };
  }

  logGmailApiCall(workspaceId, 'messages.get.verify', { gmailMessageId });
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: gmailMessageId,
    format: 'metadata',
    metadataHeaders: ['To', 'Delivered-To', 'X-Original-To', 'Cc', 'Bcc'],
  });
  const headers = res.data.payload?.headers || [];
  const headerMap = Object.fromEntries(headers.map((h) => [String(h.name || '').toLowerCase(), h.value || '']));
  const toHeader = headerMap.to || '';
  const actual = toHeader.split(',').map(parseEmailAddress).filter(Boolean);
  const verified = expected.every((addr) => actual.includes(addr));
  return {
    verified,
    reason: verified ? 'ok' : 'recipient_mismatch',
    toHeader,
    expected,
    actual,
    labelIds: res.data.labelIds || [],
  };
}

async function verifySentMessageRecipients(workspaceId, gmailMessageId, expectedRecipients = []) {
  if (!workspaceId || !gmailMessageId) {
    return { verified: false, reason: 'missing_verification_inputs', toHeader: '', expected: [], actual: [] };
  }
  return runGmailApiCall(workspaceId, 'messages.get.verify', (gmail) =>
    verifySentMessageRecipientsDirect(gmail, gmailMessageId, expectedRecipients)
  );
}

/**
 * Send an email via the Gmail API.
 * One high-priority queue job = at most one sendAs.list (usually skipped) + one messages.send.
 */
async function sendViaGmailApi(workspaceId, mailOptions) {
  return runGmailOperation(workspaceId, 'messages.send', async () => {
    const client = await getGmailClient(workspaceId);
    if (!client) {
      throw new Error('Gmail OAuth not configured for this workspace');
    }

    const { gmail, user } = client;
    const requestedFrom = mailOptions.from || user;
    const requestedFromEmail = parseEmailAddress(requestedFrom);
    const verifiedSendAs = await getVerifiedSendAsAddresses(workspaceId, gmail, user, requestedFromEmail);
    const canUseRequestedFrom = requestedFromEmail && (
      requestedFromEmail === String(user).toLowerCase() ||
      (verifiedSendAs && verifiedSendAs.has(requestedFromEmail))
    );
    const safeFrom = canUseRequestedFrom
      ? requestedFrom
      : `"${formatAddressName(requestedFrom) || 'LeadFlow AI'}" <${user}>`;
    const safeReplyTo = mailOptions.replyTo || (canUseRequestedFrom ? requestedFrom : mailOptions.from || user);

    const messageIdDomain = String(user || 'leadflow.ai').split('@')[1] || 'leadflow.ai';
    const messageId = mailOptions.messageId || `<${crypto.randomUUID()}@${messageIdDomain}>`;
    const isColdOutreach = mailOptions.isColdOutreach === true
      || (!mailOptions.threadId && !mailOptions.inReplyTo && !mailOptions.preview);
    const includeUnsubscribeFooter = mailOptions.includeUnsubscribeFooter === true || isColdOutreach;
    const replyToEmail = parseEmailAddress(safeReplyTo) || user;

    const headers = {
      'Message-ID': messageId,
      ...(mailOptions.inReplyTo ? { 'In-Reply-To': mailOptions.inReplyTo } : {}),
      ...(mailOptions.references ? { References: Array.isArray(mailOptions.references) ? mailOptions.references.join(' ') : mailOptions.references } : {}),
      ...(includeUnsubscribeFooter && replyToEmail ? {
        'List-Unsubscribe': `<mailto:${replyToEmail}?subject=Unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      } : {}),
      ...(mailOptions.preview ? { 'X-LeadFlow-Preview': 'true' } : {}),
      ...(mailOptions.headers || {}),
    };

    const alignedReplyTo = safeReplyTo || safeFrom;
    let plainText = String(mailOptions.text || '').trim();
    if (!plainText && mailOptions.html) {
      plainText = mailOptions.html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '$1 ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const composer = new MailComposer({
      from: safeFrom,
      to: mailOptions.to,
      replyTo: alignedReplyTo,
      subject: mailOptions.subject || '',
      text: plainText,
      html: mailOptions.html || undefined,
      attachments: mailOptions.attachments || [],
      date: new Date(),
      messageId,
      headers,
      textEncoding: 'quoted-printable',
    });

    const rawMessage = (await composer.compile().build()).toString();
    const encoded = Buffer.from(rawMessage).toString('base64url');
    const expectedRecipients = Array.isArray(mailOptions.to)
      ? mailOptions.to
      : String(mailOptions.to || '').split(',').map((v) => v.trim()).filter(Boolean);

    logGmailApiCall(workspaceId, 'messages.send', { to: mailOptions.to, preview: Boolean(mailOptions.preview) });
    let res;
    try {
      res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encoded,
          ...(mailOptions.threadId ? { threadId: mailOptions.threadId } : {}),
        },
      });
      console.log('[GmailAPI] response received: messages.send', { workspaceId, messageId: res.data.id });
    } catch (err) {
      const msg = String(err?.message || err);
      if (/invalid_grant/i.test(msg)) {
        console.warn('[GmailAPI] invalid_grant on send — refreshing credentials and retrying once');
        invalidateGmailClientCache(workspaceId);
        await refreshAccessToken(workspaceId);
        const retryClient = await getGmailClient(workspaceId);
        if (!retryClient) throw enrichExternalError(err, { operation: 'messages.send', workspaceId });
        res = await retryClient.gmail.users.messages.send({
          userId: 'me',
          requestBody: {
            raw: encoded,
            ...(mailOptions.threadId ? { threadId: mailOptions.threadId } : {}),
          },
        });
        console.log('[GmailAPI] response received: messages.send (retry)', { workspaceId, messageId: res.data.id });
      } else {
        console.error('[GmailAPI] request failed: messages.send', { workspaceId, message: err.message });
        throw enrichExternalError(err, { operation: 'messages.send', workspaceId });
      }
    }

    let deliveryVerification = null;
    if (expectedRecipients.length && mailOptions.skipDeliveryVerification === false) {
      deliveryVerification = await verifySentMessageRecipientsDirect(gmail, res.data.id, expectedRecipients);
      if (!deliveryVerification.verified) {
        throw new Error(`Gmail accepted the send but recipient verification failed. Expected ${deliveryVerification.expected.join(', ')}, got ${deliveryVerification.actual.join(', ') || deliveryVerification.toHeader || 'unknown'}`);
      }
    }

    return {
      messageId: res.data.id,
      rfcMessageId: messageId,
      gmailThreadId: res.data.threadId || mailOptions.threadId || null,
      bounced: false,
      recipientEmail: parseEmailAddress(expectedRecipients[0] || mailOptions.to),
      deliveryVerified: deliveryVerification ? deliveryVerification.verified : null,
      deliveryVerification,
    };
  }, { priority: 'high' });
}

module.exports = {
  exchangeCode,
  refreshAccessToken,
  ensureFreshGmailCredentials,
  markEmailNeedsReconnect,
  getOAuthTransporter,
  getGmailClient,
  buildGmailClientInternal,
  runGmailApiCall,
  sendViaGmailApi,
  verifySentMessageRecipients,
  isOAuthEmailConfigured,
  invalidateGmailClientCache,
};
