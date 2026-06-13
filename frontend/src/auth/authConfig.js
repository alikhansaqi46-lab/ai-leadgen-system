// S2 auth configuration (frontend).
// AUTH_MODE=disabled (default) keeps the app exactly as before — no login screen.
export const AUTH_MODE = (process.env.REACT_APP_AUTH_MODE || 'disabled').toLowerCase();
export const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || '';

// Module-level access token so non-axios callers (e.g. the scrape fetch) can
// attach the Authorization header without prop-drilling.
let accessToken = null;
export function setAccessToken(token) { accessToken = token || null; }
export function getAccessToken() { return accessToken; }
