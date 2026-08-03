/**
 * Security middleware: HTTP hardening headers + rate limiters + production config lock.
 *
 * Implements Helmet-equivalent response headers and express-rate-limit-style
 * sliding-window limiters without external packages (npm registry TLS is
 * unreliable in some deploy environments). Behavior matches production needs:
 * CSP (prod), HSTS, X-Frame-Options, nosniff, Referrer-Policy, etc.
 */

function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

/**
 * Fail-fast production configuration lock.
 * Call once at boot after dotenv.config().
 */
function assertProductionConfig() {
  if (!isProduction()) return;

  const errors = [];

  if ((process.env.AUTH_MODE || 'disabled').toLowerCase() === 'disabled') {
    errors.push('AUTH_MODE must not be "disabled" in production');
  }
  if ((process.env.AUTH_MODE || '').toLowerCase() === 'dev') {
    errors.push('AUTH_MODE=dev is not allowed in production');
  }

  const jwt = process.env.JWT_SECRET || '';
  if (!jwt || /change.?me|local-secret|dev-only|example/i.test(jwt) || jwt.length < 32) {
    errors.push('JWT_SECRET must be set to a strong secret (>=32 chars) in production');
  }

  const enc = process.env.ENCRYPTION_KEY || '';
  if (!enc || enc.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(enc)) {
    errors.push('ENCRYPTION_KEY must be a 64-char hex string (256-bit) in production');
  }

  if (String(process.env.TLS_INSECURE_ALLOW || '').toLowerCase() === 'true') {
    errors.push('TLS_INSECURE_ALLOW=true is forbidden in production');
  }

  if (!process.env.ALLOWED_ORIGINS && !process.env.FRONTEND_URL) {
    errors.push('ALLOWED_ORIGINS or FRONTEND_URL must be set in production');
  }

  if (!(process.env.WEBHOOK_SECRET || '').trim()) {
    errors.push('WEBHOOK_SECRET must be set in production (external + email inbound webhooks)');
  }

  if (!(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '').trim()) {
    errors.push('WHATSAPP_WEBHOOK_VERIFY_TOKEN must be set in production');
  }

  if (errors.length) {
    console.error('[FATAL] Production configuration lock failed:');
    errors.forEach((e) => console.error('  -', e));
    process.exit(1);
  }

  console.log('[Security] Production configuration lock passed');
}

/** Helmet-equivalent security headers. */
function createHelmetMiddleware() {
  return function helmetLite(req, res, next) {
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=()'
    );
    // Remove Express fingerprint
    res.removeHeader('X-Powered-By');

    if (isProduction()) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      // SPA + Google Fonts + PayPal frames
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob: https:",
        "connect-src 'self' https:",
        "frame-src 'self' https://www.paypal.com https://www.sandbox.paypal.com",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self' https://www.paypal.com https://www.sandbox.paypal.com",
        'upgrade-insecure-requests',
      ].join('; ');
      res.setHeader('Content-Security-Policy', csp);
    }

    next();
  };
}

/**
 * Simple fixed-window rate limiter (per IP).
 * Compatible enough with express-rate-limit usage patterns.
 */
function createLimiter({ windowMs, max, message }) {
  const hits = new Map();
  const window = windowMs || 15 * 60 * 1000;
  const limit = max || 100;
  const body = { error: message || 'Too many requests. Please try again later.' };

  // Periodic cleanup to avoid unbounded growth
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits.entries()) {
      if (now - entry.start >= window) hits.delete(key);
    }
  }, Math.min(window, 60 * 1000)).unref?.();

  return function rateLimitMiddleware(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.start >= window) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, limit - entry.count);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.start + window) / 1000)));

    if (entry.count > limit) {
      return res.status(429).json(body);
    }
    return next();
  };
}

const apiLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_API_MAX || '600', 10),
  message: 'Too many API requests. Please try again later.',
});

const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_AUTH_MAX || '40', 10),
  message: 'Too many authentication attempts. Please try again later.',
});

const sendLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_SEND_MAX || '120', 10),
  message: 'Send rate limit exceeded. Please slow down.',
});

const webhookLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_WEBHOOK_MAX || '300', 10),
  message: 'Webhook rate limit exceeded.',
});

module.exports = {
  assertProductionConfig,
  createHelmetMiddleware,
  apiLimiter,
  authLimiter,
  sendLimiter,
  webhookLimiter,
  isProduction,
  createLimiter,
};
