/**
 * Email Inbox Service — IMAP polling for inbound email replies.
 *
 * Connects to Gmail IMAP via OAuth2 XOAUTH2 and periodically
 * fetches emails from the last 7 days, matching them to existing lead conversations.
 *
 * Supports:
 *   - OAuth2 access token (stored in integrationStorage)
 *   - App Password (configured via integrationStorage, never env vars)
 */

const Imap = require('imap');
const fs = require('fs');
const path = require('path');
const { simpleParser } = require('mailparser');
const integrationStorage = require('../utils/integrationStorage');
const conversationStorage = require('../utils/conversationStorage');
const { prepareInboundEmailContent } = require('../utils/emailContentUtils');
const leadStorage = require('../utils/leadStorage');
const campaignStorage = require('../utils/campaignStorage');
const timelineStorage = require('../utils/timelineStorage');
const contactStorage = require('../utils/contactStorage');
const personalContactStorage = require('../utils/personalContactStorage');
const { detectBounceOrDsn } = require('../utils/emailBounce');
const { getTlsOptions } = require('../config/tls');
const { getGmailClient, refreshAccessToken } = require('./emailOAuthService');
const {
  runGmailOperation,
  shouldYieldInboxSync,
  isSendQueueBusy,
  isBackgroundSuspended,
  logGmailApiCall,
  QUEUE_DELAY_MS,
} = require('../utils/gmailApiQueue');
const { enrichExternalError } = require('../utils/externalApiErrors');

/* ── config ── */
/**
 * Inbox Gmail sync runs only while the Inbox page session is active.
 *
 * The poll interval can be short (default 10s, within the 5-15s target for
 * detecting a customer's reply) because each poll now uses the Gmail
 * History API (`history.list`, ~2 quota units) instead of re-listing and
 * re-checking the last 15 messages every cycle (`messages.list` + up to 15x
 * `messages.get`, tens of quota units per poll regardless of whether
 * anything changed). History-based polling costs almost nothing when there
 * is no new mail, which is what makes frequent polling safe — this is
 * Google's own recommended pattern for keeping a mailbox in sync without
 * push notifications (see docs: Gmail API "Sync Messages").
 */
const INBOX_POLL_INTERVAL_MS = parseInt(process.env.INBOX_POLL_INTERVAL_MS, 10) || 10_000;
const INBOX_INITIAL_SYNC_DELAY_MS = parseInt(process.env.INBOX_INITIAL_SYNC_DELAY_MS, 10) || 1500;
const GMAIL_SYNC_MAX_RESULTS = parseInt(process.env.GMAIL_SYNC_MAX_RESULTS, 10) || 15;

/** Active Inbox UI sessions per workspace — polling starts/stops with the Inbox page. */
const activeSessions = new Map();
/** Prevent overlapping sync runs for the same workspace. */
const syncLocks = new Map();

/* ── Gmail History API checkpoint persistence ── */
/**
 * Stores the last-seen Gmail `historyId` per account so subsequent polls can
 * ask Gmail "what changed since X" (history.list) instead of re-scanning
 * the last N messages every cycle. Falls back to the existing full-list
 * sync automatically when no checkpoint exists yet, or when Gmail reports
 * the checkpoint has expired (404 — normal after being idle for a while).
 */
const HISTORY_STATE_PATH = path.join(__dirname, '..', 'data', 'gmail-history-state.json');
let historyStateCache = null;

function loadHistoryState() {
  if (historyStateCache) return historyStateCache;
  try {
    historyStateCache = fs.existsSync(HISTORY_STATE_PATH)
      ? JSON.parse(fs.readFileSync(HISTORY_STATE_PATH, 'utf8')) || {}
      : {};
  } catch {
    historyStateCache = {};
  }
  return historyStateCache;
}

function saveHistoryState() {
  try {
    const dir = path.dirname(HISTORY_STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_STATE_PATH, JSON.stringify(loadHistoryState(), null, 2));
  } catch (err) {
    console.warn('[EmailInbox] failed to persist history state:', err.message);
  }
}

function getStoredHistoryId(workspaceId) {
  const state = loadHistoryState();
  return state[workspaceId]?.historyId || null;
}

function setStoredHistoryId(workspaceId, historyId) {
  if (!historyId) return;
  const state = loadHistoryState();
  state[workspaceId] = { historyId: String(historyId), updatedAt: new Date().toISOString() };
  saveHistoryState();
}

function clearStoredHistoryId(workspaceId) {
  const state = loadHistoryState();
  if (state[workspaceId]) {
    delete state[workspaceId];
    saveHistoryState();
  }
}

function isHistoryCheckpointExpired(err) {
  const status = err?.status || err?.response?.status;
  return status === 404;
}

/* ── helpers ── */

function buildXOAuth2String(user, accessToken) {
  const authString = `user=${user}\x01auth=Bearer ${accessToken}\x01\x01`;
  return Buffer.from(authString).toString('base64');
}

function getImapConfig(workspaceId = 'default') {
  // ONLY use the connected integration account — never fall back to env vars.
  // This ensures replies are read from the correct business inbox (e.g. Forest Life).
  const rec = integrationStorage.get(workspaceId, 'email');
  if (rec && rec.connected && rec.type === 'oauth2') {
    const user = rec.account || rec.credentials?.email;
    const accessToken = rec.credentials?.accessToken;
    if (user && accessToken) {
      return {
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: getTlsOptions(),
        xoauth2: buildXOAuth2String(user, accessToken),
        user,
      };
    }
  }

  if (rec && rec.connected && rec.type === 'smtp') {
    const user = rec.account;
    const pass = rec.credentials?.appPassword;
    if (user && pass) {
      return {
        host: rec.credentials?.imapHost || 'imap.gmail.com',
        port: rec.credentials?.imapPort || 993,
        tls: true,
        tlsOptions: getTlsOptions(),
        user,
        password: pass,
      };
    }
  }

  // No integration connected — do NOT fall back to env vars.
  console.log('[EmailInbox] No connected email integration found. Skipping IMAP poll.');
  return null;
}

/* ── deduplication helpers ── */

async function getExistingMessageIds(workspaceId, sinceDate) {
  try {
    const msgs = await conversationStorage.getMessagesByChannel('email', { workspaceId, since: sinceDate });
    const ids = new Set();
    for (const m of msgs) {
      if (m.metadata?.messageId) ids.add(m.metadata.messageId);
      if (m.metadata?.inReplyTo) ids.add(m.metadata.inReplyTo);
    }
    return ids;
  } catch (err) {
    console.warn('[EmailInbox] Could not load existing message ids:', err.message);
    return new Set();
  }
}

function normalizeMessageRef(value) {
  return String(value || '').trim().replace(/^<|>$/g, '').toLowerCase();
}

function splitReferences(value) {
  return String(value || '')
    .split(/\s+/)
    .map(normalizeMessageRef)
    .filter(Boolean);
}

async function getExistingEmailIndex(workspaceId, sinceDate) {
  const msgs = await conversationStorage.getMessagesByChannel('email', { workspaceId, since: sinceDate });
  const ids = new Set();
  const conversationByRef = new Map();
  for (const msg of msgs) {
    const refs = [
      msg.externalMessageId,
      msg.metadata?.messageId,
      msg.metadata?.rfcMessageId,
      msg.metadata?.gmailMessageId,
      msg.metadata?.gmailThreadId,
      msg.metadata?.inReplyTo,
      ...(Array.isArray(msg.metadata?.references) ? msg.metadata.references : splitReferences(msg.metadata?.references)),
    ].map(normalizeMessageRef).filter(Boolean);
    for (const ref of refs) {
      ids.add(ref);
      conversationByRef.set(ref, msg.conversationId);
    }
  }
  return { ids, conversationByRef };
}

function attachmentsFromParsed(parsed) {
  return (parsed.attachments || []).map((att) => ({
    filename: att.filename || 'attachment',
    contentType: att.contentType || 'application/octet-stream',
    size: att.size || att.content?.length || 0,
    contentId: att.contentId || null,
    disposition: att.contentDisposition || (att.contentId ? 'inline' : 'attachment'),
  }));
}

function inlineImagesToDataUrls(parsed, html) {
  let nextHtml = html || parsed.textAsHtml || null;
  if (!nextHtml) return nextHtml;
  const inlineMap = new Map();
  for (const att of parsed.attachments || []) {
    if (att.contentId) {
      const cid = att.contentId.replace(/^<|>$/g, '');
      const base64 = att.content?.toString('base64') || '';
      const dataUrl = `data:${att.contentType || 'image/png'};base64,${base64}`;
      inlineMap.set(cid, dataUrl);
      inlineMap.set(`cid:${cid}`, dataUrl);
    }
  }
  inlineMap.forEach((dataUrl, cid) => {
    nextHtml = nextHtml.replace(new RegExp(cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), dataUrl);
  });
  return nextHtml;
}

async function findConversationByEmailThread({ workspaceId, index, inReplyTo, references, gmailThreadId }) {
  const candidates = [
    normalizeMessageRef(inReplyTo),
    normalizeMessageRef(gmailThreadId),
    ...splitReferences(references),
  ].filter(Boolean);
  for (const ref of candidates) {
    const conversationId = index.conversationByRef.get(ref);
    if (conversationId) {
      const conv = await conversationStorage.getConversation(conversationId, { workspaceId });
      if (conv) return conv;
    }
  }
  return null;
}

async function processParsedInboundEmail({ workspaceId, parsed, fromEmail, configUser, gmailMessageId = null, gmailThreadId = null, labelIds = [], index }) {
  const subject = parsed.subject || '';
  const text = parsed.text || '';
  const html = inlineImagesToDataUrls(parsed, parsed.html);
  const prepared = prepareInboundEmailContent({ text, html });
  const rfcMessageId = parsed.messageId || '';
  const inReplyTo = parsed.inReplyTo || '';
  const references = parsed.references || '';
  const normalizedIncomingIds = [
    rfcMessageId,
    gmailMessageId,
    gmailThreadId && rfcMessageId ? null : gmailThreadId,
  ].map(normalizeMessageRef).filter(Boolean);

  for (const id of normalizedIncomingIds) {
    if (index.ids.has(id)) return { processed: false, reason: 'duplicate' };
  }

  const fromLower = String(fromEmail || '').toLowerCase().trim();
  const ourEmails = [configUser?.toLowerCase()].filter(Boolean);
  const isReply = Boolean(inReplyTo || references);
  if (!isReply && ourEmails.includes(fromLower)) {
    return { processed: false, reason: 'own_outbound' };
  }

  // Bounce / DSN — never treat as lead reply or trigger auto-reply
  const bounce = detectBounceOrDsn(parsed, fromEmail);
  if (bounce.isBounce) {
    const recipients = bounce.failedRecipients.length
      ? bounce.failedRecipients
      : [];
    let matchedLead = null;
    for (const addr of recipients) {
      matchedLead = await contactStorage.findLeadByContact({ workspaceId, channel: 'email', value: addr });
      if (matchedLead) break;
    }
    // Fallback: thread match to prior outreach conversation
    if (!matchedLead) {
      const threadConv = await findConversationByEmailThread({ workspaceId, index, inReplyTo, references, gmailThreadId });
      if (threadConv?.leadId && !String(threadConv.leadId).startsWith('orphan_')) {
        matchedLead = { id: threadConv.leadId };
      }
    }
    if (matchedLead?.id) {
      try {
        await campaignStorage.cancelFollowUps(matchedLead.id, { workspaceId });
      } catch (e) {
        console.error('[EmailInbox] cancelFollowUps on bounce failed:', e.message);
      }
      try {
        await timelineStorage.recordEvent({
          leadId: matchedLead.id,
          type: 'email_bounced',
          channel: 'email',
          conversationId: null,
          referenceId: rfcMessageId || gmailMessageId || null,
          payload: {
            reason: bounce.reason,
            from: fromEmail,
            subject,
            failedRecipients: recipients,
            gmailMessageId,
          },
        }, { workspaceId });
      } catch (e) {
        console.error('[EmailInbox] timeline email_bounced failed:', e.message);
      }
      console.warn(`[EmailInbox] Bounce recorded for lead ${matchedLead.id} (${bounce.reason}) recipients=${recipients.join(',') || 'unknown'}`);
      return { processed: true, reason: 'bounce', leadId: matchedLead.id, failedRecipients: recipients };
    }
    console.warn(`[EmailInbox] Bounce detected but no lead matched (${bounce.reason}) from=${fromEmail} recipients=${recipients.join(',') || 'unknown'}`);
    return { processed: false, reason: 'bounce_unmatched', failedRecipients: recipients };
  }

  let conv = await findConversationByEmailThread({ workspaceId, index, inReplyTo, references, gmailThreadId });
  let lead = null;
  let contact = null;

  if (!conv) {
    lead = await contactStorage.findLeadByContact({ workspaceId, channel: 'email', value: fromLower });
    if (lead) {
      conv = await conversationStorage.findConversation({ workspaceId, leadId: lead.id, channel: 'email' });
      if (!conv) {
        conv = await conversationStorage.createConversation(
          { leadId: lead.id, channel: 'email', subject: subject || 'Re: Outreach' },
          { workspaceId }
        );
      }
    }
  }

  if (!conv) {
    contact = await personalContactStorage.findByContact({ workspaceId, channel: 'email', value: fromLower });
    if (!contact) {
      console.warn(`[EmailInbox] No lead/contact found for sender ${fromEmail}, skipping`);
      return { processed: false, reason: 'no_contact' };
    }
    const contactLeadId = `contact:${contact.id}`;
    conv = await conversationStorage.findConversation({ workspaceId, leadId: contactLeadId, channel: 'email' });
    if (!conv) {
      conv = await conversationStorage.createConversation(
        { leadId: contactLeadId, channel: 'email', subject: subject || 'Re: Contact Outreach' },
        { workspaceId }
      );
    }
  }

  if (!lead && !contact && conv) {
    if (String(conv.leadId || '').startsWith('contact:')) {
      const contactId = String(conv.leadId).replace(/^contact:/, '');
      contact = await personalContactStorage.get(contactId, { workspaceId }).catch(() => null);
    } else {
      const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 }).catch(() => []);
      lead = leads.find((l) => l.id === conv.leadId) || null;
    }
  }

  const metadata = {
    ...(contact ? { entityType: 'contact', contactId: contact.id, contact } : {}),
    html: prepared.displayHtml || prepared.replyHtml || null,
    displayHtml: prepared.displayHtml || null,
    replyHtml: prepared.replyHtml || null,
    fullHtml: prepared.fullHtml || html || null,
    subject,
    messageId: rfcMessageId || gmailMessageId,
    rfcMessageId,
    gmailMessageId,
    gmailThreadId,
    inReplyTo,
    references: splitReferences(references),
    labelIds,
    from: fromEmail,
    attachments: attachmentsFromParsed(parsed),
  };

  const storedMsg = await conversationStorage.addMessage(conv.id, {
    direction: 'inbound',
    body: prepared.body || subject || 'Email reply received',
    channel: 'email',
    source: 'inbound',
    status: labelIds.includes('UNREAD') ? 'unread' : 'received',
    externalMessageId: gmailMessageId || rfcMessageId || null,
    messageType: 'email',
    metadata,
  }, { workspaceId });

  try {
    await conversationStorage.updateConversation(conv.id, { status: 'open' }, { workspaceId });
  } catch (_) {}

  if (lead) {
    try {
      await campaignStorage.recordReply(lead.id, { workspaceId, channel: 'email', messageText: prepared.body || text });
      await campaignStorage.cancelFollowUps(lead.id, { workspaceId });
    } catch (crmErr) {
      console.error('[EmailInbox] CRM update failed (non-fatal):', crmErr.message);
    }
  }

  await timelineStorage.recordEvent({
    leadId: conv.leadId,
    workspaceId,
    type: 'message_received',
    channel: 'email',
    conversationId: conv.id,
    referenceId: rfcMessageId || gmailMessageId || storedMsg.id,
    payload: { subject, preview: (prepared.body || text || '').slice(0, 200), gmailThreadId },
  });

  for (const id of [rfcMessageId, gmailMessageId, gmailThreadId].map(normalizeMessageRef).filter(Boolean)) {
    index.ids.add(id);
    index.conversationByRef.set(id, conv.id);
  }

  console.log(`[EmailInbox] Processed inbound email from ${fromEmail} → conversation ${conv.id}`);

  // Autonomous AI email reply (server-side, no manual button required)
  if (conv.channel === 'email' && !String(conv.leadId || '').startsWith('preview_')) {
    const autonomousReplyService = require('./autonomousReplyService');
    setImmediate(() => {
      autonomousReplyService.maybeAutoReplyToInboundEmail({
        workspaceId,
        conversationId: conv.id,
        userId: workspaceId,
      }).then((autoResult) => {
        if (autoResult.sent) {
          console.log(`[EmailInbox] Autonomous AI reply sent for conversation ${conv.id}`);
        }
      }).catch((autoErr) => {
        console.error('[EmailInbox] Autonomous AI reply failed (non-fatal):', autoErr.message);
      });
    });
  }

  return { processed: true, conversationId: conv.id };
}

/**
 * Process one already-identified Gmail message id: fetch its raw content,
 * run it through the shared inbound pipeline, and mark it read on Gmail if
 * needed. Shared by both the full-list sync and the history-based sync so
 * the two code paths can never drift apart.
 */
async function fetchAndProcessGmailMessage({ gmail, workspaceId, user, gmailMessageId, threadIdHint, index }) {
  logGmailApiCall(workspaceId, 'messages.get', { gmailMessageId });
  let rawRes;
  try {
    rawRes = await gmail.users.messages.get({ userId: 'me', id: gmailMessageId, format: 'raw' });
    console.log('[GmailAPI] response received: messages.get', { workspaceId, gmailMessageId });
  } catch (getErr) {
    console.error('[GmailAPI] request failed: messages.get', { workspaceId, gmailMessageId, message: getErr.message });
    throw enrichExternalError(getErr, { operation: 'users.messages.get', workspaceId, gmailMessageId });
  }

  const raw = rawRes.data.raw;
  if (!raw) return { processed: false };

  const parsed = await simpleParser(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  const fromEmail = parsed.from?.value?.[0]?.address || parsed.from?.text || '';
  const result = await processParsedInboundEmail({
    workspaceId,
    parsed,
    fromEmail,
    configUser: user,
    gmailMessageId,
    gmailThreadId: rawRes.data.threadId || threadIdHint || null,
    labelIds: rawRes.data.labelIds || [],
    index,
  });

  if (result.processed && (rawRes.data.labelIds || []).includes('UNREAD')) {
    try {
      logGmailApiCall(workspaceId, 'messages.modify', { gmailMessageId });
      await gmail.users.messages.modify({
        userId: 'me',
        id: gmailMessageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
      console.log('[GmailAPI] response received: messages.modify', { workspaceId, gmailMessageId });
    } catch (modifyErr) {
      console.warn('[EmailInbox] Could not mark Gmail message read:', modifyErr.message);
    }
  }

  return result;
}

/**
 * Fast-path sync using the Gmail History API — only asks Gmail "what
 * changed since checkpoint X" (history.list, ~2 quota units) instead of
 * re-listing and re-checking the last N inbox messages every poll. This is
 * what makes a short poll interval (default 10s) safe: the steady-state
 * cost when nothing changed is a single cheap call, not a full re-scan.
 */
/**
 * Safety cap on messages processed per history-based poll. A normal
 * reply-detection poll (every ~10s while the Inbox is open) has 0-1 new
 * messages, so this only matters after a checkpoint has gone stale (e.g.
 * the Inbox was closed for a long time and a lot of unrelated mail — most
 * commonly newsletters/notifications, never actual customer replies —
 * arrived in the meantime). Same bounded-recency trade-off the previous
 * `messages.list`-based sync already made via GMAIL_SYNC_MAX_RESULTS — not
 * a new limitation, and it keeps each poll comfortably under the queue's
 * per-operation timeout instead of processing an unbounded backlog in one
 * call.
 */
const HISTORY_SYNC_MAX_MESSAGES_PER_POLL = parseInt(process.env.HISTORY_SYNC_MAX_MESSAGES_PER_POLL, 10) || 25;
/** History.list page-count cap — bounds worst-case API calls for a single poll. */
const HISTORY_SYNC_MAX_PAGES = 5;

async function syncViaHistoryApi(gmail, workspaceId, user, startHistoryId) {
  const addedMessageIds = new Map(); // id -> threadId, insertion-ordered oldest→newest
  let pageToken;
  let latestHistoryId = startHistoryId;
  let pages = 0;

  do {
    logGmailApiCall(workspaceId, 'history.list', { startHistoryId, pageToken: pageToken || null });
    const historyRes = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
      pageToken,
    });
    console.log('[GmailAPI] response received: history.list', {
      workspaceId,
      recordCount: (historyRes.data.history || []).length,
    });

    for (const record of historyRes.data.history || []) {
      for (const added of record.messagesAdded || []) {
        const msg = added.message;
        if (msg?.id && (msg.labelIds || []).includes('INBOX')) {
          addedMessageIds.set(msg.id, msg.threadId || null);
        }
      }
    }

    if (historyRes.data.historyId) latestHistoryId = historyRes.data.historyId;
    pageToken = historyRes.data.nextPageToken || null;
    pages += 1;
  } while (pageToken && pages < HISTORY_SYNC_MAX_PAGES);

  // Advance the checkpoint immediately, before processing — if anything
  // below throws or the queue times out, we never get stuck permanently
  // re-fetching the same large backlog on every subsequent poll.
  setStoredHistoryId(workspaceId, latestHistoryId);

  const allIds = Array.from(addedMessageIds.entries());
  const totalFound = allIds.length;
  // Most-recent-first: a customer's newest reply matters more than old
  // backlog noise if we can't process everything within one poll.
  const toProcess = allIds.slice(-HISTORY_SYNC_MAX_MESSAGES_PER_POLL);
  const deferredCount = totalFound - toProcess.length;
  if (deferredCount > 0) {
    console.warn('[EmailInbox] History backlog exceeds per-poll cap — processing the most recent',
      toProcess.length, 'of', totalFound, 'and skipping the rest (checkpoint already advanced)', { workspaceId });
  }

  const index = await getExistingEmailIndex(workspaceId, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  let processed = 0;
  let skipped = deferredCount;
  let yielded = false;

  for (const [gmailMessageId, threadIdHint] of toProcess) {
    if (index.ids.has(normalizeMessageRef(gmailMessageId))) {
      skipped++;
      continue;
    }
    if (shouldYieldInboxSync(workspaceId)) {
      console.log('[EmailInbox] Yielding history sync — campaign send waiting', { workspaceId, processed, skipped });
      yielded = true;
      break;
    }
    if (QUEUE_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, QUEUE_DELAY_MS));
    }

    const result = await fetchAndProcessGmailMessage({ gmail, workspaceId, user, gmailMessageId, threadIdHint, index });
    if (result.processed) processed++;
    else skipped++;
  }

  return { processed, skipped, provider: 'gmail_api_history', yielded, deferredCount };
}

/**
 * Full re-list sync — used for the first sync after a session starts (no
 * checkpoint yet) or after a history checkpoint expires. Establishes a
 * fresh `historyId` checkpoint at the end so subsequent polls can switch to
 * the much cheaper history-based sync above.
 */
async function syncViaFullList(gmail, workspaceId, user, sinceDate) {
    const index = await getExistingEmailIndex(workspaceId, sinceDate.toISOString());

    logGmailApiCall(workspaceId, 'messages.list', { labelIds: ['INBOX'] });
    let listRes;
    try {
      listRes = await gmail.users.messages.list({
        userId: 'me',
        labelIds: ['INBOX'],
        q: 'newer_than:7d -category:promotions -category:social',
        maxResults: GMAIL_SYNC_MAX_RESULTS,
      });
      console.log('[GmailAPI] response received: messages.list', { workspaceId, count: (listRes.data.messages || []).length });
    } catch (listErr) {
      console.error('[GmailAPI] request failed: messages.list', { workspaceId, message: listErr.message });
      throw enrichExternalError(listErr, { operation: 'users.messages.list', workspaceId });
    }

    const messages = listRes.data.messages || [];
    let processed = 0;
    let skipped = 0;
    let yielded = false;

    for (const item of messages) {
      if (shouldYieldInboxSync(workspaceId)) {
        console.log('[EmailInbox] Yielding inbox sync early — campaign send waiting', { workspaceId, processed, skipped });
        yielded = true;
        break;
      }

      const gmailMessageId = item.id;
      if (gmailMessageId && index.ids.has(normalizeMessageRef(gmailMessageId))) {
        skipped++;
        continue;
      }

      if (QUEUE_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, QUEUE_DELAY_MS));
      }

      if (shouldYieldInboxSync(workspaceId)) {
        console.log('[EmailInbox] Yielding inbox sync before messages.get — campaign send waiting', { workspaceId, gmailMessageId });
        yielded = true;
        break;
      }

      const result = await fetchAndProcessGmailMessage({ gmail, workspaceId, user, gmailMessageId, threadIdHint: item.threadId, index });
      if (result.processed) processed++;
      else skipped++;
    }

    // Establish a historyId checkpoint so the NEXT poll can use the much
    // cheaper history.list-based sync instead of repeating this full scan.
    try {
      logGmailApiCall(workspaceId, 'getProfile', {});
      const profileRes = await gmail.users.getProfile({ userId: 'me' });
      if (profileRes.data.historyId) setStoredHistoryId(workspaceId, profileRes.data.historyId);
    } catch (profileErr) {
      console.warn('[EmailInbox] Could not establish history checkpoint:', profileErr.message);
    }

    return { processed, skipped, provider: 'gmail_api', yielded };
}

/**
 * Dispatcher: uses the cheap Gmail History API when a checkpoint exists,
 * transparently falling back to a full re-list sync on the first run for a
 * workspace or if Gmail reports the checkpoint has expired (404).
 */
async function fetchUnreadEmailsViaGmailApi(workspaceId, sinceDate) {
  return runGmailOperation(workspaceId, 'inbox.sync', async () => {
    const client = await getGmailClient(workspaceId);
    if (!client) {
      return { processed: 0, skipped: 0, fallback: true, error: 'Gmail API client unavailable' };
    }
    const { gmail, user } = client;

    const startHistoryId = getStoredHistoryId(workspaceId);
    if (startHistoryId) {
      try {
        return await syncViaHistoryApi(gmail, workspaceId, user, startHistoryId);
      } catch (historyErr) {
        if (isHistoryCheckpointExpired(historyErr)) {
          console.warn('[EmailInbox] History checkpoint expired — falling back to full sync', { workspaceId });
          clearStoredHistoryId(workspaceId);
          // fall through to full-list sync below
        } else {
          throw historyErr;
        }
      }
    }

    return await syncViaFullList(gmail, workspaceId, user, sinceDate);
  }, { priority: 'low' });
}

/**
 * Open INBOX, fetch emails from the last 7 days, process each one.
 * Uses SINCE instead of UNSEEN so replies are never missed even if
 * already read in another client.
 */
async function fetchUnreadEmails(workspaceId = 'default') {
  if (isBackgroundSuspended(workspaceId)) {
    const { getPausedUntil } = require('../utils/gmailApiQueue');
    const retryAfter = new Date(getPausedUntil(workspaceId)).toISOString();
    console.log('[EmailInbox] Sync skipped — Gmail cooldown active', { workspaceId, retryAfter });
    return { processed: 0, skipped: 0, suspended: true, reason: 'rate_limit_cooldown', retryAfter };
  }

  if (syncLocks.get(workspaceId)) {
    return { processed: 0, skipped: 0, reason: 'sync_in_progress' };
  }

  syncLocks.set(workspaceId, true);
  try {
  // Build date range: last 7 days
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - 7);
  const sinceStr = sinceDate.toUTCString().replace(/\d{2}:\d{2}:\d{2} GMT/, '00:00:00 +0000');

  try {
    const apiResult = await fetchUnreadEmailsViaGmailApi(workspaceId, sinceDate);
    if (!apiResult.fallback) return apiResult;
    if (apiResult.suspended) return apiResult;
    console.warn('[EmailInbox] Gmail API sync unavailable; falling back to IMAP:', apiResult.error);
  } catch (apiErr) {
    if (apiErr.code === 'GMAIL_BACKGROUND_SUSPENDED' || apiErr.suspended) {
      return { processed: 0, skipped: 0, suspended: true, reason: 'rate_limit_cooldown', retryAfter: apiErr.retryAfter || null };
    }
    console.warn('[EmailInbox] Gmail API sync failed; falling back to IMAP:', apiErr.message);
  }

  try {
    const rec = integrationStorage.get(workspaceId, 'email');
    const expiry = rec?.credentials?.expiryDate ? new Date(rec.credentials.expiryDate).getTime() : 0;
    if (rec?.connected && rec.type === 'oauth2' && expiry && expiry - Date.now() < 5 * 60 * 1000) {
      await refreshAccessToken(workspaceId);
    }
  } catch (refreshErr) {
    console.warn('[EmailInbox] Could not refresh token before IMAP fallback:', refreshErr.message);
  }

  const config = getImapConfig(workspaceId);
  if (!config) {
    console.log('[EmailInbox] No IMAP credentials configured. Skipping poll.');
    return { processed: 0, skipped: 0 };
  }

  return await new Promise((resolve) => {
    let imap;
    try {
      imap = new Imap(config);
    } catch (initErr) {
      console.error('[EmailInbox] IMAP init error:', initErr.message);
      return resolve({ processed: 0, skipped: 0, error: initErr.message });
    }
    let processed = 0;
    let skipped = 0;
    let resolved = false;

    function safeResolve(result) {
      if (resolved) return;
      resolved = true;
      try { imap?.end(); } catch (_) {}
      resolve(result);
    }

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) {
          console.error('[EmailInbox] Open INBOX failed:', err.message);
          return safeResolve({ processed, skipped, error: err.message });
        }

        // Search ALL emails in the last 7 days — NOT just UNSEEN.
        // This guarantees we catch replies that were already read in Gmail mobile.
        imap.search([['SINCE', sinceStr]], (searchErr, results) => {
          if (searchErr) {
            console.error('[EmailInbox] Search failed:', searchErr.message);
            return safeResolve({ processed, skipped, error: searchErr.message });
          }

          if (!results || results.length === 0) {
            return safeResolve({ processed: 0, skipped: 0 });
          }

          console.log(`[EmailInbox] Found ${results.length} email(s) since ${sinceStr} for workspace ${workspaceId}`);

          getExistingEmailIndex(workspaceId, sinceDate.toISOString()).then((index) => {
          const fetch = imap.fetch(results, { bodies: '', markSeen: false });
          let pending = 0;

          fetch.on('message', (msg, seqno) => {
            pending++;
            let buffer = Buffer.alloc(0);
            let msgUid = null;

            msg.on('body', (stream) => {
              stream.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
              });
            });

            msg.once('attributes', (attrs) => {
              msgUid = attrs.uid;
            });

            msg.once('end', async () => {
              try {
                const parsed = await simpleParser(buffer);
                const fromEmail = parsed.from?.value?.[0]?.address || parsed.from?.text || '';
                const result = await processParsedInboundEmail({
                  workspaceId,
                  parsed,
                  fromEmail,
                  configUser: config.user,
                  gmailMessageId: parsed.messageId || `imap-${msgUid || seqno}`,
                  gmailThreadId: null,
                  labelIds: [],
                  index,
                });
                if (result.processed) processed++;
                else skipped++;
              } catch (procErr) {
                console.error('[EmailInbox] Failed to process email:', procErr.message);
                skipped++;
              }

              if (msgUid) imap.addFlags(msgUid, ['\\Seen'], () => {});
              else imap.seq.addFlags(seqno, ['\\Seen'], () => {});

              if (--pending === 0) {
                safeResolve({ processed, skipped });
              }
            });
          });

          fetch.once('error', (fetchErr) => {
            console.error('[EmailInbox] Fetch error:', fetchErr.message);
            safeResolve({ processed, skipped, error: fetchErr.message });
          });
          }).catch((indexErr) => {
            console.error('[EmailInbox] Failed to build email index:', indexErr.message);
            safeResolve({ processed, skipped, error: indexErr.message });
          });
        });
      });
    });

    imap.once('error', (err) => {
      console.error('[EmailInbox] IMAP connection error:', err.message);
      safeResolve({ processed, skipped, error: err.message });
    });

    try {
      imap.connect();
    } catch (connErr) {
      console.error('[EmailInbox] IMAP connect() threw:', connErr.message);
      safeResolve({ processed: 0, skipped: 0, error: connErr.message });
    }
  });
  } finally {
    syncLocks.delete(workspaceId);
  }
}

/**
 * Run one inbox poll tick for a workspace (only when session is active).
 */
async function pollWorkspaceInbox(workspaceId) {
  if (!activeSessions.has(workspaceId)) return { skipped: true, reason: 'no_active_session' };
  if (isBackgroundSuspended(workspaceId)) {
    console.log('[EmailInbox] Poll skipped — Gmail cooldown active', { workspaceId });
    return { skipped: true, reason: 'rate_limit_cooldown' };
  }
  if (isSendQueueBusy(workspaceId)) {
    console.log('[EmailInbox] Poll skipped — campaign send in progress', { workspaceId });
    return { skipped: true, reason: 'send_in_progress' };
  }

  try {
    const result = await fetchUnreadEmails(workspaceId);
    if (result.processed > 0 || result.skipped > 0) {
      console.log(`[EmailInbox] Poll complete for ${workspaceId}: ${result.processed} processed, ${result.skipped} skipped`);
    }
    return result;
  } catch (wsErr) {
    console.error(`[EmailInbox] Poll error for workspace ${workspaceId}:`, wsErr.message);
    throw wsErr;
  }
}

function scheduleSessionPoll(workspaceId, { immediate = false } = {}) {
  const session = activeSessions.get(workspaceId);
  if (!session) return;

  if (immediate && !session.initialSyncScheduled) {
    session.initialSyncScheduled = true;
    session.initialTimer = setTimeout(() => {
      pollWorkspaceInbox(workspaceId).catch(() => {});
    }, INBOX_INITIAL_SYNC_DELAY_MS);
  }

  if (!session.pollTimer) {
    session.pollTimer = setInterval(() => {
      pollWorkspaceInbox(workspaceId).catch(() => {});
    }, INBOX_POLL_INTERVAL_MS);
  }
}

function clearSessionTimers(session) {
  if (session.initialTimer) {
    clearTimeout(session.initialTimer);
    session.initialTimer = null;
  }
  if (session.pollTimer) {
    clearInterval(session.pollTimer);
    session.pollTimer = null;
  }
  session.initialSyncScheduled = false;
}

/**
 * Begin Inbox page session — starts low-frequency Gmail sync for one workspace.
 */
function beginSession(workspaceId = 'default') {
  const ws = String(workspaceId || 'default');
  const rec = integrationStorage.get(ws, 'email');
  if (!rec || !rec.connected || rec.type !== 'oauth2') {
    return { active: false, reason: 'email_not_connected' };
  }

  let session = activeSessions.get(ws);
  if (!session) {
    session = { refCount: 0, pollTimer: null, initialTimer: null, initialSyncScheduled: false };
    activeSessions.set(ws, session);
  }
  session.refCount += 1;

  if (session.refCount === 1) {
    console.log(`[EmailInbox] Session started for ${ws} (poll every ${INBOX_POLL_INTERVAL_MS / 1000}s)`);
    scheduleSessionPoll(ws, { immediate: true });
  }

  return { active: true, refCount: session.refCount, pollIntervalMs: INBOX_POLL_INTERVAL_MS };
}

/**
 * End Inbox page session — stops Gmail polling when last client disconnects.
 */
function endSession(workspaceId = 'default') {
  const ws = String(workspaceId || 'default');
  const session = activeSessions.get(ws);
  if (!session) return { active: false, refCount: 0 };

  session.refCount = Math.max(0, session.refCount - 1);
  if (session.refCount === 0) {
    clearSessionTimers(session);
    activeSessions.delete(ws);
    console.log(`[EmailInbox] Session ended for ${ws} — polling stopped`);
  }

  return { active: session.refCount > 0, refCount: session.refCount };
}

/**
 * Stop all inbox sessions (graceful shutdown).
 */
function stopAllSessions() {
  for (const [ws, session] of activeSessions.entries()) {
    clearSessionTimers(session);
    console.log(`[EmailInbox] Session stopped for ${ws}`);
  }
  activeSessions.clear();
}

/**
 * Manual sync trigger (Refresh button on Inbox page).
 */
async function syncNow(workspaceId = 'default') {
  if (!activeSessions.has(workspaceId)) {
    return { processed: 0, skipped: 0, reason: 'inbox_session_inactive' };
  }
  return fetchUnreadEmails(workspaceId);
}

/** @deprecated Use beginSession/endSession — no global polling at startup. */
function start() {
  console.warn('[EmailInbox] start() is deprecated — inbox polling is Inbox-page session only');
}

/** @deprecated Use stopAllSessions */
function stop() {
  stopAllSessions();
}

module.exports = {
  beginSession,
  endSession,
  stopAllSessions,
  syncNow,
  pollWorkspaceInbox,
  fetchUnreadEmails,
  processParsedInboundEmail,
  start,
  stop,
};
