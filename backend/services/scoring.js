/**
 * Deterministic lead qualification scoring (S5.1).
 *
 * Pure, side-effect-free functions. Produces a 0..100 score, a priority bucket
 * (hot/warm/cold), and an explainable per-factor breakdown. Reproducible and
 * free — no LLM required. AI_MODE=openai may later refine the reasons, but the
 * numeric score always comes from these rules (no hallucinated numbers).
 *
 * Rubric (max points):
 *   Contactability 30 · Web presence 15 · Reputation 25 · Niche fit 20 · Completeness 10
 */

const PRIORITY_THRESHOLDS = { hot: 70, warm: 40 }; // hot >=70, warm 40-69, cold <40

// A small default set of generally high-intent local-service niches.
const DEFAULT_HIGH_VALUE_NICHES = [
  'dentist', 'dental', 'lawyer', 'attorney', 'law', 'plumber', 'plumbing',
  'roofing', 'roofer', 'hvac', 'electrician', 'spa', 'salon', 'clinic',
  'real estate', 'realtor', 'gym', 'fitness', 'accountant', 'contractor',
];

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const n = parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function digitsOf(value) {
  return String(value || '').replace(/\D/g, '');
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function priorityFor(score) {
  if (score >= PRIORITY_THRESHOLDS.hot) return 'hot';
  if (score >= PRIORITY_THRESHOLDS.warm) return 'warm';
  return 'cold';
}

function scoreContactability(lead) {
  let pts = 0;
  const reasons = [];
  const phoneDigits = digitsOf(lead.phone);
  const hasPhone = phoneDigits.length >= 7 && (lead.phone || '').toUpperCase() !== 'N/A';
  const email = (lead.email || '').trim();
  const hasEmail = /.+@.+\..+/.test(email) && email.toUpperCase() !== 'N/A';
  const hasWhatsapp = digitsOf(lead.whatsapp).length >= 7 || hasPhone;

  if (hasPhone) { pts += 15; reasons.push('phone present (+15)'); }
  else { reasons.push('no phone (0)'); }
  if (hasEmail) { pts += 10; reasons.push('email present (+10)'); }
  else { reasons.push('no email (0)'); }
  if (hasWhatsapp) { pts += 5; reasons.push('WhatsApp-reachable (+5)'); }

  return { key: 'contactability', label: 'Contactability', points: pts, max: 30, reasons };
}

function scoreWebPresence(lead) {
  const website = (lead.website || '').trim();
  const hasWebsite = website && website.toUpperCase() !== 'N/A';
  return {
    key: 'web_presence',
    label: 'Web presence',
    points: hasWebsite ? 15 : 0,
    max: 15,
    reasons: [hasWebsite ? 'has website (+15)' : 'no website (0)'],
  };
}

function scoreReputation(lead) {
  const rating = toNumber(lead.rating); // 0..5
  const reviews = toNumber(lead.reviews); // count
  const reasons = [];
  let pts = 0;

  if (rating !== null) {
    const ratingPts = clamp((rating / 5) * 15, 0, 15);
    pts += ratingPts;
    reasons.push(`rating ${rating}/5 (+${ratingPts.toFixed(0)})`);
  } else {
    reasons.push('no rating (0)');
  }

  if (reviews !== null && reviews > 0) {
    // log10 scaling: ~10 reviews -> +5, ~100 -> +10 (capped).
    const reviewPts = clamp(Math.log10(reviews + 1) * 5, 0, 10);
    pts += reviewPts;
    reasons.push(`${reviews} reviews (+${reviewPts.toFixed(0)})`);
  } else {
    reasons.push('no reviews (0)');
  }

  return { key: 'reputation', label: 'Reputation', points: Math.round(pts), max: 25, reasons };
}

function scoreNicheFit(lead, campaign = {}) {
  const niche = (lead.niche || lead.category || '').toLowerCase().trim();
  const target = (campaign.targetNiche || campaign.targetAudience || campaign.target || '')
    .toLowerCase()
    .trim();
  const reasons = [];
  let pts = 0;

  if (!niche) {
    reasons.push('no niche (0)');
  } else if (target && (niche.includes(target) || target.includes(niche))) {
    pts = 20;
    reasons.push(`matches campaign target "${target}" (+20)`);
  } else if (DEFAULT_HIGH_VALUE_NICHES.some((n) => niche.includes(n))) {
    pts = 12;
    reasons.push(`high-value niche "${niche}" (+12)`);
  } else {
    pts = 6;
    reasons.push(`niche present "${niche}" (+6)`);
  }

  return { key: 'niche_fit', label: 'Niche fit', points: pts, max: 20, reasons };
}

function scoreCompleteness(lead) {
  let pts = 0;
  const reasons = [];
  const hasLocation = Boolean((lead.address || '').trim() || (lead.city || '').trim());
  const hasMaps = Boolean((lead.mapsUrl || '').trim());
  if (hasLocation) { pts += 5; reasons.push('address/city present (+5)'); }
  if (hasMaps) { pts += 5; reasons.push('Google Maps link (+5)'); }
  if (pts === 0) reasons.push('sparse profile (0)');
  return { key: 'completeness', label: 'Completeness', points: pts, max: 10, reasons };
}

/**
 * Score a single lead. Returns { score, priority, breakdown }.
 */
function scoreLead(lead, options = {}) {
  const campaign = options.campaign || {};
  const factors = [
    scoreContactability(lead),
    scoreWebPresence(lead),
    scoreReputation(lead),
    scoreNicheFit(lead, campaign),
    scoreCompleteness(lead),
  ];
  const raw = factors.reduce((sum, f) => sum + f.points, 0);
  const score = clamp(Math.round(raw), 0, 100);
  return {
    score,
    priority: priorityFor(score),
    breakdown: { factors, total: score, max: 100 },
  };
}

module.exports = { scoreLead, priorityFor, PRIORITY_THRESHOLDS, DEFAULT_HIGH_VALUE_NICHES };
