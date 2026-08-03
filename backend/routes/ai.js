/**
 * AI Sales Agent routes (S5).
 *
 * S5.1 — Qualification:
 *   POST /api/ai/qualify  { leadIds?, campaign? }  → score leads, persist, return ranked
 *   GET  /api/ai/scores                            → stored scores (joined with leads), ranked
 *
 * S5.2 — Outreach generation + human approval (approve-before-send hard gate):
 *   POST /api/ai/outreach            { leadId }    → generate drafts for a lead, persist, return them
 *   GET  /api/ai/drafts              ?leadId&status → stored drafts (joined with leads)
 *   POST /api/ai/drafts/:id/approve                → mark a draft approved
 *   POST /api/ai/drafts/:id/reject                 → mark a draft rejected
 *
 * S5.3 — Inbox foundation (conversations + messages):
 *   GET  /api/ai/conversations                     → conversations (joined with leads), newest first
 *   POST /api/ai/conversations/from-draft { draftId } → start/append a conversation from an APPROVED draft
 *   GET  /api/ai/conversations/:id/messages        → thread messages (oldest first)
 *   POST /api/ai/conversations/:id/messages { body, direction? } → append a message
 *
 * All routes are mounted behind requireAuth in server.js and are workspace-scoped.
 */

const express = require('express');
const router = express.Router();
const leadStorage = require('../utils/leadStorage');
const campaignStorage = require('../utils/campaignStorage');
const scoreStorage = require('../utils/scoreStorage');
const draftStorage = require('../utils/draftStorage');
const conversationStorage = require('../utils/conversationStorage');
const timelineStorage = require('../utils/timelineStorage');
const personalContactStorage = require('../utils/personalContactStorage');
const aiProvider = require('../services/aiProvider');
const openAiKeyService = require('../services/openAiKeyService');
const userStorage = require('../utils/userStorage');
const { mergeAiAgentConfig } = require('../utils/aiAgentConfig');
const autonomousReplyService = require('../services/autonomousReplyService');
const { respondWithExternalError } = require('../utils/externalApiErrors');

function isContactConversationId(id) {
  return String(id || '').startsWith('contact:');
}

async function contactProfileFromConversationId(leadId, workspaceId) {
  if (!isContactConversationId(leadId)) return null;
  const contactId = String(leadId).replace(/^contact:/, '');
  const contact = await personalContactStorage.get(contactId, { workspaceId }).catch(() => null);
  if (!contact) return null;
  const email = personalContactStorage.resolveDeliveryEmail(contact) || contact.email || '';
  return {
    id: `contact:${contact.id}`,
    contactId: contact.id,
    name: contact.name || email || contact.whatsappNumber || contact.smsNumber || 'Contact',
    email,
    phone: contact.whatsappNumber || contact.smsNumber || '',
    whatsapp: contact.whatsappNumber || '',
    sms: contact.smsNumber || '',
    niche: contact.company || 'Contact',
    company: contact.company || '',
    city: '',
    notes: contact.notes || '',
    source: 'contacts',
  };
}

async function resolveConversationProfile(conversation, leadById, workspaceId) {
  if (isContactConversationId(conversation.leadId)) {
    const contactLead = await contactProfileFromConversationId(conversation.leadId, workspaceId);
    return { lead: contactLead, contact: contactLead, entityType: 'contact' };
  }
  return { lead: leadById?.get(conversation.leadId) || null, contact: null, entityType: 'lead' };
}

/** Resolve OpenAI config for the current user and return it, or respond with error if blocked. */
async function resolveOpenAi(req, res) {
  const userId = req.auth?.userId;
  const user = await userStorage.findById(userId);

  // If no real user exists (e.g., AUTH_MODE=disabled), fall back to master key
  if (!user) {
    const masterKey = process.env.OPENAI_API_KEY;
    if (!masterKey) {
      res.status(503).json({ error: 'AI service is not configured on this server.' });
      return null;
    }
    return {
      apiKey: masterKey,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      source: 'master',
      blocked: false,
      reason: null,
    };
  }

  const config = await openAiKeyService.getOpenAiConfig(userId);
  if (config.blocked) {
    if (config.reason === 'FREE_MESSAGES_EXHAUSTED') {
      res.status(403).json({
        error: 'You have used your free AI messages. Please add your own OpenAI API key in Settings to continue.',
        code: 'FREE_MESSAGES_EXHAUSTED',
        action: 'ADD_API_KEY',
      });
    } else if (config.reason === 'MASTER_KEY_NOT_CONFIGURED') {
      res.status(503).json({ error: 'AI service is not configured on this server.' });
    } else {
      res.status(403).json({ error: 'AI access denied.', code: config.reason });
    }
    return null;
  }
  return config;
}

const { workspaceOf } = require('../utils/workspaceContext');

/** Derive CRM notification badge for a conversation from messages + status. */
function deriveNotificationStatus(conv, messages, last) {
  const unread = conv.unreadCount || 0;
  const lastMsg = last || messages[messages.length - 1] || null;
  const lastDir = lastMsg?.direction;
  const lastOutbound = [...messages].reverse().find((m) => m.direction === 'outbound');
  const meta = conv.metadata || {};

  if (conv.status === 'closed' || conv.archived) {
    return { type: 'closed', label: 'Closed', icon: '⬛' };
  }
  if (conv.status === 'human_active' || meta.humanTakeover) {
    return { type: 'human_required', label: 'Human Active', icon: '👤' };
  }
  if (conv.status === 'needs_human') {
    return { type: 'human_required', label: 'Human Required', icon: '👤' };
  }
  if (conv.status === 'quote_sent') {
    return { type: 'waiting', label: 'Quote Sent', icon: '📄' };
  }
  if (conv.status === 'invoice_sent') {
    return { type: 'waiting', label: 'Invoice Sent', icon: '🧾' };
  }
  if (unread > 0 && lastDir === 'inbound') {
    return { type: 'new_reply', label: 'New Reply', icon: '🔴' };
  }
  if (lastOutbound?.metadata?.sending) {
    return { type: 'sending', label: 'Sending...', icon: '🔵' };
  }
  if (lastDir === 'outbound' && (lastOutbound?.metadata?.autoReply || lastOutbound?.metadata?.aiGenerated)) {
    return { type: 'ai_replied', label: 'AI Active', icon: '🟢' };
  }
  if (conv.status === 'ai_active' || meta.autoReplyEnabled === true) {
    return { type: 'ai_replied', label: 'AI Active', icon: '🟢' };
  }
  if (lastDir === 'outbound' && unread === 0) {
    return { type: 'waiting', label: 'Waiting for Customer', icon: '🟡' };
  }
  return null;
}

/** Merge stored scores onto their leads and rank by score (desc). */
function rank(leads, scores) {
  const byId = new Map(scores.map((s) => [s.leadId, s]));
  return leads
    .map((lead) => {
      const s = byId.get(lead.id);
      return {
        lead,
        leadId: lead.id,
        score: s ? s.score : null,
        priority: s ? s.priority : null,
        breakdown: s ? s.breakdown : null,
        model: s ? s.model : null,
        scoredAt: s ? s.createdAt : null,
      };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

// Qualify (score) leads — all of them, or a provided subset.
router.post('/qualify', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const userId = req.auth?.userId;
    const { leadIds, campaign } = req.body || {};

    const oaConfig = await resolveOpenAi(req, res);
    if (!oaConfig) return;

    let leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
    if (Array.isArray(leadIds) && leadIds.length > 0) {
      const wanted = new Set(leadIds);
      leads = leads.filter((l) => wanted.has(l.id));
    }

    if (leads.length === 0) {
      return res.json({ scores: [], count: 0, model: aiProvider.getModel(oaConfig) });
    }

    const computed = await aiProvider.qualifyLeads(leads, { campaign: campaign || {} }, oaConfig);
    await scoreStorage.upsertScores(computed, { workspaceId });

    // Consume free message if master key was used
    const remaining = await openAiKeyService.consumeFreeMessage(userId, oaConfig.source);

    // Automation trigger: score_hot for newly hot leads (non-blocking)
    try {
      const { dispatchEvent } = require('../services/automationEngine');
      const hot = (computed || []).filter((s) => String(s.priority).toLowerCase() === 'hot');
      for (const s of hot.slice(0, 50)) {
        dispatchEvent('score_hot', {
          leadId: s.leadId,
          workspaceId,
          score: s.score,
          priority: s.priority,
          userId,
        }, { workspaceId }).catch(() => {});
      }
    } catch (_) { /* non-fatal */ }

    const allScores = await scoreStorage.getScores({ workspaceId });
    const ranked = rank(leads, allScores);

    res.json({ scores: ranked, count: ranked.length, model: aiProvider.getModel(oaConfig), freeAiMessagesRemaining: remaining });
  } catch (error) {
    console.error('[AI] qualify error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List stored scores joined with their leads, ranked.
router.get('/scores', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const [leads, scores] = await Promise.all([
      leadStorage.getLeads({ workspaceId, limit: 10000 }),
      scoreStorage.getScores({ workspaceId }),
    ]);
    const ranked = rank(leads, scores);
    res.json({ success: true, scores: ranked || [], count: (ranked || []).length, mode: aiProvider.getMode() });
  } catch (error) {
    console.error('[AI] scores error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===================== S5.2: Outreach generation + approval =====================

// Generate outreach drafts for a single lead (replaces any existing drafts for it).
router.post('/outreach', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const userId = req.auth?.userId;
    const { leadId } = req.body || {};
    if (!leadId) {
      return res.status(400).json({ error: 'leadId is required' });
    }

    const oaConfig = await resolveOpenAi(req, res);
    if (!oaConfig) return;

    const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
    const lead = leads.find((l) => l.id === leadId);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found in this workspace' });
    }

    const templates = await aiProvider.generateOutreach(lead, {}, oaConfig);
    const drafts = await draftStorage.replaceDraftsForLead(leadId, templates, { workspaceId });

    // Consume free message if master key was used
    const remaining = await openAiKeyService.consumeFreeMessage(userId, oaConfig.source);

    res.json({ leadId, drafts, count: drafts.length, model: aiProvider.getModel(oaConfig), freeAiMessagesRemaining: remaining });
  } catch (error) {
    console.error('[AI] outreach error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List stored drafts (optionally by lead / status), joined with their leads.
router.get('/drafts', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const { leadId, status } = req.query;
    const [leads, drafts] = await Promise.all([
      leadStorage.getLeads({ workspaceId, limit: 10000 }),
      draftStorage.getDrafts({ workspaceId, leadId, status }),
    ]);
    const leadById = new Map(leads.map((l) => [l.id, l]));
    const enriched = drafts.map((d) => ({ ...d, lead: leadById.get(d.leadId) || null }));
    res.json({ drafts: enriched, count: enriched.length, mode: aiProvider.getMode() });
  } catch (error) {
    console.error('[AI] drafts error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Approve / reject a single draft (the human-in-the-loop gate; V1 never auto-sends).
function setStatusRoute(status) {
  return async (req, res) => {
    try {
      const workspaceId = workspaceOf(req);
      const updated = await draftStorage.setDraftStatus(req.params.id, status, { workspaceId });
      if (!updated) {
        return res.status(404).json({ error: 'Draft not found in this workspace' });
      }
      res.json({ draft: updated });
    } catch (error) {
      console.error(`[AI] draft ${status} error:`, error);
      res.status(500).json({ error: error.message });
    }
  };
}

router.post('/drafts/:id/approve', setStatusRoute('approved'));
router.post('/drafts/:id/reject', setStatusRoute('rejected'));

// ===================== S5.3: Inbox foundation (conversations + messages) =====================

// List conversations, joined with their leads + a last-message preview.
router.get('/conversations', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const [leads, conversations] = await Promise.all([
      leadStorage.getLeads({ workspaceId, limit: 10000 }),
      conversationStorage.getConversations({ workspaceId }),
    ]);
    const leadById = new Map(leads.map((l) => [l.id, l]));
    const campaigns = await campaignStorage.getAll({ workspaceId }).catch((err) => {
      console.warn('[AI] campaigns unavailable for inbox enrichment:', err.message);
      return [];
    });
    const campaignMap = new Map(campaigns.map((c) => [c.leadId, c]));
    const enriched = await Promise.all(
      conversations.map(async (c) => {
        try {
          const messages = await conversationStorage.getMessages(c.id, { workspaceId });
          const last = messages[messages.length - 1] || null;
          const campaign = campaignMap.get(c.leadId) || null;
          const profile = await resolveConversationProfile(c, leadById, workspaceId);
          return {
            ...c,
            ...profile,
            messageCount: messages.length,
            unreadCount: c.unreadCount || 0,
            lastMessage: last ? { body: last.body, direction: last.direction, createdAt: last.createdAt, metadata: last.metadata || null } : null,
            pipelineStatus: campaign?.status || 'new',
            notificationStatus: deriveNotificationStatus(c, messages, last),
          };
        } catch (err) {
          console.error(`[AI] Failed to enrich conversation ${c.id}:`, err.message);
          const profile = await resolveConversationProfile(c, leadById, workspaceId);
          return { ...c, ...profile, messageCount: 0, unreadCount: c.unreadCount || 0, lastMessage: null, pipelineStatus: 'new', notificationStatus: null };
        }
      })
    );
    res.json({ success: true, conversations: enriched || [], count: (enriched || []).length });
  } catch (error) {
    console.error('[AI] conversations error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark a conversation as read (reset unreadCount).
router.post('/conversations/:id/read', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversation = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found in this workspace' });
    }
    await conversationStorage.markMessagesRead(req.params.id, { workspaceId });
    res.json({ success: true, conversationId: req.params.id });
  } catch (error) {
    console.error('[AI] mark read error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark a conversation as unread (set unreadCount = 1 as a signal).
router.post('/conversations/:id/unread', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversation = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found in this workspace' });
    }
    await conversationStorage.updateConversation(req.params.id, { unreadCount: 1 }, { workspaceId });
    res.json({ success: true, conversationId: req.params.id });
  } catch (error) {
    console.error('[AI] mark unread error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Archive / unarchive a conversation.
router.post('/conversations/:id/archive', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversation = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    await conversationStorage.updateConversation(req.params.id, { archived: true }, { workspaceId });
    res.json({ success: true, conversationId: req.params.id, archived: true });
  } catch (error) {
    console.error('[AI] archive error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/conversations/:id/unarchive', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversation = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    await conversationStorage.updateConversation(req.params.id, { archived: false }, { workspaceId });
    res.json({ success: true, conversationId: req.params.id, archived: false });
  } catch (error) {
    console.error('[AI] unarchive error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Pin / unpin a conversation.
router.post('/conversations/:id/pin', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversation = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    await conversationStorage.updateConversation(req.params.id, { pinned: true }, { workspaceId });
    res.json({ success: true, conversationId: req.params.id, pinned: true });
  } catch (error) {
    console.error('[AI] pin error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/conversations/:id/unpin', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversation = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    await conversationStorage.updateConversation(req.params.id, { pinned: false }, { workspaceId });
    res.json({ success: true, conversationId: req.params.id, pinned: false });
  } catch (error) {
    console.error('[AI] unpin error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk archive / unarchive / delete — used by the Archived tab toolbar for
// multi-select actions. Accepts { conversationIds: string[] }.
router.post('/conversations/bulk-archive', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversationIds = Array.isArray(req.body?.conversationIds) ? req.body.conversationIds : [];
    if (!conversationIds.length) return res.status(400).json({ error: 'conversationIds array is required' });
    const result = await conversationStorage.bulkUpdateConversations(conversationIds, { archived: true }, { workspaceId });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[AI] bulk archive error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/conversations/bulk-unarchive', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversationIds = Array.isArray(req.body?.conversationIds) ? req.body.conversationIds : [];
    if (!conversationIds.length) return res.status(400).json({ error: 'conversationIds array is required' });
    const result = await conversationStorage.bulkUpdateConversations(conversationIds, { archived: false }, { workspaceId });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[AI] bulk unarchive error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/conversations/bulk-delete', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversationIds = Array.isArray(req.body?.conversationIds) ? req.body.conversationIds : [];
    if (!conversationIds.length) return res.status(400).json({ error: 'conversationIds array is required' });
    const result = await conversationStorage.bulkDeleteConversations(conversationIds, { workspaceId });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[AI] bulk delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a conversation (and all its messages).
router.delete('/conversations/:id', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversation = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    await conversationStorage.deleteConversation(req.params.id, { workspaceId });
    res.json({ success: true, conversationId: req.params.id });
  } catch (error) {
    console.error('[AI] delete conversation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete selected messages from a conversation thread.
router.post('/conversations/:id/messages/delete', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversation = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    const messageIds = Array.isArray(req.body?.messageIds) ? req.body.messageIds : [];
    if (!messageIds.length) {
      return res.status(400).json({ error: 'messageIds array is required' });
    }
    const deleted = await conversationStorage.deleteMessages(messageIds, { workspaceId });
    res.json({ success: true, conversationId: req.params.id, deleted });
  } catch (error) {
    console.error('[AI] delete messages error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Timeline events for a conversation (merged from lead_events).
router.get('/conversations/:id/timeline', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversation = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    const events = await timelineStorage.getEvents(conversation.leadId, { workspaceId });
    if (isContactConversationId(conversation.leadId)) {
      const contactId = String(conversation.leadId).replace(/^contact:/, '');
      const contact = await personalContactStorage.get(contactId, { workspaceId }).catch(() => null);
      if (contact?.createdAt) {
        events.unshift({
          id: `contact-created-${contact.id}`,
          leadId: conversation.leadId,
          workspaceId,
          type: 'contact_created',
          channel: null,
          conversationId: conversation.id,
          referenceId: contact.id,
          payload: { name: contact.name, email: contact.email, company: contact.company },
          createdAt: contact.createdAt,
        });
      }
    }
    events.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    res.json({ events, count: events.length });
  } catch (error) {
    console.error('[AI] timeline error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start (or append to) a conversation from an APPROVED draft. This is how an
// approved message reaches the Inbox — the approve-before-send gate is enforced here.
router.post('/conversations/from-draft', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const { draftId } = req.body || {};
    if (!draftId) {
      return res.status(400).json({ error: 'draftId is required' });
    }

    const draft = await draftStorage.getDraftById(draftId, { workspaceId });
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found in this workspace' });
    }
    if (draft.status !== 'approved') {
      return res.status(409).json({ error: 'Only approved drafts can be moved to the inbox' });
    }

    let conversation = await conversationStorage.findConversation({
      workspaceId,
      leadId: draft.leadId,
      channel: draft.channel,
    });
    if (!conversation) {
      conversation = await conversationStorage.createConversation(
        { leadId: draft.leadId, channel: draft.channel, subject: draft.subject || null },
        { workspaceId }
      );
    }

    const message = await conversationStorage.addMessage(
      conversation.id,
      { direction: 'outbound', channel: draft.channel, body: draft.body, source: 'ai_draft', draftId: draft.id },
      { workspaceId }
    );

    res.json({ conversation, message });
  } catch (error) {
    console.error('[AI] from-draft error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Thread messages for a conversation.
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversation = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found in this workspace' });
    }
    const unified = req.query.unified === '1' || req.query.unified === 'true';
    const messages = unified
      ? await conversationStorage.getUnifiedMessagesForLead(conversation.leadId, { workspaceId })
      : await conversationStorage.getMessages(req.params.id, { workspaceId });
    const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
    const leadById = new Map(leads.map((l) => [l.id, l]));
    const profile = await resolveConversationProfile(conversation, leadById, workspaceId);
    const relatedConversations = unified
      ? await conversationStorage.getConversationsForLead(conversation.leadId, { workspaceId })
      : [conversation];
    const safeMessages = Array.isArray(messages) ? messages : [];
    res.json({
      success: true,
      conversation: { ...conversation, ...profile },
      messages: safeMessages,
      count: safeMessages.length,
      unified,
      relatedConversations: Array.isArray(relatedConversations) ? relatedConversations : [],
    });
  } catch (error) {
    console.error('[AI] messages error:', error);
    res.status(500).json({ error: error.message });
  }
});

function buildEmailThreadHeaders(messages) {
  const emailMsgs = messages.filter((m) => m.channel === 'email' || m.messageType === 'email');
  const lastInbound = [...emailMsgs].reverse().find((m) => m.direction === 'inbound');
  const lastEmail = [...emailMsgs].reverse().find((m) => m.metadata?.rfcMessageId || m.metadata?.messageId || m.metadata?.gmailThreadId);
  return {
    lastInbound,
    lastEmail,
    threadId: lastEmail?.metadata?.gmailThreadId || null,
    inReplyTo: lastInbound?.metadata?.rfcMessageId || lastInbound?.metadata?.messageId || lastEmail?.metadata?.rfcMessageId || null,
    references: [
      ...(Array.isArray(lastEmail?.metadata?.references) ? lastEmail.metadata.references : []),
      lastEmail?.metadata?.rfcMessageId,
      lastEmail?.metadata?.messageId,
      lastInbound?.metadata?.rfcMessageId,
      lastInbound?.metadata?.messageId,
    ].filter(Boolean).join(' '),
  };
}

/**
 * POST /api/ai/conversations/:id/send-reply
 * Send a manual reply in the conversation channel with proper email threading.
 */
router.post('/conversations/:id/send-reply', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversationId = req.params.id;
    const { body, subject, imageUrl } = req.body || {};
    if (!body || !String(body).trim()) {
      return res.status(400).json({ error: 'body is required' });
    }

    const conv = await conversationStorage.getConversation(conversationId, { workspaceId });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const messages = await conversationStorage.getMessages(conversationId, { workspaceId });
    let lead = null;
    if (isContactConversationId(conv.leadId)) {
      lead = await contactProfileFromConversationId(conv.leadId, workspaceId);
    } else {
      const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
      lead = leads.find((l) => l.id === conv.leadId) || null;
    }
    if (!lead) return res.status(404).json({ error: 'Recipient not found for this conversation' });

    const userId = (req.auth && req.auth.userId) || workspaceId;
    const senderEmail = await userStorage.getSenderEmail(userId).catch(() => null);
    let sentResult = null;
    let richMetadata = { source: 'manual_reply' };

    if (conv.channel === 'email' && lead.email) {
      const { sendEmailToLead } = require('../services/emailService');
      const thread = buildEmailThreadHeaders(messages);
      const replySubject = subject?.trim()
        || (conv.subject && /^re:/i.test(conv.subject) ? conv.subject : `Re: ${conv.subject || 'Outreach'}`);
      const attachments = imageUrl ? [{ filename: 'attachment.png', path: imageUrl, cid: 'reply-image@leadflow.ai' }] : [];
      sentResult = await sendEmailToLead(lead, {
        message: String(body).trim(),
        subject: replySubject,
        workspaceId,
        senderEmail,
        attachments,
        threadId: thread.threadId,
        inReplyTo: thread.inReplyTo,
        references: thread.references,
      });
      richMetadata = {
        ...richMetadata,
        html: sentResult.displayHtml || sentResult.html,
        text: sentResult.text,
        subject: sentResult.subject || replySubject,
        messageId: sentResult.messageId,
        rfcMessageId: sentResult.rfcMessageId,
        gmailThreadId: sentResult.gmailThreadId,
        inReplyTo: thread.inReplyTo,
        references: thread.references ? thread.references.split(/\s+/).filter(Boolean) : [],
        imageUrl: imageUrl || null,
      };
    } else if (conv.channel === 'sms' && lead.phone) {
      const { sendSms } = require('../services/smsService');
      sentResult = await sendSms({ to: lead.phone, body: String(body).trim(), workspaceId, mediaUrl: imageUrl || undefined });
    } else if (conv.channel === 'whatsapp') {
      const whatsappTransport = require('../services/whatsappTransport');
      const to = lead.whatsapp || lead.phone;
      if (!to) return res.status(400).json({ error: 'Lead has no WhatsApp / phone number' });
      if (!whatsappTransport.isConfigured(workspaceId)) {
        return res.status(503).json({
          error: 'WhatsApp not connected',
          message: 'Configure Meta Cloud API credentials in WhatsApp Settings first',
        });
      }
      sentResult = imageUrl
        ? await whatsappTransport.sendImage({
          workspaceId,
          to,
          imageUrl,
          caption: String(body).trim(),
          testMode: false,
        })
        : await whatsappTransport.sendText({
          workspaceId,
          to,
          message: String(body).trim(),
          testMode: false,
        });
      richMetadata = {
        ...richMetadata,
        imageUrl: imageUrl || null,
        mediaUrl: imageUrl || null,
        messageId: sentResult?.messageId || null,
        attachments: imageUrl ? [{ url: imageUrl, type: 'image' }] : undefined,
      };
    } else {
      return res.status(400).json({ error: `Cannot send reply on channel ${conv.channel}` });
    }

    const outboundMsg = await conversationStorage.addMessage(conversationId, {
      direction: 'outbound',
      body: String(body).trim(),
      channel: conv.channel,
      source: 'manual',
      status: sentResult ? 'sent' : null,
      externalMessageId: sentResult?.messageId || null,
      messageType: imageUrl && conv.channel === 'whatsapp'
        ? 'image'
        : (conv.channel === 'email' ? 'email' : 'text'),
      metadata: richMetadata,
    }, { workspaceId });

    // Manual human reply → stop AI for this thread until Resume AI
    if (conv.channel === 'whatsapp' || conv.channel === 'email') {
      const meta = { ...(conv.metadata || {}), humanTakeover: true };
      await conversationStorage.updateConversation(
        conversationId,
        { status: 'human_active', metadata: meta },
        { workspaceId }
      ).catch(() => null);
      await timelineStorage.recordEvent({
        leadId: conv.leadId,
        type: 'ai_action',
        channel: conv.channel,
        conversationId,
        referenceId: outboundMsg.id,
        payload: { action: 'human_reply', preview: String(body).trim().slice(0, 80) },
      }, { workspaceId }).catch(() => null);
    }

    res.json({
      success: true,
      message: outboundMsg,
      sent: !!sentResult,
      conversationId,
      messageId: sentResult?.messageId || outboundMsg.id,
    });
  } catch (error) {
    console.error('[AI] send-reply error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate a context-aware reply suggestion for a conversation.
router.post('/conversations/:id/reply', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const userId = req.auth?.userId || workspaceId;

    const oaConfig = await resolveOpenAi(req, res);
    if (!oaConfig) return; // already responded with error

    const conversation = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found in this workspace' });
    }

    const messages = await conversationStorage.getMessages(req.params.id, { workspaceId });
    let lead = null;
    if (isContactConversationId(conversation.leadId)) {
      lead = await contactProfileFromConversationId(conversation.leadId, workspaceId);
    } else {
      const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
      lead = leads.find((l) => l.id === conversation.leadId) || null;
    }

    const agentConfig = mergeAiAgentConfig(
      await userStorage.getAiAgentConfig(userId),
      await userStorage.findById(userId),
    );

    const suggestion = await aiProvider.generateReply(messages, lead, { workspaceId, config: oaConfig, agentConfig });

    // Consume free message if master key was used
    const remaining = await openAiKeyService.consumeFreeMessage(userId, oaConfig.source);

    res.json({
      suggestion,
      messageCount: messages.length,
      leadId: conversation.leadId,
      freeAiMessagesRemaining: remaining,
    });
  } catch (error) {
    return respondWithExternalError(res, error, { route: 'POST /api/ai/conversations/:id/reply', workspaceId: workspaceOf(req) }, 'Failed to generate AI reply');
  }
});

// Autonomous AI Decision Engine (Change 1)
// POST /api/ai/autonomous { message, lead?, conversation? }
// Returns { action, message, data, model } and optionally executes the action.
router.post('/autonomous', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const userId = req.auth?.userId;
    const { message, lead, conversation, execute = false } = req.body || {};
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const oaConfig = await resolveOpenAi(req, res);
    if (!oaConfig) return; // already responded with error

    const decision = await aiProvider.autonomousDecision({ message, lead, conversation }, oaConfig);

    // Consume free message if master key was used
    const remaining = await openAiKeyService.consumeFreeMessage(userId, oaConfig.source);

    // If execute=true and action is scrape, record the intent
    if (execute && decision.action === 'scrape') {
      try {
        decision.executed = false;
        decision.note = 'Scrape job queued. Use /api/scrape to execute with the returned parameters.';
      } catch (e) {
        decision.executionError = e.message;
      }
    }

    res.json({ ...decision, workspaceId, freeAiMessagesRemaining: remaining });
  } catch (error) {
    console.error('[AI] autonomous error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Append a message to a conversation (V1 records it; actual send stays manual).
router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const { body, direction } = req.body || {};
    if (!body || !String(body).trim()) {
      return res.status(400).json({ error: 'body is required' });
    }
    const message = await conversationStorage.addMessage(
      req.params.id,
      { body: String(body), direction: direction === 'inbound' ? 'inbound' : 'outbound', source: 'manual' },
      { workspaceId }
    );
    if (!message) {
      return res.status(404).json({ error: 'Conversation not found in this workspace' });
    }
    res.json({ message });
  } catch (error) {
    console.error('[AI] add message error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate a fresh AI marketing message (OpenAI-powered, never cached).
router.post('/generate-message', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    const { businessType, goal, language, tone, length, writingStyle } = req.body || {};

    const oaConfig = await resolveOpenAi(req, res);
    if (!oaConfig) return;

    const prompt = `Write a single marketing message for a ${businessType || 'business'}.
Goal: ${goal || 'booking'}.
Tone: ${tone || 'professional'}.
Length: ${length || 'medium'}.
Writing style: ${writingStyle || 'native'}.
Language: ${language || 'en'}.

Return ONLY a JSON object with this exact shape — no markdown, no extra commentary:
{
  "message": "the generated message text here"
}`;

    const response = await aiProvider.callOpenAI(
      [{ role: 'system', content: 'You are an expert sales copywriter who writes high-converting outreach messages for local businesses.' },
       { role: 'user', content: prompt }],
      0.85,
      300,
      oaConfig
    );

    const generated = response.message || response.text || JSON.stringify(response);

    // Consume free message if master key was used
    const remaining = await openAiKeyService.consumeFreeMessage(userId, oaConfig.source);

    res.json({ message: generated, model: aiProvider.getModel(oaConfig), freeAiMessagesRemaining: remaining });
  } catch (error) {
    console.error('[AI] generate-message error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================================================================
// Auto AI Reply — Generate and send AI response in one call
// =====================================================================

/**
 * POST /api/ai/conversations/:id/auto-reply
 *
 * Generates an AI reply for the last inbound message and sends it automatically.
 * Returns { success, message, sent, conversationId }.
 */
router.post('/conversations/:id/auto-reply', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const userId = req.auth?.userId || workspaceId;
    const conversationId = req.params.id;

    const conv = await conversationStorage.getConversation(conversationId, { workspaceId });
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (conv.channel === 'email' || conv.channel === 'whatsapp' || conv.channel === 'sms') {
      const autoResult = await autonomousReplyService.maybeAutoReplyToInbound({
        workspaceId,
        conversationId,
        userId,
        expectedChannel: conv.channel,
      });
      if (!autoResult.sent) {
        return res.status(autoResult.reason === 'no_inbound_message' ? 400 : 409).json({
          error: autoResult.reason || 'Auto reply could not be sent',
          sent: false,
        });
      }
      const messages = await conversationStorage.getMessages(conversationId, { workspaceId });
      const outbound = [...messages].reverse().find((m) => m.direction === 'outbound' && m.source === 'auto-ai');
      return res.json({
        success: true,
        message: outbound
          ? { id: outbound.id, body: outbound.body, intent: outbound.metadata?.intent || 'general', model: 'auto-ai' }
          : { body: '', intent: autoResult.intent || 'general' },
        sent: true,
        conversationId,
        channel: conv.channel,
        recipientEmail: autoResult.recipientEmail || null,
        recipientPhone: autoResult.recipientPhone || null,
      });
    }

    return res.status(400).json({ error: `Auto-reply not supported for channel ${conv.channel}` });
  } catch (error) {
    return respondWithExternalError(res, error, { route: 'POST /api/ai/conversations/:id/auto-reply', workspaceId: workspaceOf(req) }, 'Auto-reply failed');
  }
});

/**
 * GET /api/ai/conversations/:id/settings
 * POST /api/ai/conversations/:id/settings  { autoReplyEnabled?, humanTakeover?, status? }
 */
router.get('/conversations/:id/settings', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conv = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const meta = conv.metadata || {};
    res.json({
      success: true,
      conversationId: conv.id,
      channel: conv.channel,
      status: conv.status,
      settings: {
        autoReplyEnabled: meta.autoReplyEnabled ?? null,
        humanTakeover: Boolean(meta.humanTakeover) || conv.status === 'human_active',
        needsHuman: conv.status === 'needs_human' || Boolean(meta.needsHuman),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/conversations/:id/settings', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conv = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const { autoReplyEnabled, humanTakeover, status } = req.body || {};
    const meta = { ...(conv.metadata || {}) };
    let nextStatus = conv.status;

    if (typeof autoReplyEnabled === 'boolean') {
      meta.autoReplyEnabled = autoReplyEnabled;
      if (autoReplyEnabled && !meta.humanTakeover) nextStatus = 'ai_active';
    }
    if (typeof humanTakeover === 'boolean') {
      meta.humanTakeover = humanTakeover;
      nextStatus = humanTakeover ? 'human_active' : (meta.autoReplyEnabled ? 'ai_active' : 'open');
      await timelineStorage.recordEvent({
        leadId: conv.leadId,
        type: 'ai_action',
        channel: conv.channel,
        conversationId: conv.id,
        payload: { action: humanTakeover ? 'human_takeover' : 'resume_ai' },
      }, { workspaceId }).catch(() => null);
    }
    if (typeof status === 'string' && status.trim()) {
      nextStatus = String(status).trim();
    }

    await conversationStorage.updateConversation(
      conv.id,
      { status: nextStatus, metadata: meta },
      { workspaceId }
    );

    res.json({
      success: true,
      conversationId: conv.id,
      status: nextStatus,
      settings: {
        autoReplyEnabled: meta.autoReplyEnabled ?? null,
        humanTakeover: Boolean(meta.humanTakeover),
        needsHuman: nextStatus === 'needs_human',
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Convenience: take over (stop AI) / resume AI */
router.post('/conversations/:id/takeover', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conv = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const meta = { ...(conv.metadata || {}), humanTakeover: true };
    await conversationStorage.updateConversation(
      conv.id,
      { status: 'human_active', metadata: meta },
      { workspaceId }
    );
    await timelineStorage.recordEvent({
      leadId: conv.leadId,
      type: 'ai_action',
      channel: conv.channel,
      conversationId: conv.id,
      payload: { action: 'human_takeover' },
    }, { workspaceId }).catch(() => null);
    res.json({
      success: true,
      conversationId: conv.id,
      status: 'human_active',
      settings: { autoReplyEnabled: meta.autoReplyEnabled ?? null, humanTakeover: true },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/conversations/:id/resume-ai', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conv = await conversationStorage.getConversation(req.params.id, { workspaceId });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const meta = {
      ...(conv.metadata || {}),
      humanTakeover: false,
      autoReplyEnabled: true,
    };
    await conversationStorage.updateConversation(
      conv.id,
      { status: 'ai_active', metadata: meta },
      { workspaceId }
    );
    await timelineStorage.recordEvent({
      leadId: conv.leadId,
      type: 'ai_action',
      channel: conv.channel,
      conversationId: conv.id,
      payload: { action: 'resume_ai' },
    }, { workspaceId }).catch(() => null);
    res.json({
      success: true,
      conversationId: conv.id,
      status: 'ai_active',
      settings: { autoReplyEnabled: true, humanTakeover: false },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================================
// Preview & Trust Mode — AI Conversation Simulation
// =====================================================================

/**
 * POST /api/ai/conversations/:id/simulate-reply
 *
 * Simulates an inbound reply from a lead (or from the user testing the preview),
 * then generates an AI reply and sends it back to the conversation.
 *
 * Body:
 *   body: string — the simulated lead message
 */
router.post('/conversations/:id/simulate-reply', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const conversationId = req.params.id;
    const { body } = req.body || {};

    if (!body || !body.trim()) {
      return res.status(400).json({ error: 'Message body is required' });
    }

    // Verify conversation exists in this workspace
    const conv = await conversationStorage.getConversation(conversationId, { workspaceId });
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Add simulated inbound message
    const inboundMsg = await conversationStorage.addMessage(conversationId, {
      direction: 'inbound',
      body: body.trim(),
      channel: conv.channel,
      source: 'preview-simulate',
      metadata: { simulated: true, preview: true },
    }, { workspaceId });

    // Fetch full conversation history for AI context
    const messages = await conversationStorage.getMessages(conversationId, { workspaceId });

    // Build lead/contact object from conversation metadata or lookup
    let lead = null;
    if (isContactConversationId(conv.leadId)) {
      lead = await contactProfileFromConversationId(conv.leadId, workspaceId);
    } else {
      try {
        const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
        lead = leads.find((l) => l.id === conv.leadId) || null;
      } catch {
        // If lead not found (e.g., preview lead), create a mock lead
      }
    }

    if (!lead) {
      // Preview lead fallback
      lead = {
        name: 'Test Lead',
        niche: 'business',
        city: 'Demo City',
      };
    }

    // Resolve OpenAI config
    const oaConfig = await resolveOpenAi(req, res);
    if (!oaConfig) return;

    const userId = req.auth?.userId || workspaceId;
    const user = await userStorage.findById(userId).catch(() => null);
    const agentConfig = mergeAiAgentConfig(await userStorage.getAiAgentConfig(userId), user);

    // Generate AI reply
    const reply = await aiProvider.generateReply(messages, lead, { config: oaConfig, agentConfig, workspaceId });

    // Add AI outbound reply to conversation
    const outboundMsg = await conversationStorage.addMessage(conversationId, {
      direction: 'outbound',
      body: reply.body,
      channel: conv.channel,
      source: 'preview-ai',
      metadata: { aiGenerated: true, preview: true, intent: reply.intent },
    }, { workspaceId });

    res.json({
      success: true,
      inbound: { id: inboundMsg.id, body: inboundMsg.body },
      reply: { id: outboundMsg.id, body: reply.body, intent: reply.intent, model: reply.model },
      conversationId,
    });
  } catch (error) {
    console.error('[AI] simulate-reply error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
