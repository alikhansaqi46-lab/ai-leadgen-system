/**
 * Start Campaign Orchestrator — one-click autonomous selling.
 *
 * POST /api/campaign/start
 * Required body: { businessType, location, goal }
 * Optional: name, country, language, channels, autoSend, limit
 *
 * Pipeline:
 *  1. Scrape → 2. CRM → 3. Email discovery → 4. Qualify
 *  5. Automations (score_hot) → 6. Follow-ups → 7. Outreach drafts
 *  8. Optional gated auto-send via automations / unifiedSend
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const leadStorage = require('../utils/leadStorage');
const scoreStorage = require('../utils/scoreStorage');
const campaignStorage = require('../utils/campaignStorage');
const timelineStorage = require('../utils/timelineStorage');
const draftStorage = require('../utils/draftStorage');
const userStorage = require('../utils/userStorage');
const aiProvider = require('../services/aiProvider');
const openAiKeyService = require('../services/openAiKeyService');
const { dispatchEvent } = require('../services/automationEngine');
const { extractEmailsForLeads } = require('../utils/emailExtractor');

const { workspaceOf } = require('../utils/workspaceContext');

/** Infer country/language hints from free-text location (no invented leads). */
function inferLocationMeta(location, country, language) {
  const loc = String(location || '').toLowerCase();
  let inferredCountry = country || null;
  let inferredLanguage = language || 'English';
  const map = [
    { re: /malaysia|kuala lumpur|selangor|penang|johor|sabah|sarawak/, country: 'Malaysia', language: 'English' },
    { re: /singapore/, country: 'Singapore', language: 'English' },
    { re: /indonesia|jakarta|bali|surabaya/, country: 'Indonesia', language: 'Indonesian' },
    { re: /thailand|bangkok|phuket/, country: 'Thailand', language: 'Thai' },
    { re: /philippines|manila|cebu/, country: 'Philippines', language: 'English' },
    { re: /uae|dubai|abu dhabi/, country: 'United Arab Emirates', language: 'English' },
    { re: /saudi|riyadh|jeddah/, country: 'Saudi Arabia', language: 'Arabic' },
    { re: /united states|usa|new york|california|texas/, country: 'United States', language: 'English' },
    { re: /united kingdom|london|manchester|uk\b/, country: 'United Kingdom', language: 'English' },
    { re: /australia|sydney|melbourne/, country: 'Australia', language: 'English' },
    { re: /india|mumbai|delhi|bangalore/, country: 'India', language: 'English' },
  ];
  for (const row of map) {
    if (row.re.test(loc)) {
      if (!inferredCountry) inferredCountry = row.country;
      if (!language) inferredLanguage = row.language;
      break;
    }
  }
  return { country: inferredCountry, language: inferredLanguage };
}

async function scrapeViaSerpApi({ keyword, location, apiKey, limit = 20 }) {
  const params = {
    engine: 'google_maps',
    q: `${keyword} in ${location}`,
    type: 'search',
    api_key: apiKey,
    hl: 'en',
  };
  const { data } = await axios.get('https://serpapi.com/search.json', { params, timeout: 60000 });
  const results = Array.isArray(data.local_results) ? data.local_results : [];
  return results.slice(0, limit).map((r) => ({
    name: r.title || r.name || 'Unknown',
    phone: r.phone || null,
    whatsapp: r.phone || null,
    email: null,
    address: r.address || null,
    city: location,
    country: null,
    niche: keyword,
    rating: r.rating || null,
    reviews: r.reviews || null,
    mapsUrl: r.link || null,
    website: r.website || null,
    source: 'campaign_orchestrator',
  }));
}

/**
 * Mounted at /api/campaign — add route before other :id routes if needed.
 * Exported and attached from campaign.js or server.
 */
router.post('/start', async (req, res) => {
  const workspaceId = workspaceOf(req);
  const userId = (req.auth && req.auth.userId) || workspaceId;
  const report = {
    campaign: null,
    steps: [],
    leadsScraped: 0,
    leadsSaved: 0,
    emailsDiscovered: 0,
    qualified: 0,
    hot: 0,
    followUpsScheduled: 0,
    draftsGenerated: 0,
    automationsFired: 0,
    errors: [],
  };

  try {
    const {
      name,
      businessType,
      location,
      country: countryIn,
      language: languageIn,
      goal,
      channels = ['whatsapp', 'email'],
      autoSend = false,
      limit = 20,
    } = req.body || {};

    if (!businessType || !location || !goal) {
      return res.status(400).json({
        error: 'businessType, location, and goal are required',
        example: {
          businessType: 'Dental Clinic',
          location: 'Kuala Lumpur',
          goal: 'Book Appointments',
        },
      });
    }

    const inferred = inferLocationMeta(location, countryIn, languageIn);
    const country = inferred.country;
    const language = inferred.language;
    const campaignName = name || `${businessType} · ${location}`;
    report.campaign = {
      name: campaignName,
      businessType,
      location,
      country,
      language,
      goal,
      channels,
      autoSend: !!autoSend,
    };

    // Step 1: Scrape
    report.steps.push({ step: 'scrape', status: 'running' });
    const serpKey = await userStorage.getSerpApiKey(userId).catch(() => null)
      || process.env.SERPAPI_KEY
      || null;
    if (!serpKey) {
      report.steps[report.steps.length - 1] = { step: 'scrape', status: 'failed', error: 'SERPAPI_KEY not configured' };
      return res.status(503).json({
        success: false,
        error: 'Scraping unavailable — configure SerpAPI key in Settings',
        report,
      });
    }

    let scraped = [];
    try {
      scraped = await scrapeViaSerpApi({
        keyword: businessType,
        location,
        apiKey: serpKey,
        limit: Math.min(parseInt(limit, 10) || 20, 50),
      });
      report.leadsScraped = scraped.length;
      report.steps[report.steps.length - 1] = { step: 'scrape', status: 'succeeded', count: scraped.length };
    } catch (err) {
      report.steps[report.steps.length - 1] = { step: 'scrape', status: 'failed', error: err.message };
      report.errors.push(err.message);
      return res.status(502).json({ success: false, error: 'Scrape failed', report });
    }

    // Step 2: Save leads
    report.steps.push({ step: 'crm_create', status: 'running' });
    const enriched = scraped.map((l) => ({
      ...l,
      country: country || l.country || null,
      niche: businessType,
      campaignName,
      language,
      goal,
    }));
    const saved = await leadStorage.addLeads(enriched, { workspaceId });
    report.leadsSaved = saved.length;
    report.steps[report.steps.length - 1] = { step: 'crm_create', status: 'succeeded', count: saved.length };

    for (const lead of saved.slice(0, 50)) {
      try {
        await timelineStorage.recordEvent({
          leadId: lead.id,
          type: 'lead_created',
          payload: { source: 'campaign_orchestrator', campaignName },
        }, { workspaceId });
      } catch (_) { /* non-fatal */ }
      dispatchEvent('lead_created', {
        leadId: lead.id,
        workspaceId,
        niche: businessType,
        country: country || null,
      }, { workspaceId }).catch(() => {});
    }

    // Step 2b: Email discovery from websites (real scrape — no invented emails)
    report.steps.push({ step: 'email_discovery', status: 'running' });
    report.emailsDiscovered = 0;
    try {
      const needsEmail = saved.filter((l) => {
        const hasSite = l.website && l.website !== 'N/A';
        const missing = !l.email || l.email === 'N/A';
        return hasSite && missing;
      }).slice(0, 15);
      if (needsEmail.length) {
        const discovered = await extractEmailsForLeads(needsEmail, 3);
        for (const lead of discovered) {
          if (!lead?.id || !lead.email || lead.email === 'N/A') continue;
          try {
            await leadStorage.updateLead(lead.id, { email: lead.email }, { workspaceId });
            report.emailsDiscovered += 1;
          } catch (err) {
            report.errors.push(`email_update ${lead.id}: ${err.message}`);
          }
        }
        // Refresh saved list emails for qualify / later steps
        const refreshed = await leadStorage.getLeads({ workspaceId, limit: 10000 }).catch(() => []);
        const byId = new Map((refreshed || []).map((l) => [l.id, l]));
        for (let i = 0; i < saved.length; i++) {
          const fresh = byId.get(saved[i].id);
          if (fresh?.email) saved[i] = { ...saved[i], email: fresh.email };
        }
      }
      report.steps[report.steps.length - 1] = {
        step: 'email_discovery',
        status: 'succeeded',
        attempted: needsEmail.length,
        found: report.emailsDiscovered,
      };
    } catch (err) {
      report.steps[report.steps.length - 1] = { step: 'email_discovery', status: 'failed', error: err.message };
      report.errors.push(`email_discovery: ${err.message}`);
    }

    // Step 3: Qualify
    report.steps.push({ step: 'qualify', status: 'running' });
    const oaConfig = await openAiKeyService.getOpenAiConfig(userId);
    const scored = await aiProvider.qualifyLeads(
      saved,
      { campaign: { name: campaignName, goal, language, niche: businessType, location } },
      oaConfig.blocked ? {} : oaConfig
    );
    await scoreStorage.upsertScores(scored, { workspaceId });
    if (!oaConfig.blocked) {
      await openAiKeyService.consumeFreeMessage(userId, oaConfig.source);
    }
    const hot = scored.filter((s) => String(s.priority).toLowerCase() === 'hot');
    report.qualified = scored.length;
    report.hot = hot.length;
    report.steps[report.steps.length - 1] = {
      step: 'qualify',
      status: 'succeeded',
      qualified: scored.length,
      hot: hot.length,
    };

    for (const s of hot.slice(0, 50)) {
      dispatchEvent('score_hot', {
        leadId: s.leadId,
        workspaceId,
        score: s.score,
        priority: s.priority,
        userId,
      }, { workspaceId }).catch(() => {});
      report.automationsFired += 1;
    }

    // Step 4: Schedule follow-ups for hot leads (no auto-blast unless explicitly requested later)
    report.steps.push({ step: 'schedule_followups', status: 'running' });
    let scheduled = 0;
    for (const s of hot) {
      try {
        await campaignStorage.scheduleFollowUps(s.leadId, { days1: 2, days2: 5 }, { workspaceId });
        scheduled += 1;
      } catch (err) {
        report.errors.push(`followup ${s.leadId}: ${err.message}`);
      }
    }
    report.followUpsScheduled = scheduled;
    report.steps[report.steps.length - 1] = { step: 'schedule_followups', status: 'succeeded', count: scheduled };

    // Step 5: Generate outreach drafts for hot leads (approve/send gate unless autoSend)
    report.steps.push({ step: 'outreach_drafts', status: 'running' });
    let drafts = 0;
    const hotLeads = hot
      .map((s) => saved.find((l) => l.id === s.leadId))
      .filter(Boolean)
      .slice(0, 15);
    for (const lead of hotLeads) {
      try {
        const templates = await aiProvider.generateOutreach(
          lead,
          {
            goal,
            language,
            niche: businessType,
            location,
            channels,
            campaignName,
          },
          oaConfig.blocked ? {} : oaConfig
        );
        const rows = await draftStorage.replaceDraftsForLead(lead.id, templates, { workspaceId });
        drafts += rows.length;
        await timelineStorage.recordEvent({
          leadId: lead.id,
          type: 'ai_action',
          payload: {
            action: 'outreach_drafts_generated',
            count: rows.length,
            goal,
            campaignName,
          },
        }, { workspaceId }).catch(() => null);
      } catch (err) {
        report.errors.push(`drafts ${lead.id}: ${err.message}`);
      }
    }
    if (!oaConfig.blocked && hotLeads.length) {
      await openAiKeyService.consumeFreeMessage(userId, oaConfig.source).catch(() => null);
    }
    report.draftsGenerated = drafts;
    report.steps[report.steps.length - 1] = {
      step: 'outreach_drafts',
      status: 'succeeded',
      count: drafts,
      leads: hotLeads.length,
    };

    // Step 6: CRM pipeline — ensure campaign rows exist for hot leads
    report.steps.push({ step: 'crm_pipeline', status: 'running' });
    let pipelineReady = 0;
    for (const s of hot) {
      try {
        await campaignStorage.getOrCreate({ leadId: s.leadId, workspaceId });
        pipelineReady += 1;
      } catch (err) {
        report.errors.push(`pipeline ${s.leadId}: ${err.message}`);
      }
    }
    report.steps[report.steps.length - 1] = {
      step: 'crm_pipeline',
      status: 'succeeded',
      count: pipelineReady,
    };

    // Step 7: Auto-send remains gated — fires score_hot automations already; explicit note
    report.steps.push({
      step: 'outreach_send',
      status: autoSend ? 'delegated_to_automations' : 'awaiting_approval',
      note: autoSend
        ? 'autoSend=true: install/enable send_* automations on score_hot for live sends'
        : 'Drafts ready in AI Agent. Enable Automations or approve drafts to send. Meeting/deal/handover continue via CRM + automations.',
      channels,
      nextHumanOrAuto: [
        'Conversation replies → reply_received automations',
        'Mark meeting / deal on Leads → handover package on deal',
      ],
    });

    res.json({
      success: true,
      message: `Campaign "${campaignName}" started: ${report.leadsSaved} leads, ${report.hot} hot, ${report.draftsGenerated} drafts`,
      report,
    });
  } catch (err) {
    console.error('[CampaignOrchestrator] error:', err.message);
    report.errors.push(err.message);
    res.status(500).json({ success: false, error: err.message, report });
  }
});

module.exports = router;
