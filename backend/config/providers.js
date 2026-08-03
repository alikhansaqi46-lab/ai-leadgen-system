/**
 * Provider Registry — single source of truth for all external integrations.
 *
 * Adding a new channel requires only:
 *   1. Add an entry here
 *   2. Add a frontend config entry (name + icon + path)
 *   3. Implement the provider-specific validation function
 */

const { isEmailConfigured } = require('../services/emailService');

const PROVIDERS = {
  whatsapp: {
    key: 'whatsapp',
    name: 'WhatsApp',
    channel: 'whatsapp',
    icon: '◉',
    // Official Meta WhatsApp Cloud API only (no QR / WhatsApp Web).
    authType: 'api_key',
    fields: [
      { key: 'token', label: 'Access Token', type: 'password', required: true },
      { key: 'phoneNumberId', label: 'Phone Number ID', type: 'text', required: true },
      { key: 'wabaId', label: 'WABA ID', type: 'text', required: false },
    ],
    validate: async (credentials) => {
      const { validateCredentials } = require('../services/whatsappMeta');
      if (!credentials.token || !credentials.phoneNumberId) {
        return { valid: false, error: 'Token and Phone Number ID are required' };
      }
      return validateCredentials(credentials.token, credentials.phoneNumberId);
    },
    envFallback: {},
  },

  email: {
    key: 'email',
    name: 'Email',
    channel: 'email',
    icon: '@',
    authType: 'oauth2',
    oauth: {
      provider: 'google',
      authUrl: 'https://accounts.google.com/o/oauth2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scope: 'https://mail.google.com/ email profile',
      accessType: 'offline',
      prompt: 'consent',
      clientIdEnv: 'GOOGLE_CLIENT_ID',
      clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
      profileUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
      accountField: 'email',
    },
    // No env fallback — OAuth integration is the ONLY supported email path.
  },

  sms: {
    key: 'sms',
    name: 'SMS',
    channel: 'sms',
    icon: '✆',
    authType: 'api_key',
    fields: [
      { key: 'accountSid', label: 'Account SID', type: 'text', required: true },
      { key: 'authToken', label: 'Auth Token', type: 'password', required: true },
      { key: 'phoneNumber', label: 'Phone Number', type: 'text', required: true },
    ],
    validate: async (credentials) => {
      if (!credentials.accountSid || !credentials.authToken) {
        return { valid: false, error: 'Account SID and Auth Token are required' };
      }
      // Future: ping Twilio API to validate
      return { valid: true };
    },
    envFallback: {},
  },

  ai_calling: {
    key: 'ai_calling',
    name: 'AI Calling',
    channel: 'ai_calling',
    icon: '☎',
    authType: 'api_key',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', required: true },
      { key: 'fromNumber', label: 'From Number', type: 'text', required: false },
    ],
    validate: async () => ({ valid: true }),
    envFallback: {},
  },
};

function getProvider(key) {
  return PROVIDERS[key] || null;
}

function getAllProviders() {
  return Object.values(PROVIDERS);
}

function listProviders() {
  return Object.values(PROVIDERS).map(({ key, name, channel, icon, authType, fields }) => ({
    key,
    name,
    channel,
    icon,
    authType,
    fields: (fields || []).map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required })),
  }));
}

module.exports = {
  PROVIDERS,
  getProvider,
  getAllProviders,
  listProviders,
  isEmailConfigured,
};
