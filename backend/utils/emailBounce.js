/**
 * Detect bounce / DSN (Delivery Status Notification) emails.
 * Used by inbox sync so mailer-daemon messages are not treated as lead replies.
 */

const BOUNCE_FROM_RE = /^(mailer-daemon@|postmaster@|mail-daemon@|noreply@bounce\.|bounces@)/i;
const BOUNCE_SUBJECT_RE = /(undeliverable|delivery status notification|mail delivery failed|delivery failure|returned mail|failure notice|could not be delivered)/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

function headerValue(parsed, name) {
  if (!parsed?.headers || typeof parsed.headers.get !== 'function') return '';
  try {
    const v = parsed.headers.get(name);
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(String).join(' ');
    if (typeof v === 'object' && v.value != null) return String(v.value);
    return String(v);
  } catch (_) {
    return '';
  }
}

function extractFailedRecipients(parsed, text) {
  const found = new Set();
  const xFailed = headerValue(parsed, 'x-failed-recipients');
  if (xFailed) {
    for (const m of xFailed.match(EMAIL_RE) || []) found.add(m.toLowerCase());
  }

  const attachments = Array.isArray(parsed?.attachments) ? parsed.attachments : [];
  for (const att of attachments) {
    const ct = String(att.contentType || '').toLowerCase();
    if (ct.includes('delivery-status') || ct.includes('rfc822-headers') || /delivery-status/i.test(att.filename || '')) {
      const body = Buffer.isBuffer(att.content)
        ? att.content.toString('utf8')
        : String(att.content || '');
      const final = body.match(/Final-Recipient:\s*(?:rfc822;?\s*)?([^\s\r\n]+)/i);
      if (final?.[1]) found.add(final[1].replace(/[<>]/g, '').toLowerCase());
      for (const m of body.match(EMAIL_RE) || []) found.add(m.toLowerCase());
    }
  }

  const blob = `${parsed?.subject || ''}\n${text || ''}\n${parsed?.text || ''}`;
  const originalTo = blob.match(/(?:Original-Recipient|Final-Recipient):\s*(?:rfc822;?\s*)?([^\s\r\n]+)/i);
  if (originalTo?.[1]) found.add(originalTo[1].replace(/[<>]/g, '').toLowerCase());

  // Common Gmail DSN phrasing
  const addressed = blob.match(/(?:addressed to|delivery to|recipient)\s*[:<]?\s*<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?/i);
  if (addressed?.[1]) found.add(addressed[1].toLowerCase());

  return [...found].filter((e) => !BOUNCE_FROM_RE.test(e) && !e.includes('mailer-daemon'));
}

/**
 * @returns {{ isBounce: boolean, failedRecipients: string[], reason: string|null }}
 */
function detectBounceOrDsn(parsed, fromEmail) {
  const from = String(fromEmail || '').toLowerCase().trim();
  const subject = String(parsed?.subject || '');
  const contentType = headerValue(parsed, 'content-type').toLowerCase();
  const autoSubmitted = headerValue(parsed, 'auto-submitted').toLowerCase();
  const text = String(parsed?.text || '');

  const fromIsBounce = BOUNCE_FROM_RE.test(from);
  const subjectIsBounce = BOUNCE_SUBJECT_RE.test(subject);
  const reportType = contentType.includes('multipart/report') || contentType.includes('delivery-status');
  const autoBounce = autoSubmitted.includes('auto-replied') || autoSubmitted === 'auto-generated';

  if (!fromIsBounce && !subjectIsBounce && !reportType) {
    return { isBounce: false, failedRecipients: [], reason: null };
  }

  // Avoid flagging normal auto-replies (vacation) unless from mailer-daemon / report
  if (!fromIsBounce && !reportType && !subjectIsBounce && autoBounce) {
    return { isBounce: false, failedRecipients: [], reason: null };
  }

  const failedRecipients = extractFailedRecipients(parsed, text);
  let reason = 'bounce_detected';
  if (fromIsBounce) reason = 'mailer_daemon';
  else if (reportType) reason = 'delivery_status_report';
  else if (subjectIsBounce) reason = 'bounce_subject';

  return { isBounce: true, failedRecipients, reason };
}

module.exports = {
  detectBounceOrDsn,
  extractFailedRecipients,
};
