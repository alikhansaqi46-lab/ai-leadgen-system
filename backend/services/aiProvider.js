/**
 * AI provider seam (S5).
 *
 * Selected by AI_MODE (mirrors STORAGE_DRIVER / AUTH_MODE):
 *   - 'heuristic' (default) → deterministic scoring + template generation.
 *                             No API key, no network, free, fully demoable.
 *   - 'openai'              → real LLM via OPENAI_API_KEY (server-side).
 *
 * S5.1 implements qualification. The numeric score is ALWAYS deterministic
 * (services/scoring.js); an LLM may later refine the human-readable reasons,
 * never the score itself.
 */

const axios = require('axios');
const scoring = require('./scoring');
const outreach = require('./outreach');
const reply = require('./reply');
const { buildAiAgentSystemPrompt, mergeAiAgentConfig, hasKnowledgeForTopic, buildMissingKnowledgeReply } = require('../utils/aiAgentConfig');
const { analyzeScript, detectScriptHintLabel, isLikelyLanguageMismatch } = require('../utils/languageDetection');

const MASTER_API_KEY = process.env.OPENAI_API_KEY;
const MASTER_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MASTER_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

function getMode() {
  return (process.env.AI_MODE || 'heuristic').toLowerCase();
}

function hasOpenAI() {
  return Boolean(MASTER_API_KEY);
}

/** Model label recorded on each artifact for transparency/auditing. */
function getModel(config = {}) {
  const mode = getMode();
  if (mode === 'openai') {
    return `openai:${config.model || MASTER_MODEL}`;
  }
  return 'heuristic';
}

async function callOpenAI(messages, temperature = 0.7, maxTokens = 500, config = {}) {
  const apiKey = config.apiKey || MASTER_API_KEY;
  const model = config.model || MASTER_MODEL;
  const baseUrl = config.baseUrl || MASTER_BASE;

  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  try {
    const response = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 30000,
      }
    );
    const usage = response.data?.usage || {};
    if (config.trackUsage !== false) {
      try {
        const aiUsageTracker = require('./aiUsageTracker');
        await aiUsageTracker.recordUsage({
          userId: config.userId || config.workspaceId || null,
          workspaceId: config.workspaceId || config.userId || null,
          source: config.source || 'openai',
          model,
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          meta: { operation: config.operation || 'chat.completions' },
        });
      } catch (_) { /* never block AI on tracking */ }
    }
    const content = response.data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from OpenAI');
    try {
      return JSON.parse(content);
    } catch (e) {
      return { message: content.trim(), action: 'reply', data: {} };
    }
  } catch (err) {
    const { enrichExternalError } = require('../utils/externalApiErrors');
    throw enrichExternalError(err, { operation: 'chat.completions', provider: 'openai_api' });
  }
}

/**
 * Qualify (score) an array of leads.
 * Returns [{ leadId, score, priority, breakdown, model }].
 */
async function qualifyLeads(leads, options = {}, config = {}) {
  const mode = getMode();
  if (mode === 'openai' && config.apiKey) {
    try {
      const campaign = options.campaign || {};
      const leadsJson = leads.map((l) => ({
        id: l.id,
        name: l.name,
        email: l.email,
        phone: l.phone,
        whatsapp: l.whatsapp,
        website: l.website,
        rating: l.rating,
        reviews: l.reviews,
        niche: l.niche || l.category,
        city: l.city,
        country: l.country,
        address: l.address,
        mapsUrl: l.mapsUrl,
      }));

      const systemPrompt = `You are a lead qualification expert. Analyze each lead and assign a score (0-100) with a per-factor breakdown.

Scoring rubric (max 100):
- Contactability (max 30): phone (+15), email (+10), WhatsApp-reachable (+5)
- Web presence (max 15): has website (+15)
- Reputation (max 25): rating scaled to 15, review count log-scaled to 10
- Niche fit (max 20): exact campaign match (+20), high-value niche (+12), any niche (+6)
- Completeness (max 10): address/city (+5), Google Maps link (+5)

Return strict JSON: { scores: [{ leadId: string, score: number (0-100), priority: "hot"|"warm"|"cold", breakdown: { factors: [{ key: string, label: string, points: number, max: number, reasons: [string] }], total: number, max: 100 } }] }`;

      const userPrompt = `Campaign context: ${JSON.stringify(campaign)}

Leads to score: ${JSON.stringify(leadsJson)}

Return the JSON scores array.`;

      const result = await callOpenAI(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        0.5,
        2000,
        config
      );

      const scores = result.scores || result;
      if (!Array.isArray(scores)) {
        throw new Error('OpenAI did not return a scores array');
      }
      return scores.map((s) => ({
        leadId: s.leadId,
        score: clampScore(s.score),
        priority: ['hot', 'warm', 'cold'].includes(s.priority) ? s.priority : priorityForScore(s.score),
        breakdown: s.breakdown || {},
        model: getModel(config),
      }));
    } catch (err) {
      console.error('[aiProvider] OpenAI qualification failed:', err.message);
    }
  }
  // Heuristic fallback
  const model = getModel(config);
  return leads.map((lead) => {
    const { score, priority, breakdown } = scoring.scoreLead(lead, options);
    return { leadId: lead.id, score, priority, breakdown, model };
  });
}

function clampScore(n) {
  if (typeof n !== 'number') return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function priorityForScore(score) {
  if (score >= 70) return 'hot';
  if (score >= 40) return 'warm';
  return 'cold';
}

/**
 * Generate outreach drafts for a single lead.
 * Returns [{ channel, kind, step, waitDays, subject, body, model }].
 */
async function generateOutreach(lead, options = {}, config = {}) {
  const mode = getMode();
  if (mode === 'openai' && config.apiKey) {
    try {
      const systemPrompt = `You are a senior sales copywriter for LeadFlow AI, a lead-generation agency.
Generate 4 personalized outreach drafts for a single business lead.

Rules:
- Use the lead's actual name and business details.
- Reference their niche, location, and any available data (website, rating, reviews).
- Keep emails professional and 4-6 sentences. Keep WhatsApp messages friendly and 2-4 sentences.
- Each draft must have a unique angle (don't repeat the same copy).

Return strict JSON: { drafts: [{ channel: "email"|"whatsapp", kind: "initial"|"followup", step: number, waitDays: number, subject: string|null, body: string }] }`;

      const userPrompt = `Lead: ${JSON.stringify({
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        company: lead.company,
        niche: lead.niche || lead.category,
        city: lead.city,
        country: lead.country,
        website: lead.website,
        rating: lead.rating,
        reviews: lead.reviews,
      })}

Generate exactly these 4 drafts:
1. email initial (step 0, waitDays 0) — first contact email with subject line
2. whatsapp initial (step 0, waitDays 0) — first contact WhatsApp message (no subject)
3. email followup (step 1, waitDays 3) — gentle follow-up email with subject line
4. whatsapp followup (step 2, waitDays 7) — friendly follow-up WhatsApp message (no subject)

Return JSON with the drafts array.`;

      const result = await callOpenAI(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        0.85,
        2000,
        config
      );

      const drafts = result.drafts || result;
      if (!Array.isArray(drafts) || drafts.length === 0) {
        throw new Error('OpenAI did not return a drafts array');
      }
      return drafts.map((d) => ({
        channel: d.channel === 'whatsapp' ? 'whatsapp' : 'email',
        kind: d.kind === 'followup' ? 'followup' : 'initial',
        step: typeof d.step === 'number' ? d.step : 0,
        waitDays: typeof d.waitDays === 'number' ? d.waitDays : 0,
        subject: d.subject || null,
        body: String(d.body || '').trim(),
        model: getModel(config),
      }));
    } catch (err) {
      console.error('[aiProvider] OpenAI outreach generation failed:', err.message);
    }
  }
  // Heuristic fallback
  const model = getModel(config);
  return outreach.generateOutreach(lead, options).map((draft) => ({ ...draft, model }));
}

/**
 * Generate a context-aware reply for a conversation.
 * Returns { body, intent, model, context }.
 */
async function generateReply(messages, lead, options = {}) {
  const mode = getMode();
  const config = options.config || {};
  const agentConfig = mergeAiAgentConfig(options.agentConfig || {}, null, { skipAutoFill: true });
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
  const inboundBodyRaw = String(lastInbound?.body || '');
  const inboundText = inboundBodyRaw.toLowerCase();
  const customerScriptHint = detectScriptHintLabel(inboundBodyRaw);
  const customerScriptFamily = analyzeScript(inboundBodyRaw).dominantScript || 'latin';

  const asksPricing = /price|cost|how much|pricing|quote/.test(inboundText);
  const asksOffers = /discount|promo|offer|deal|sale/.test(inboundText);
  const asksPolicies = /ship|delivery|return|refund|policy|warranty/.test(inboundText);
  const asksProducts = /product|service|feature|what do you (do|offer|sell)/.test(inboundText);

  // English-keyword heuristic used only to label intent / drive the
  // last-resort fallback below — it must NEVER bypass the AI call, since
  // that bypass previously caused English-only, poorly-worded canned
  // replies even when OpenAI (which can defer professionally, in the
  // customer's own language) was available.
  const missingTopic =
    (asksPricing && !hasKnowledgeForTopic(agentConfig, 'pricing')) ? 'pricing'
    : (asksOffers && !hasKnowledgeForTopic(agentConfig, 'offers')) ? 'offers'
    : (asksPolicies && !hasKnowledgeForTopic(agentConfig, 'policies')) ? 'policies'
    : (asksProducts && !hasKnowledgeForTopic(agentConfig, 'info')) ? 'info'
    : null;

  if (mode === 'openai' && config.apiKey) {
    const businessPrompt = buildAiAgentSystemPrompt(agentConfig, { customerScriptHint });
    const systemPrompt = `${businessPrompt}

You are replying to a client message in an ongoing sales conversation.
Respond in a friendly, professional tone unless the business profile specifies otherwise.`;

    const userPrompt = `Lead/Contact: ${lead?.name || 'Unknown'} (${lead?.niche || lead?.company || 'business'}${lead?.city ? ` in ${lead.city}` : ''})
Conversation history:
${messages.map((m) => `${m.direction === 'inbound' ? 'Client' : 'Agent'}: ${m.body}`).join('\n')}

Generate the next reply as the business sales agent.`;

    try {
      let result = await callOpenAI(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        0.8,
        260,
        config
      );
      let body = String(result.body || result.message || '').trim();
      let requiresHuman = Boolean(result.requiresHuman);

      // Self-correction: the customer wrote in a clearly non-Latin script but
      // the reply came back in a different script family — retry once with
      // an explicit corrective directive rather than silently sending the
      // wrong language.
      if (body && isLikelyLanguageMismatch(inboundBodyRaw, body)) {
        console.warn('[aiProvider] AI reply language mismatch detected — retrying with corrective directive', {
          customerScriptHint,
        });
        try {
          const correctionPrompt = `${systemPrompt}

IMPORTANT CORRECTION: Your previous reply was not written in the same language as the customer's message. The customer's message is written in ${customerScriptHint || 'a language other than English'}. Rewrite your ENTIRE reply in that exact language — do not use English, and do not explain the correction.`;
          const retryResult = await callOpenAI(
            [
              { role: 'system', content: correctionPrompt },
              { role: 'user', content: userPrompt },
            ],
            0.5,
            260,
            config
          );
          const retryBody = String(retryResult.body || retryResult.message || '').trim();
          if (retryBody) {
            body = retryBody;
            requiresHuman = Boolean(retryResult.requiresHuman) || requiresHuman;
            result = retryResult;
          }
        } catch (retryErr) {
          console.error('[aiProvider] Language-correction retry failed:', retryErr.message);
        }
      }

      if (!body) {
        // Defensive fallback only — normally unreachable since the model
        // always returns a body. Never default to a hardcoded English string.
        body = buildMissingKnowledgeReply(missingTopic || 'info', agentConfig, { scriptFamily: customerScriptFamily });
        requiresHuman = true;
      }

      return {
        body,
        intent: result.intent || missingTopic || 'general',
        context: result.context || '',
        requiresHuman,
        model: getModel(config),
      };
    } catch (err) {
      console.error('[aiProvider] OpenAI reply failed:', err.message);
      // Falls through to the safe, language-aware fallback below.
    }
  }

  // No OpenAI configured, or the OpenAI call failed: never invent facts, but
  // always respond with a professional, best-effort-localized deferral —
  // never a hardcoded "I don't know" style message.
  if (missingTopic) {
    return {
      body: buildMissingKnowledgeReply(missingTopic, agentConfig, { scriptFamily: customerScriptFamily }),
      intent: missingTopic,
      requiresHuman: true,
      model: 'knowledge-guard',
      context: { knowledgeGuard: true },
    };
  }
  const result = reply.generateReply(messages, lead, { ...options, agentConfig });
  return { ...result, model: mode === 'openai' ? 'heuristic(openai-fallback)' : 'heuristic' };
}

/**
 * Autonomous AI Decision Engine.
 * Analyzes a client request and decides what action to take.
 * Returns { action: 'scrape|send|build|reply', message: string, data: object }.
 */
async function autonomousDecision(input, config = {}) {
  const mode = getMode();
  if (mode === 'openai' && config.apiKey) {
    try {
      const systemPrompt = `You are LeadFlow AI, an autonomous business assistant that can:
- scrape: Find business leads from Google Maps (requires niche and location)
- send: Send WhatsApp/Email/SMS messages to leads (requires leads and a message)
- build: Build a website or landing page (requires description of what to build)
- reply: Respond to a general inquiry or question

When given a client request, analyze it and return a JSON object with:
{
  "action": "scrape|send|build|reply",
  "message": "A friendly response to the client explaining what you'll do",
  "data": {
    // action-specific parameters:
    // For scrape: { niche, location, limit }
    // For send: { channel, message, leadIds }
    // For build: { description, type }
    // For reply: {}
  }
}`;

      const userPrompt = `Client request: "${input.message || input}"
${input.lead ? `Lead context: ${JSON.stringify(input.lead)}` : ''}
${input.conversation ? `Conversation history: ${JSON.stringify(input.conversation)}` : ''}

Analyze the request and return the JSON decision.`;

      const result = await callOpenAI(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        0.6,
        400,
        config
      );
      return {
        action: result.action || 'reply',
        message: result.message || 'I received your request and will get back to you shortly.',
        data: result.data || {},
        model: getModel(config),
      };
    } catch (err) {
      console.error('[aiProvider] OpenAI autonomous decision failed:', err.message);
    }
  }
  // Heuristic fallback
  const msg = String(input.message || input).toLowerCase();
  let action = 'reply';
  let data = {};
  if (msg.includes('scrape') || msg.includes('find leads') || msg.includes('get leads')) {
    action = 'scrape';
    const nicheMatch = msg.match(/(?:scrape|find)\s+(\w+\s*(?:in|at)?)/i);
    const locMatch = msg.match(/(?:in|at|near)\s+([a-z\s]+)/i);
    data = { niche: nicheMatch ? nicheMatch[1].trim() : 'business', location: locMatch ? locMatch[1].trim() : 'local', limit: 50 };
  } else if (msg.includes('send') || msg.includes('message') || msg.includes('campaign')) {
    action = 'send';
    data = { channel: 'whatsapp', message: 'Follow-up message' };
  } else if (msg.includes('build') || msg.includes('website') || msg.includes('landing page')) {
    action = 'build';
    data = { description: input.message || 'Business landing page', type: 'landing_page' };
  }
  return {
    action,
    message: `I'll help you with that. I've identified the next step as "${action}" and will proceed accordingly.`,
    data,
    model: 'heuristic',
  };
}

module.exports = { getMode, getModel, hasOpenAI, callOpenAI, qualifyLeads, generateOutreach, generateReply, autonomousDecision };
