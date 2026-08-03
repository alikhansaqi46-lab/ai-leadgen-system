/**
 * Lightweight security regression checks (no network / no DB required).
 * Run: node scripts/verify-security-hardening.js
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

process.chdir(path.join(__dirname, '..'));

// Ensure non-production so config lock does not exit
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { encrypt, decrypt } = require('../utils/encryption');
const { getTlsOptions, tlsInsecureAllowed } = require('../config/tls');
const { createHelmetMiddleware, createLimiter, assertProductionConfig } = require('../middleware/security');
const { verifyWhatsAppSignature } = require('../middleware/whatsappWebhook');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log('  ✓', name);
}

console.log('[verify-security] encryption');
const cipher = encrypt(JSON.stringify({ token: 'secret-token', phoneNumberId: '123' }));
assert.ok(cipher && !cipher.includes('secret-token'));
const plain = JSON.parse(decrypt(cipher));
assert.strictEqual(plain.token, 'secret-token');
ok('AES-256-GCM round-trip');

console.log('[verify-security] TLS defaults');
delete process.env.TLS_INSECURE_ALLOW;
assert.strictEqual(getTlsOptions().rejectUnauthorized, true);
assert.strictEqual(tlsInsecureAllowed(), false);
ok('TLS verification enabled by default');
{
  const { isTlsTrustError } = require('../config/tls');
  assert.strictEqual(isTlsTrustError(new Error('self-signed certificate in certificate chain')), true);
  assert.strictEqual(isTlsTrustError(new Error('connection refused')), false);
  ok('TLS trust error detector');
}

console.log('[verify-security] Helmet headers');
{
  const mw = createHelmetMiddleware();
  const headers = {};
  const res = {
    setHeader(k, v) { headers[k] = v; },
    removeHeader() {},
  };
  mw({}, res, () => {});
  assert.strictEqual(headers['X-Content-Type-Options'], 'nosniff');
  assert.strictEqual(headers['X-Frame-Options'], 'SAMEORIGIN');
  ok('security headers set');
}

console.log('[verify-security] rate limiter');
{
  const limiter = createLimiter({ windowMs: 60_000, max: 2, message: 'limited' });
  let status = 200;
  const res = {
    setHeader() {},
    status(code) { status = code; return this; },
    json() { return this; },
  };
  let nextCount = 0;
  limiter({ ip: '1.2.3.4' }, res, () => { nextCount += 1; });
  limiter({ ip: '1.2.3.4' }, res, () => { nextCount += 1; });
  limiter({ ip: '1.2.3.4' }, res, () => { nextCount += 1; });
  assert.strictEqual(nextCount, 2);
  assert.strictEqual(status, 429);
  ok('rate limiter blocks after max');
}

console.log('[verify-security] WhatsApp signature');
{
  const secret = 'test-app-secret';
  process.env.WHATSAPP_APP_SECRET = secret;
  const rawBody = Buffer.from('{"object":"whatsapp_business_account"}');
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  let statusCode = 200;
  const res = {
    status(c) { statusCode = c; return this; },
    send() { return this; },
  };

  let nextCalled = false;
  verifyWhatsAppSignature(
    { method: 'POST', headers: { 'x-hub-signature-256': sig }, rawBody },
    res,
    () => { nextCalled = true; }
  );
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(statusCode, 200);
  ok('valid Meta signature accepted');

  nextCalled = false;
  statusCode = 200;
  verifyWhatsAppSignature(
    { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=deadbeef' }, rawBody },
    res,
    () => { nextCalled = true; }
  );
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(statusCode, 401);
  ok('invalid Meta signature rejected');
}

console.log('[verify-security] production lock (non-prod no-op)');
assertProductionConfig();
ok('assertProductionConfig no-op outside production');

console.log('[verify-security] email tracking HMAC');
{
  const { signPayload, verifyAndDecodeToken, injectEmailTracking } = require('../utils/emailTracking');
  const payload = { leadId: 'lead-1', workspaceId: 'default', kind: 'open', t: 1 };
  const token = signPayload(payload);
  assert.ok(token.includes('.'), 'signed token has body.sig');
  const decoded = verifyAndDecodeToken(token);
  assert.strictEqual(decoded.leadId, 'lead-1');
  ok('email tracking sign/verify');

  let bad = false;
  try {
    verifyAndDecodeToken(token.slice(0, -4) + 'dead');
  } catch (_) {
    bad = true;
  }
  assert.strictEqual(bad, true);
  ok('tampered tracking token rejected');

  const html = injectEmailTracking('<html><body><a href="https://example.com/x">x</a></body></html>', {
    leadId: 'lead-1',
    workspaceId: 'ws',
  });
  assert.ok(html.includes('/api/email/tracking/open?e='));
  assert.ok(html.includes('/api/email/tracking/click?e='));
  assert.ok(html.includes('example.com'));
  ok('tracking pixel + click rewrite injected');
}

console.log('[verify-security] Twilio signature');
{
  const { computeTwilioSignature, verifyTwilioSignature } = require('../middleware/twilioWebhook');
  const token = 'twilio-test-auth-token';
  process.env.TWILIO_AUTH_TOKEN = token;
  process.env.TWILIO_WEBHOOK_BASE_URL = 'https://api.example.com';
  const params = { From: '+15551234567', Body: 'hi', To: '+15557654321' };
  const url = 'https://api.example.com/api/sms/webhook';
  const sig = computeTwilioSignature(token, url, params);

  let statusCode = 200;
  let nextCalled = false;
  const res = {
    status(c) { statusCode = c; return this; },
    send() { return this; },
  };
  verifyTwilioSignature(
    {
      method: 'POST',
      headers: { 'x-twilio-signature': sig },
      originalUrl: '/api/sms/webhook',
      url: '/api/sms/webhook',
      body: params,
    },
    res,
    () => { nextCalled = true; }
  );
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(statusCode, 200);
  ok('valid Twilio signature accepted');

  nextCalled = false;
  statusCode = 200;
  verifyTwilioSignature(
    {
      method: 'POST',
      headers: { 'x-twilio-signature': 'bogus' },
      originalUrl: '/api/sms/webhook',
      body: params,
    },
    res,
    () => { nextCalled = true; }
  );
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(statusCode, 403);
  ok('invalid Twilio signature rejected');
}

console.log('[verify-security] OAuth state HMAC');
{
  const { signOAuthState, verifyOAuthState } = require('../utils/oauthState');
  const state = signOAuthState({ workspaceId: 'ws-1', provider: 'email' });
  const decoded = verifyOAuthState(state, 'email');
  assert.strictEqual(decoded.workspaceId, 'ws-1');
  ok('OAuth state sign/verify');
  let rejected = false;
  try {
    const [body, sig] = state.split('.');
    const tampered = `${body}.${sig.slice(0, -4)}dead`;
    verifyOAuthState(tampered, 'email');
  } catch (_) {
    rejected = true;
  }
  assert.strictEqual(rejected, true);
  ok('tampered OAuth state rejected');
}

console.log('[verify-security] SSRF guards');
(async () => {
  const { isPrivateIp, assertSafePublicUrl } = require('../utils/emailExtractor');
  assert.strictEqual(isPrivateIp('127.0.0.1'), true);
  assert.strictEqual(isPrivateIp('10.0.0.5'), true);
  assert.strictEqual(isPrivateIp('8.8.8.8'), false);
  ok('private IP detection');
  let blocked = false;
  try {
    await assertSafePublicUrl('http://127.0.0.1/');
  } catch (_) {
    blocked = true;
  }
  assert.strictEqual(blocked, true);
  ok('localhost URL blocked');

  console.log(`\n[verify-security] ${passed} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
