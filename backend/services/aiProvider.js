/**
 * AI provider seam (S5).
 *
 * Selected by AI_MODE (mirrors STORAGE_DRIVER / AUTH_MODE):
 *   - 'heuristic' (default) → deterministic scoring + template generation.
 *                             No API key, no network, free, fully demoable.
 *   - 'openai'              → real LLM via OPENAI_API_KEY (server-side).
 *                             Reserved for a later PR; not wired yet.
 *
 * S5.1 implements qualification. The numeric score is ALWAYS deterministic
 * (services/scoring.js); an LLM may later refine the human-readable reasons,
 * never the score itself.
 */

const scoring = require('./scoring');

function getMode() {
  return (process.env.AI_MODE || 'heuristic').toLowerCase();
}

/** Model label recorded on each artifact for transparency/auditing. */
function getModel() {
  const mode = getMode();
  if (mode === 'openai') {
    return `openai:${process.env.OPENAI_MODEL || 'gpt-4o-mini'}`;
  }
  return 'heuristic';
}

/**
 * Qualify (score) an array of leads.
 * Returns [{ leadId, score, priority, breakdown, model }].
 */
function qualifyLeads(leads, options = {}) {
  const mode = getMode();
  // openai mode is reserved; until it's wired, fall back to the deterministic
  // engine so behavior is identical and nothing breaks if the flag is flipped.
  if (mode === 'openai') {
    console.warn('[aiProvider] AI_MODE=openai not yet implemented for qualification — using heuristic scoring.');
  }
  const model = mode === 'openai' ? 'heuristic(openai-fallback)' : 'heuristic';
  return leads.map((lead) => {
    const { score, priority, breakdown } = scoring.scoreLead(lead, options);
    return { leadId: lead.id, score, priority, breakdown, model };
  });
}

module.exports = { getMode, getModel, qualifyLeads };
