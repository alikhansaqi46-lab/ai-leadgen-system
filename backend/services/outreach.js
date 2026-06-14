/**
 * Deterministic outreach generation (S5.2).
 *
 * Pure, side-effect-free template engine. Produces personalized cold outreach
 * for a lead across channels (email + WhatsApp) plus a short follow-up sequence.
 * Reproducible and free — no LLM required. AI_MODE=openai may later rewrite the
 * copy, but the structure/personalization here is the deterministic baseline.
 *
 * A single call returns an array of "draft" message objects, one per touch:
 *   [{ channel, kind, step, waitDays, subject, body }]
 */

// First name (best-effort) from a business/contact name.
function firstName(name) {
  const n = String(name || '').trim();
  if (!n) return 'there';
  return n.split(/\s+/)[0];
}

function nicheLabel(lead) {
  const n = String(lead.niche || lead.category || '').trim().toLowerCase();
  return n || 'business';
}

function locationLabel(lead) {
  const city = String(lead.city || '').trim();
  const country = String(lead.country || '').trim();
  if (city && country) return `${city}, ${country}`;
  return city || country || 'your area';
}

// A relevant value hook by niche — kept generic and honest (no fake claims).
function valueHook(lead) {
  const niche = nicheLabel(lead);
  return `more ${niche} customers from online searches`;
}

// A gap-aware opener: reference something concrete from the lead's profile.
function observation(lead) {
  const hasWebsite = (lead.website || '').trim() && (lead.website || '').toUpperCase() !== 'N/A';
  const reviews = parseInt(String(lead.reviews || '').replace(/[^0-9]/g, ''), 10);
  if (!hasWebsite) {
    return `I noticed ${lead.name || 'your business'} doesn't have a website listed yet`;
  }
  if (Number.isFinite(reviews) && reviews > 0 && reviews < 25) {
    return `I came across ${lead.name || 'your business'} and saw you're building up your reviews`;
  }
  return `I came across ${lead.name || 'your business'} while looking at ${nicheLabel(lead)}s in ${locationLabel(lead)}`;
}

function emailInitial(lead) {
  const hi = firstName(lead.name);
  return {
    channel: 'email',
    kind: 'initial',
    step: 0,
    waitDays: 0,
    subject: `Quick idea for ${lead.name || 'your business'}`,
    body:
      `Hi ${hi},\n\n` +
      `${observation(lead)}. I help ${nicheLabel(lead)}s in ${locationLabel(lead)} get ${valueHook(lead)}.\n\n` +
      `Would you be open to a quick 10-minute chat this week to see if it's a fit? ` +
      `Happy to share a couple of concrete ideas either way.\n\n` +
      `Best,\nThe LeadFlow Team`,
  };
}

function whatsappInitial(lead) {
  const hi = firstName(lead.name);
  return {
    channel: 'whatsapp',
    kind: 'initial',
    step: 0,
    waitDays: 0,
    subject: null,
    body:
      `Hi ${hi}! 👋 ${observation(lead)}. ` +
      `We help ${nicheLabel(lead)}s in ${locationLabel(lead)} get ${valueHook(lead)}. ` +
      `Open to a quick chat this week?`,
  };
}

function emailFollowup(lead) {
  const hi = firstName(lead.name);
  return {
    channel: 'email',
    kind: 'followup',
    step: 1,
    waitDays: 3,
    subject: `Re: Quick idea for ${lead.name || 'your business'}`,
    body:
      `Hi ${hi},\n\n` +
      `Just floating this back to the top of your inbox. ` +
      `I'd love to show you how other ${nicheLabel(lead)}s in ${locationLabel(lead)} are getting ${valueHook(lead)}.\n\n` +
      `Worth a quick look? Reply and I'll send over a short example.\n\n` +
      `Best,\nThe LeadFlow Team`,
  };
}

function whatsappFollowup(lead) {
  const hi = firstName(lead.name);
  return {
    channel: 'whatsapp',
    kind: 'followup',
    step: 2,
    waitDays: 7,
    subject: null,
    body:
      `Hi ${hi}, following up on my note 🙂 ` +
      `No worries if now's not the right time — happy to share a quick idea for ${lead.name || 'your business'} whenever you are.`,
  };
}

/**
 * Generate the full outreach set for a lead.
 * Returns an array of draft message templates (channel/kind/step/subject/body).
 */
function generateOutreach(lead /* , options = {} */) {
  return [
    emailInitial(lead),
    whatsappInitial(lead),
    emailFollowup(lead),
    whatsappFollowup(lead),
  ];
}

module.exports = { generateOutreach };
