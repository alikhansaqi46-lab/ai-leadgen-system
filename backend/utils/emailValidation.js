/**
 * Email address parsing and validation for outbound delivery.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmailAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const angle = raw.match(/<([^>]+@[^>]+)>/);
  if (angle) return angle[1].trim().toLowerCase();
  return raw.toLowerCase();
}

function isValidEmail(value) {
  const parsed = parseEmailAddress(value);
  return Boolean(parsed && EMAIL_RE.test(parsed));
}

function resolveDeliveryEmail(input = {}) {
  const candidates = [
    input.emailNormalized,
    input.email_normalized,
    input.email,
  ];
  for (const candidate of candidates) {
    const parsed = parseEmailAddress(candidate);
    if (isValidEmail(parsed)) return parsed;
  }
  return '';
}

module.exports = {
  EMAIL_RE,
  parseEmailAddress,
  isValidEmail,
  resolveDeliveryEmail,
};
