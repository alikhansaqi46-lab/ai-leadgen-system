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
 * All routes are mounted behind requireAuth in server.js and are workspace-scoped.
 */

const express = require('express');
const router = express.Router();
const leadStorage = require('../utils/leadStorage');
const scoreStorage = require('../utils/scoreStorage');
const draftStorage = require('../utils/draftStorage');
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

module.exports = router;
