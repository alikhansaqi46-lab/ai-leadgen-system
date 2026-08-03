/**
 * Unified Integration Routes — single API for all external service connections.
 *
 * Replaces per-channel credential/status endpoints with one uniform interface.
 *
 *   GET  /api/integrations                          → list all providers + status
 *   GET  /api/integrations/:provider                → single provider status
 *   POST /api/integrations/:provider/connect          → save credentials (api_key type)
 *   POST /api/integrations/:provider/disconnect       → remove stored credentials
 *   GET  /api/integrations/:provider/oauth/url        → OAuth consent URL (oauth2 type)
 *   GET  /api/integrations/:provider/oauth/callback   → OAuth callback (oauth2 type)
 */

const express = require('express');
const router = express.Router();
const integrationStorage = require('../utils/integrationStorage');
const userStorage = require('../utils/userStorage');
const { getProvider, getAllProviders } = require('../config/providers');

const { workspaceOf } = require('../utils/workspaceContext');

/** Resolve a provider's status from storage or env fallback. */
function resolveStatus(workspaceId, providerKey) {
  const provider = getProvider(providerKey);
  if (!provider) return null;

  if (providerKey === 'whatsapp' && provider.authType === 'api_key') {
    try {
      const whatsappTransport = require('./whatsappTransport');
      const defaultWs = process.env.DEFAULT_WORKSPACE_ID || 'default';
      const waToken = process.env.WHATSAPP_TOKEN;
      const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
      const workspaceConfigured = whatsappTransport.isConfigured(defaultWs);
      if ((waToken && phoneId) || workspaceConfigured) {
        const stored = integrationStorage.get(workspaceId, providerKey);
        const connected = Boolean(stored?.connected) || whatsappTransport.isConfigured(workspaceId);
        return {
          provider: providerKey,
          name: provider.name,
          icon: provider.icon,
          connected,
          needsReconnect: stored?.status === 'disconnected' && !connected,
          reconnectReason: null,
          type: 'cloud_api',
          account: stored?.account || stored?.credentials?.phoneNumberId || null,
          connectedAt: stored?.connectedAt || stored?.updatedAt || null,
          status: stored?.status || (connected ? 'connected' : 'disconnected'),
        };
      }
    } catch (_) {
      /* fall through */
    }
  }

  const stored = integrationStorage.get(workspaceId, providerKey);

  // If stored and connected, return stored info
  if (stored && stored.connected) {
    const hasRefresh = Boolean(stored.credentials?.refreshToken);
    const needsReconnect = Boolean(stored.needsReconnect) || (stored.type === 'oauth2' && !hasRefresh);
    return {
      provider: providerKey,
      name: provider.name,
      icon: provider.icon,
      connected: true,
      needsReconnect,
      reconnectReason: stored.reconnectReason || (needsReconnect ? 'missing_refresh_token' : null),
      type: stored.type || provider.authType,
      account: stored.account || null,
      connectedAt: stored.connectedAt || stored.updatedAt || null,
    };
  }

  // For providers with env fallback, check if env vars are set
  const envVars = provider.envFallback || {};
  const envConfigured = Object.values(envVars).some((envKey) => !!process.env[envKey]);

  if (envConfigured) {
    return {
      provider: providerKey,
      name: provider.name,
      icon: provider.icon,
      connected: true,
      type: 'env_fallback',
      account: process.env[envVars.user || Object.values(envVars)[0]] || null,
      connectedAt: null,
    };
  }

  // Not connected
  return {
    provider: providerKey,
    name: provider.name,
    icon: provider.icon,
    connected: false,
    type: provider.authType,
    account: null,
    connectedAt: null,
  };
}

// =====================================================================
// 0. List provider definitions (for frontend dynamic rendering)
// =====================================================================
router.get('/providers', (req, res) => {
  try {
    const providers = getAllProviders().map((p) => ({
      key: p.key,
      name: p.name,
      icon: p.icon,
      channel: p.channel,
      authType: p.authType,
      fields: p.fields || null,
      managePath: `/app/${p.channel === 'call' ? 'ai-calling' : p.channel}`,
    }));
    res.json({ success: true, providers });
  } catch (error) {
    console.error('[Integrations] providers error:', error.message);
    res.status(500).json({ error: 'Failed to list providers' });
  }
});

// =====================================================================
// 1. List all integration statuses for the workspace
// =====================================================================
router.get('/', (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const integrations = getAllProviders().map((p) => resolveStatus(workspaceId, p.key));
    res.json({ success: true, integrations });
  } catch (error) {
    console.error('[Integrations] list error:', error.message);
    res.status(500).json({ error: 'Failed to list integrations' });
  }
});

// =====================================================================
// 2. Single provider status
// =====================================================================
router.get('/:provider', (req, res) => {
  try {
    const provider = getProvider(req.params.provider);
    if (!provider) {
      return res.status(404).json({ error: 'Unknown provider' });
    }
    const workspaceId = workspaceOf(req);
    const status = resolveStatus(workspaceId, req.params.provider);
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[Integrations] status error:', error.message);
    res.status(500).json({ error: 'Failed to get integration status' });
  }
});

// =====================================================================
// 3. Save credentials (api_key / basic_auth providers)
// =====================================================================
router.post('/:provider/connect', async (req, res) => {
  try {
    const providerKey = req.params.provider;
    const provider = getProvider(providerKey);
    if (!provider) {
      return res.status(404).json({ error: 'Unknown provider' });
    }

    if (provider.authType === 'oauth2') {
      return res.status(400).json({ error: 'Use OAuth flow for this provider' });
    }

    const { credentials } = req.body;
    if (!credentials || typeof credentials !== 'object') {
      return res.status(400).json({ error: 'credentials object is required' });
    }

    // Validate credentials if a validator exists
    if (provider.validate) {
      const validation = await provider.validate(credentials);
      if (!validation.valid) {
        return res.status(400).json({ error: 'Invalid credentials', message: validation.error });
      }
    }

    const workspaceId = workspaceOf(req);
    const account = credentials.phoneNumberId || credentials.account || credentials.email || 'connected';

    integrationStorage.set(workspaceId, providerKey, {
      type: provider.authType,
      connected: true,
      account,
      credentials,
      connectedAt: new Date().toISOString(),
    });

    res.json({ success: true, message: `${provider.name} connected successfully` });
  } catch (error) {
    console.error('[Integrations] connect error:', error.message);
    res.status(500).json({ error: 'Failed to connect integration' });
  }
});

// =====================================================================
// 4. Disconnect — remove stored credentials
// =====================================================================
router.post('/:provider/disconnect', async (req, res) => {
  try {
    const providerKey = req.params.provider;
    const provider = getProvider(providerKey);
    if (!provider) {
      return res.status(404).json({ error: 'Unknown provider' });
    }

    const workspaceId = workspaceOf(req);
    const removed = integrationStorage.remove(workspaceId, providerKey);

    res.json({
      success: true,
      removed,
      message: removed ? `${provider.name} disconnected` : 'No stored credentials to remove',
    });
  } catch (error) {
    console.error('[Integrations] disconnect error:', error.message);
    res.status(500).json({ error: 'Failed to disconnect integration' });
  }
});

// =====================================================================
// 5. OAuth: Generate consent URL
// =====================================================================
router.get('/:provider/oauth/url', (req, res) => {
  try {
    const providerKey = req.params.provider;
    const provider = getProvider(providerKey);
    if (!provider) {
      return res.status(404).json({ error: 'Unknown provider' });
    }
    if (provider.authType !== 'oauth2') {
      return res.status(400).json({ error: 'This provider does not use OAuth' });
    }

    const workspaceId = workspaceOf(req);
    const clientId = process.env[provider.oauth.clientIdEnv];
    const clientSecret = process.env[provider.oauth.clientSecretEnv];
    const redirectUri = `${process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5001}`}/api/integrations/${providerKey}/oauth/callback`;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: 'OAuth not configured on server.',
        message: `Set ${provider.oauth.clientIdEnv} and ${provider.oauth.clientSecretEnv} environment variables.`,
        // Note: SMTP via env variables is no longer supported. OAuth integration is required.
        setupRequired: true,
      });
    }

    // Detect placeholder credentials to prevent confusing Google 401 invalid_client
    const isPlaceholder = /your-client-id|YOUR_CLIENT_ID|example|placeholder|changeme|xxx/i.test(clientId) ||
                          /your-client-secret|YOUR_CLIENT_SECRET|xxx/i.test(clientSecret || '');
    if (isPlaceholder) {
      return res.status(400).json({
        success: false,
        error: 'OAuth credentials are placeholders.',
        message: `The ${provider.oauth.clientIdEnv} and ${provider.oauth.clientSecretEnv} values in your .env file are placeholders. Create real credentials in Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID (Web application), add redirect URI ${redirectUri}, then update your .env file.`,
        setupRequired: true,
        redirectUri,
      });
    }

    // Signed state token (workspaceId + provider + nonce + exp) — prevents callback workspace takeover
    const { signOAuthState } = require('../utils/oauthState');
    const state = signOAuthState({ workspaceId, provider: providerKey });

    // Build OAuth URL manually — URLSearchParams percent-encodes colons and slashes
    // in the scope value (e.g. https%3A%2F%2Fmail.google.com%2F), which causes Google to
    // silently drop Gmail scopes. We keep the scope URLs literal and only encode spaces as %20.
    const scopeEncoded = provider.oauth.scope.split(' ').join('%20');
    const stateEncoded = encodeURIComponent(state);
    const redirectEncoded = encodeURIComponent(redirectUri);
    const url = `${provider.oauth.authUrl}` +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${redirectEncoded}` +
      `&response_type=code` +
      `&scope=${scopeEncoded}` +
      `&access_type=${encodeURIComponent(provider.oauth.accessType || 'offline')}` +
      `&prompt=${encodeURIComponent(provider.oauth.prompt || 'consent')}` +
      `&state=${stateEncoded}`;
    console.log('[Integrations] OAuth URL generated:', url);
    res.json({ success: true, url });
  } catch (error) {
    console.error('[Integrations] OAuth URL error:', error.message);
    res.status(500).json({ error: 'Failed to generate OAuth URL' });
  }
});

// =====================================================================
// 6. OAuth: Callback — exchange code for tokens
// =====================================================================
router.get('/:provider/oauth/callback', async (req, res) => {
  try {
    const providerKey = req.params.provider;
    const provider = getProvider(providerKey);
    if (!provider || provider.authType !== 'oauth2') {
      return res.status(400).send('Invalid provider');
    }

    const { code, state } = req.query;
    if (!code) {
      return res.status(400).send('Missing authorization code');
    }
    if (!state) {
      return res.status(400).send('Missing OAuth state');
    }

    // Verify signed state (binds workspace + provider; rejects forged callbacks)
    let workspaceId = 'default';
    try {
      const { verifyOAuthState } = require('../utils/oauthState');
      const decoded = verifyOAuthState(String(state), providerKey);
      workspaceId = decoded.workspaceId || 'default';
    } catch (err) {
      console.warn('[Integrations] OAuth state rejected:', err.message);
      return res.status(400).send('Invalid or expired OAuth state. Close this window and try connecting again.');
    }

    const clientId = process.env[provider.oauth.clientIdEnv];
    const clientSecret = process.env[provider.oauth.clientSecretEnv];
    const redirectUri = `${process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5001}`}/api/integrations/${providerKey}/oauth/callback`;

    if (!clientId || !clientSecret) {
      return res.status(400).send(`OAuth not configured on server. Set ${provider.oauth.clientIdEnv} and ${provider.oauth.clientSecretEnv} environment variables.`);
    }

    // Exchange code for tokens
    const axios = require('axios');
    let tokenRes;
    try {
      tokenRes = await axios.post(
        provider.oauth.tokenUrl,
        new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
    } catch (tokenErr) {
      const googleError = tokenErr.response?.data?.error;
      const googleDesc = tokenErr.response?.data?.error_description;
      let userMsg = 'Connection failed.';
      if (googleError === 'invalid_client') {
        userMsg = 'Invalid OAuth client credentials. Please verify GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file match the values in Google Cloud Console.';
      } else if (googleError === 'invalid_grant') {
        userMsg = 'Authorization code expired or already used. Please try connecting again.';
      } else if (googleError === 'redirect_uri_mismatch') {
        userMsg = `Redirect URI mismatch. Make sure ${redirectUri} is added to the Authorized redirect URIs in Google Cloud Console.`;
      } else if (googleError) {
        userMsg = `Google OAuth error: ${googleError}${googleDesc ? ` — ${googleDesc}` : ''}`;
      }
      console.error('[Integrations] Token exchange failed:', googleError || tokenErr.message);
      return res.status(400).send(`<!DOCTYPE html>
<html><body>
<script>if(window.opener){window.opener.postMessage({type:'oauth-error',provider:'${providerKey}',error:'${userMsg.replace(/'/g, "\\'")}'},'*');}window.close();</script>
<p style="color:#b91c1c;font-family:sans-serif;padding:20px"><strong>Connection failed</strong><br>${userMsg}<br><br>You can close this window.</p>
</body></html>`);
    }

    // Dump the FULL token response from Google
    console.log('\n========== OAUTH TOKEN EXCHANGE DIAGNOSTIC ==========');
    console.log('[OAuth] Requested scope (from provider config):', provider.oauth.scope);
    console.log('[OAuth] Redirect URI used:', redirectUri);
    console.log('[OAuth] Full token response keys:', Object.keys(tokenRes.data));
    console.log('[OAuth] tokenRes.data.scope:', tokenRes.data.scope || 'NOT PRESENT');
    console.log('[OAuth] tokenRes.data.token_type:', tokenRes.data.token_type || 'N/A');
    console.log('[OAuth] tokenRes.data.expires_in:', tokenRes.data.expires_in || 'N/A');
    console.log('[OAuth] has refresh_token:', !!tokenRes.data.refresh_token);
    console.log('[OAuth] access_token preview:', (tokenRes.data.access_token || '').substring(0, 40) + '...');

    const { access_token, refresh_token, expires_in, scope } = tokenRes.data;

    // Decode the JWT access token to check the scope claim
    try {
      const parts = access_token.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        console.log('[OAuth] JWT payload.scope:', payload.scope || 'NOT PRESENT');
        console.log('[OAuth] JWT payload.azp:', payload.azp || 'N/A');
        console.log('[OAuth] JWT payload.aud:', payload.aud || 'N/A');
        console.log('[OAuth] JWT payload.email:', payload.email || 'N/A');
        console.log('[OAuth] JWT payload.exp:', payload.exp ? new Date(payload.exp * 1000).toISOString() : 'N/A');
      }
    } catch (decodeErr) {
      console.log('[OAuth] Could not decode JWT (may be opaque token):', decodeErr.message);
    }

    // Also call Google's tokeninfo endpoint
    try {
      const tokenInfoRes = await axios.get(`https://oauth2.googleapis.com/tokeninfo?access_token=${access_token}`);
      console.log('[OAuth] tokeninfo.scope:', tokenInfoRes.data.scope || 'NOT PRESENT');
      console.log('[OAuth] tokeninfo.email:', tokenInfoRes.data.email || 'N/A');
      console.log('[OAuth] tokeninfo.full:', JSON.stringify(tokenInfoRes.data));
    } catch (tokenInfoErr) {
      console.log('[OAuth] tokeninfo call failed:', tokenInfoErr.message);
    }

    console.log(`[OAuth] Granted scopes: ${scope || 'N/A'}`);

    // Validate that Gmail scopes were actually granted
    const hasGmailScopes = scope && (scope.includes('mail.google.com') || scope.includes('gmail.send'));
    if (!hasGmailScopes) {
      console.error(`[OAuth] ❌ Gmail scopes NOT granted by Google!`);
      console.error(`[OAuth] Requested: ${provider.oauth.scope}`);
      console.error(`[OAuth] Granted:    ${scope || 'NONE'}`);
      console.error(`[OAuth] Fix: Google Cloud Console → APIs & Services → Enable Gmail API`);
      console.error(`[OAuth] Fix: Google Cloud Console → OAuth consent screen → Scopes → Add https://mail.google.com/`);
      console.log('========== END OAUTH TOKEN EXCHANGE DIAGNOSTIC ==========\n');

      const errorMsg = 'Gmail scopes were not granted. Please go to Google Cloud Console → APIs & Services → enable "Gmail API", then go to OAuth consent screen → Scopes → add "https://mail.google.com/" and try connecting again.';
      return res.status(400).send(`<!DOCTYPE html>
<html><body>
<script>if(window.opener){window.opener.postMessage({type:'oauth-error',provider:'${providerKey}',error:'${errorMsg.replace(/'/g, "\\'")}'},'*');}window.close();</script>
<p style="color:#b91c1c;font-family:sans-serif;padding:20px">
<strong>Gmail scopes not granted</strong><br>
${errorMsg}<br><br>
You can close this window.
</p>
</body></html>`);
    }
    console.log('========== END OAUTH TOKEN EXCHANGE DIAGNOSTIC ==========\n');

    // Fetch user profile from provider-configured endpoint
    let accountValue = null;
    try {
      const profileRes = await axios.get(provider.oauth.profileUrl, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const field = provider.oauth.accountField;
      accountValue = field ? profileRes.data[field] : null;
    } catch (err) {
      console.warn(`[Integrations] Could not fetch profile from ${provider.oauth.profileUrl}:`, err.message);
    }

    // Store tokens + granted scopes.
    // Google often omits refresh_token on re-consent — never wipe an existing one.
    const existing = integrationStorage.get(workspaceId, providerKey);
    const preservedRefresh = refresh_token || existing?.credentials?.refreshToken || null;
    if (!preservedRefresh) {
      // Without a refresh token the connection will fail on the first send.
      // Do NOT store a half-working connection — force the user to redo consent properly.
      console.error('[OAuth] No refresh_token from Google and none stored — refusing to store connection.');
      const fixMsg = 'Google did not grant offline access (no refresh token). To fix: 1) Go to https://myaccount.google.com/permissions and REMOVE this app, 2) come back and Connect Gmail again, 3) make sure you accept all permissions on the consent screen. If this keeps happening, check that your Google Cloud OAuth consent screen is not in "Testing" mode (refresh tokens expire after 7 days in Testing mode).';
      return res.status(400).send(`<!DOCTYPE html>
<html><body>
<script>if(window.opener){window.opener.postMessage({type:'oauth-error',provider:'${providerKey}',error:'${fixMsg.replace(/'/g, "\\'")}'},'*');}window.close();</script>
<p style="color:#b91c1c;font-family:sans-serif;padding:20px;max-width:560px">
<strong>Gmail connection incomplete</strong><br><br>
${fixMsg}<br><br>
You can close this window.
</p>
</body></html>`);
    }

    // Verify the refresh token ACTUALLY works before declaring success.
    // If Google omitted a new refresh_token and the preserved one is already dead
    // (invalid_grant), storing it would recreate the "connected but cannot send" loop.
    let verifiedAccessToken = access_token;
    let verifiedExpiry = expires_in ? new Date(Date.now() + expires_in * 1000).toISOString() : null;
    try {
      const { OAuth2Client } = require('google-auth-library');
      const verifyClient = new OAuth2Client(clientId, clientSecret);
      verifyClient.setCredentials({ refresh_token: preservedRefresh });
      const { credentials: refreshed } = await verifyClient.refreshAccessToken();
      if (refreshed.access_token) {
        verifiedAccessToken = refreshed.access_token;
        verifiedExpiry = refreshed.expiry_date ? new Date(refreshed.expiry_date).toISOString() : verifiedExpiry;
      }
      console.log('[OAuth] Refresh token verified working — connection is send-ready.');
    } catch (verifyErr) {
      const vMsg = String(verifyErr?.message || verifyErr);
      if (/invalid_grant/i.test(vMsg)) {
        console.error('[OAuth] Preserved refresh token is DEAD (invalid_grant) — refusing to store broken connection.');
        const deadMsg = 'The stored Gmail authorization is revoked or expired (Google invalid_grant). To fix: 1) Go to https://myaccount.google.com/permissions and REMOVE this app, 2) come back and click Connect Gmail again, 3) accept all permissions. A fresh token will then be issued. If this happens every ~7 days, publish your OAuth app: Google Cloud Console → OAuth consent screen → Publishing status → "In production" (Testing mode expires refresh tokens after 7 days).';
        return res.status(400).send(`<!DOCTYPE html>
<html><body>
<script>if(window.opener){window.opener.postMessage({type:'oauth-error',provider:'${providerKey}',error:'${deadMsg.replace(/'/g, "\\'")}'},'*');}window.close();</script>
<p style="color:#b91c1c;font-family:sans-serif;padding:20px;max-width:560px">
<strong>Gmail authorization is dead</strong><br><br>
${deadMsg}<br><br>
You can close this window.
</p>
</body></html>`);
      }
      console.warn('[OAuth] Refresh token verification failed (non-fatal):', vMsg);
    }

    integrationStorage.set(workspaceId, providerKey, {
      type: 'oauth2',
      connected: true,
      account: accountValue || 'connected',
      needsReconnect: false,
      reconnectReason: null,
      credentials: {
        accessToken: verifiedAccessToken,
        refreshToken: preservedRefresh,
        expiryDate: verifiedExpiry,
        scope: scope || existing?.credentials?.scope || null,
      },
      connectedAt: new Date().toISOString(),
    });

    // Sync sender email so the "From" address matches the connected OAuth account
    if (accountValue) {
      try {
        await userStorage.setSenderEmail(workspaceId, accountValue);
      } catch (err) {
        console.warn('[Integrations] Could not sync sender email:', err.message);
      }
    }

    // Return a popup-friendly HTML page that posts message to parent (origin-restricted)
    const frontendOrigin = (process.env.FRONTEND_URL || process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
      .split(',')[0]
      .trim()
      .replace(/\/$/, '') || 'http://localhost:3000';
    const safeAccount = String(accountValue || '').replace(/[\\'<>]/g, '');
    const safeProvider = String(providerKey || '').replace(/[\\'<>]/g, '');
    res.send(`<!DOCTYPE html>
<html><body>
<script>
  if (window.opener) {
    window.opener.postMessage({ type: 'oauth-success', provider: '${safeProvider}', account: '${safeAccount}' }, '${frontendOrigin}');
  }
  window.close();
</script>
<p>Connected successfully. You can close this window.</p>
</body></html>`);
  } catch (error) {
    console.error('[Integrations] OAuth callback error:', error.message);
    res.status(500).send('Connection failed. Please close this window and try again.');
  }
});

module.exports = router;
