/**
 * Signed email open/click tracking tokens (HMAC-SHA256).
 *
 * Payload is base64url(JSON).sigHex — unsigned legacy base64 JSON still
 * accepted in non-production for backwards compatibility during rollout.
 */

const crypto = require('crypto');

function trackingSecret() {
  return (
    process.env.EMAIL_TRACKING_SECRET
    || process.env.ENCRYPTION_KEY
    || process.env.JWT_SECRET
    || ''
  ).trim();
}

function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64').toString('utf8');
}

function signPayload(payloadObj) {
  const secret = trackingSecret();
  const body = b64urlEncode(JSON.stringify(payloadObj));
  if (!secret) {
    if (isProduction()) {
      throw new Error('EMAIL_TRACKING_SECRET (or ENCRYPTION_KEY/JWT_SECRET) required to sign tracking tokens in production');
    }
    // Dev fallback: unsigned base64 JSON (legacy format)
    return Buffer.from(JSON.stringify(payloadObj)).toString('base64');
  }
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

function verifyAndDecodeToken(token) {
  const raw = String(token || '');
  if (!raw) throw new Error('missing token');

  const secret = trackingSecret();
  if (raw.includes('.')) {
    const [body, sig] = raw.split('.');
    if (!body || !sig) throw new Error('malformed signed token');
    if (!secret) {
      if (isProduction()) throw new Error('tracking secret not configured');
      // Dev: accept without verify if no secret
      return JSON.parse(b64urlDecode(body));
    }
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new Error('invalid tracking signature');
    }
    return JSON.parse(b64urlDecode(body));
  }

  // Legacy unsigned base64 JSON
  if (isProduction() && secret) {
    throw new Error('unsigned tracking tokens rejected in production');
  }
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

function apiPublicBase() {
  return (process.env.API_BASE_URL || process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5001}`).replace(/\/$/, '');
}

/**
 * Build open-pixel + rewrite http(s) links for click tracking.
 */
function injectEmailTracking(html, { leadId, workspaceId, conversationId, messageId }) {
  if (!html || !leadId) return html;
  let out = String(html);
  const base = apiPublicBase();

  try {
    const openToken = signPayload({
      leadId,
      workspaceId: workspaceId || 'default',
      conversationId: conversationId || null,
      messageId: messageId || null,
      t: Date.now(),
      kind: 'open',
    });
    const pixel = `<img src="${base}/api/email/tracking/open?e=${encodeURIComponent(openToken)}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" />`;
    if (/<\/body>/i.test(out)) {
      out = out.replace(/<\/body>/i, `${pixel}</body>`);
    } else {
      out = `${out}${pixel}`;
    }
  } catch (err) {
    console.warn('[EmailTracking] open pixel skipped:', err.message);
  }

  // Rewrite absolute http(s) anchors
  out = out.replace(/href=(["'])(https?:\/\/[^"']+)\1/gi, (match, quote, url) => {
    try {
      const clickToken = signPayload({
        leadId,
        workspaceId: workspaceId || 'default',
        conversationId: conversationId || null,
        messageId: messageId || null,
        targetUrl: url,
        t: Date.now(),
        kind: 'click',
      });
      const tracked = `${base}/api/email/tracking/click?e=${encodeURIComponent(clickToken)}&url=${encodeURIComponent(url)}`;
      return `href=${quote}${tracked}${quote}`;
    } catch (_) {
      return match;
    }
  });

  return out;
}

module.exports = {
  signPayload,
  verifyAndDecodeToken,
  injectEmailTracking,
  trackingSecret,
};
