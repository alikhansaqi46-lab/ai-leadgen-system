/**
 * AI Sales Agent routes (S5).
 *
 * S5.1 — Qualification:
 *   POST /api/ai/qualify  { leadIds?, campaign? }  → score leads, persist, return ranked
 *   GET  /api/ai/scores                            → stored scores (joined with leads), ranked
 *
 * All routes are mounted behind requireAuth in server.js and are workspace-scoped.
 */

const express = require('express');
const router = express.Router();
const leadStorage = require('../utils/leadStorage');
const scoreStorage = require('../utils/scoreStorage');
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

module.exports = router;
