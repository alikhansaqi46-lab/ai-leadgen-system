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

/** Verify a token according to AUTH_MODE. Returns the decoded payload. Async. */
async function verifyToken(token) {
  const mode = authMode();

  if (mode === 'supabase') {
    // Prefer asymmetric JWKS verification (current Supabase default).
    const jwksUrl = supabaseJwksUrl();
    if (jwksUrl) {
      const { payload } = await jwtVerify(token, getJwks(jwksUrl), {
        algorithms: ['ES256', 'RS256'],
      });
      return payload;
    }
    // Fall back to legacy symmetric HS256 secret (older projects).
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (secret) {
      return jwt.verify(token, secret, { algorithms: ['HS256'] });
    }
    throw new Error('AUTH_MODE=supabase requires SUPABASE_URL (JWKS) or SUPABASE_JWT_SECRET');
  }

  if (mode === 'dev') {
    const secret = process.env.DEV_AUTH_SECRET;
    if (!secret) throw new Error('DEV_AUTH_SECRET is not set');
    return jwt.verify(token, secret, { algorithms: ['HS256'] });
  }

  if (mode === 'clerk') {
    throw new Error('AUTH_MODE=clerk is not implemented (use supabase or dev)');
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
    req.auth = {
      userId: payload.sub || payload.user_id || null,
      workspaceId: workspaceFromClaims(payload),
    };
    return next();
  } catch (err) {
    console.error('[Auth] Token verification failed:', err.message);
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
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

module.exports = { requireAuth, resolveWorkspaceOptional, DEFAULT_WORKSPACE_ID };
