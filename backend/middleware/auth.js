/**
 * Authentication & workspace resolution middleware.
 *
 * Resolves a verified identity into req.auth = { userId, workspaceId }.
 * Provider is selected by AUTH_MODE:
 *   - 'disabled' (default) → no token required; uses DEFAULT_WORKSPACE_ID.
 *                            Preserves pre-S2 behavior exactly.
 *   - 'supabase'           → verify a Supabase JWT. Two signing schemes are
 *                            supported automatically:
 *                              • Asymmetric (ES256/RS256) via the project JWKS
 *                                endpoint — the current Supabase default. Set
 *                                SUPABASE_URL (or SUPABASE_JWKS_URL); no secret.
 *                              • Legacy symmetric HS256 via SUPABASE_JWT_SECRET
 *                                (older projects).
 *   - 'dev'                → verify a locally HMAC-signed JWT (DEV_AUTH_SECRET).
 *                            For local/automated testing without a paid provider.
 *   - 'clerk'              → not implemented (Supabase is the chosen provider).
 *
 * The WhatsApp webhook is intentionally NOT protected by this middleware
 * (Meta calls it without a user token).
 */

const jwt = require('jsonwebtoken');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const userStorage = require('../utils/userStorage');

const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || 'default';

function authMode() {
  return (process.env.AUTH_MODE || 'disabled').toLowerCase();
}

/** Pick a workspace id from JWT claims (one-workspace-per-user fallback to sub). */
function workspaceFromClaims(payload) {
  return (
    (payload.app_metadata && payload.app_metadata.workspace_id) ||
    payload.workspace_id ||
    payload.org_id ||
    payload.sub ||
    DEFAULT_WORKSPACE_ID
  );
}

function getBearerToken(req) {
  const header = req.headers['authorization'] || req.headers['Authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

/** Derive the Supabase JWKS URL from explicit env or the project URL. */
function supabaseJwksUrl() {
  if (process.env.SUPABASE_JWKS_URL) return process.env.SUPABASE_JWKS_URL;
  const base = (process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/auth/v1/.well-known/jwks.json`;
}

// Cache one remote JWK set per URL (handles key fetching, caching and rotation).
const jwksCache = new Map();
function getJwks(url) {
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, set);
  }
  return set;
}

function clearAuthCaches() {
  const before = jwksCache.size;
  jwksCache.clear();
  return { jwksEntriesCleared: before };
}

async function applySessionGate(req, payload, user) {
  const sessionService = require('../services/sessionService');
  const sessionId = payload.sid || null;
  const check = await sessionService.validateSession(sessionId, user);
  if (!check.ok) {
    const err = new Error(check.reason || 'Session expired');
    err.status = 401;
    err.code = 'SESSION_EXPIRED';
    throw err;
  }
  if (sessionId && !check.legacy) {
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.ip || null;
    const userAgent = req.headers['user-agent'] || null;
    await sessionService.touchSession(sessionId, { ip, userAgent }).catch(() => null);
  }
  return sessionId;
}

/** Verify a token according to AUTH_MODE. Returns the decoded payload. Async. */
async function verifyToken(token) {
  const mode = authMode();

  if (mode === 'supabase') {
    // 1) Custom LeadFlow HS256 tokens from POST /api/auth/login (primary path for this app).
    const localSecret = process.env.JWT_SECRET || process.env.SUPABASE_JWT_SECRET || process.env.DEV_AUTH_SECRET;
    if (localSecret) {
      try {
        return jwt.verify(token, localSecret, { algorithms: ['HS256'] });
      } catch (hsErr) {
        if (!/expired|invalid signature|jwt malformed/i.test(hsErr.message || '')) {
          // Not a custom token — try Supabase JWKS below.
        } else {
          throw hsErr;
        }
      }
    }
    // 2) Supabase Auth asymmetric JWKS (optional S2 path).
    const jwksUrl = supabaseJwksUrl();
    if (jwksUrl) {
      try {
        const { payload } = await jwtVerify(token, getJwks(jwksUrl), {
          algorithms: ['ES256', 'RS256'],
        });
        return payload;
      } catch (jwksErr) {
        const msg = (jwksErr && jwksErr.message) || String(jwksErr);
        if (/certificate|TLS|fetch|network|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
          console.error('[Auth] Supabase JWKS unreachable — check --use-system-ca / TLS trust:', msg);
        }
      }
    }
    throw new Error('AUTH_MODE=supabase requires a valid LeadFlow JWT or Supabase JWT');
  }

  if (mode === 'dev') {
    const secret = process.env.DEV_AUTH_SECRET;
    if (!secret) throw new Error('DEV_AUTH_SECRET is not set');
    return jwt.verify(token, secret, { algorithms: ['HS256'] });
  }

  if (mode === 'local') {
    const secret = process.env.JWT_SECRET || process.env.DEV_AUTH_SECRET;
    if (!secret) throw new Error('AUTH_MODE=local requires JWT_SECRET or DEV_AUTH_SECRET');
    return jwt.verify(token, secret, { algorithms: ['HS256'] });
  }

  if (mode === 'clerk') {
    throw new Error('AUTH_MODE=clerk is not implemented (use supabase, dev, or local)');
  }

  throw new Error(`Unknown AUTH_MODE: ${mode}`);
}

/**
 * Express middleware. Populates req.auth.
 * - disabled: always allow, workspaceId = DEFAULT_WORKSPACE_ID.
 * - otherwise: require a valid Bearer token, else 401.
 */
async function requireAuth(req, res, next) {
  const mode = authMode();

  if (mode === 'disabled') {
    req.auth = { userId: DEFAULT_WORKSPACE_ID, workspaceId: DEFAULT_WORKSPACE_ID };
    return next();
  }

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing Bearer token' });
  }

  try {
    const payload = await verifyToken(token);
    const userId = payload.sub || payload.user_id || null;
    const user = userId ? await userStorage.findById(userId).catch(() => null) : null;
    const sessionId = await applySessionGate(req, payload, user);
    req.auth = {
      userId,
      workspaceId: workspaceFromClaims(payload),
      sessionId,
      role: user?.role || payload.role || 'subscriber',
    };
    return next();
  } catch (err) {
    console.error('[Auth] Token verification failed:', err.message);
    const status = err.status || 401;
    return res.status(status).json({
      error: 'Unauthorized',
      message: err.code === 'SESSION_EXPIRED' ? err.message : 'Invalid token',
      code: err.code || undefined,
    });
  }
}

/**
 * Express middleware. Requires valid token AND verified email.
 * Returns 403 if token is valid but email is not verified.
 */
async function requireEmailVerified(req, res, next) {
  const mode = authMode();

  if (mode === 'disabled') {
    req.auth = { userId: DEFAULT_WORKSPACE_ID, workspaceId: DEFAULT_WORKSPACE_ID };
    return next();
  }

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing Bearer token' });
  }

  try {
    const payload = await verifyToken(token);
    const userId = payload.sub || payload.user_id || null;

    // Check if user's email is verified
    const user = await userStorage.findById(userId);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'User not found' });
    }

    const sessionId = await applySessionGate(req, payload, user);

    // Super admins bypass email verification requirement
    const role = user.role || 'subscriber';
    if (role === 'super_admin') {
      req.auth = {
        userId,
        workspaceId: workspaceFromClaims(payload),
        role,
        emailVerified: true,
        sessionId,
      };
      return next();
    }

    if (!user.email_verified) {
      return res.status(403).json({ error: 'Email verification required.' });
    }

    req.auth = {
      userId,
      workspaceId: workspaceFromClaims(payload),
      role: user.role || 'subscriber',
      emailVerified: user.email_verified,
      sessionId,
    };
    return next();
  } catch (err) {
    console.error('[Auth] Token verification failed:', err.message);
    const status = err.status || 401;
    return res.status(status).json({
      error: err.status === 401 ? 'Unauthorized' : 'Unauthorized',
      message: err.code === 'SESSION_EXPIRED' ? err.message : 'Invalid token',
      code: err.code || undefined,
    });
  }
}

/** Resolve a workspace id WITHOUT requiring auth (used by the open webhook). */
async function resolveWorkspaceOptional(req) {
  if (authMode() === 'disabled') return DEFAULT_WORKSPACE_ID;
  const token = getBearerToken(req);
  if (!token) return DEFAULT_WORKSPACE_ID;
  try {
    return workspaceFromClaims(await verifyToken(token));
  } catch (err) {
    return DEFAULT_WORKSPACE_ID;
  }
}

module.exports = { requireAuth, requireEmailVerified, resolveWorkspaceOptional, DEFAULT_WORKSPACE_ID, clearAuthCaches };
