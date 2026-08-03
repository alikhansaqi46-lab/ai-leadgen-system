/**
 * Signed OAuth state tokens (HMAC-SHA256).
 * Prevents workspace takeover via forged base64 state on the public callback.
 */

const crypto = require('crypto');

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function stateSecret() {
  return (
    process.env.OAUTH_STATE_SECRET
    || process.env.JWT_SECRET
    || process.env.ENCRYPTION_KEY
    || ''
  ).trim();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64').toString('utf8');
}

function signOAuthState({ workspaceId, provider }) {
  const secret = stateSecret();
  if (!secret) {
    throw new Error('OAUTH_STATE_SECRET (or JWT_SECRET/ENCRYPTION_KEY) required to sign OAuth state');
  }
  const payload = {
    workspaceId: String(workspaceId || 'default'),
    provider: String(provider || ''),
    nonce: crypto.randomBytes(16).toString('hex'),
    exp: Date.now() + STATE_TTL_MS,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

function verifyOAuthState(state, expectedProvider) {
  const secret = stateSecret();
  if (!secret) throw new Error('OAuth state secret not configured');
  const raw = String(state || '');
  const [body, sig] = raw.split('.');
  if (!body || !sig) throw new Error('malformed OAuth state');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('invalid OAuth state signature');
  }
  const payload = JSON.parse(b64urlDecode(body));
  if (!payload.exp || Date.now() > Number(payload.exp)) {
    throw new Error('OAuth state expired');
  }
  if (expectedProvider && payload.provider && payload.provider !== expectedProvider) {
    throw new Error('OAuth state provider mismatch');
  }
  return {
    workspaceId: payload.workspaceId || 'default',
    provider: payload.provider,
    nonce: payload.nonce,
  };
}

module.exports = { signOAuthState, verifyOAuthState, STATE_TTL_MS };
