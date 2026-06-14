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
const scoreStorage = require('../utils/scoreStorage');
const draftStorage = require('../utils/draftStorage');
const conversationStorage = require('../utils/conversationStorage');
const aiProvider = require('../services/aiProvider');

function workspaceOf(req) {
  return (req.auth && req.auth.workspaceId) || undefined;
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
    const { leadIds, campaign } = req.body || {};

    let leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
    if (Array.isArray(leadIds) && leadIds.length > 0) {
      const wanted = new Set(leadIds);
      leads = leads.filter((l) => wanted.has(l.id));
    }

    if (leads.length === 0) {
      return res.json({ scores: [], count: 0, model: aiProvider.getModel() });
    }

    const computed = aiProvider.qualifyLeads(leads, { campaign: campaign || {} });
    await scoreStorage.upsertScores(computed, { workspaceId });

    const allScores = await scoreStorage.getScores({ workspaceId });
    const ranked = rank(leads, allScores);

    res.json({ scores: ranked, count: ranked.length, model: aiProvider.getModel() });
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
    res.json({ scores: ranked, count: ranked.length, mode: aiProvider.getMode() });
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
    const { leadId } = req.body || {};
    if (!leadId) {
      return res.status(400).json({ error: 'leadId is required' });
    }

    const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
    const lead = leads.find((l) => l.id === leadId);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found in this workspace' });
    }

    const templates = aiProvider.generateOutreach(lead, {});
    const drafts = await draftStorage.replaceDraftsForLead(leadId, templates, { workspaceId });

    res.json({ leadId, drafts, count: drafts.length, model: aiProvider.getModel() });
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
    const enriched = await Promise.all(
      conversations.map(async (c) => {
        const messages = await conversationStorage.getMessages(c.id, { workspaceId });
        const last = messages[messages.length - 1] || null;
        return {
          ...c,
          lead: leadById.get(c.leadId) || null,
          messageCount: messages.length,
          lastMessage: last ? { body: last.body, direction: last.direction, createdAt: last.createdAt } : null,
        };
      })
    );
    res.json({ conversations: enriched, count: enriched.length });
  } catch (error) {
    console.error('[AI] conversations error:', error);
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
    const messages = await conversationStorage.getMessages(req.params.id, { workspaceId });
    res.json({ conversation, messages, count: messages.length });
  } catch (error) {
    console.error('[AI] messages error:', error);
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

module.exports = router;
