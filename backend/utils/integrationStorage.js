/**
 * Unified Integration Storage — workspace-scoped credential store for all channels.
 *
 * Credentials are encrypted at rest with AES-256-GCM (utils/encryption.js).
 * On-disk shape:
 *   integrations[workspaceId][provider] = {
 *     type, connected, account, connectedAt,
 *     credentialsEnc: "<base64 iv+tag+ciphertext of JSON credentials>",
 *     // legacy plaintext `credentials` is migrated on read/write
 *   }
 */

const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./encryption');

const DATA_FILE = path.join(__dirname, '..', 'data', 'integrations.json');
const DATA_TMP = path.join(__dirname, '..', 'data', 'integrations.json.tmp');

/* ==================== File persistence ==================== */

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadFromFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    console.error('[IntegrationStorage] Failed to load:', err.message);
    return {};
  }
}

function saveToFile(data) {
  ensureDataDir();
  try {
    fs.writeFileSync(DATA_TMP, JSON.stringify(data, null, 2), { encoding: 'utf8' });
    fs.renameSync(DATA_TMP, DATA_FILE);
  } catch (err) {
    console.error('[IntegrationStorage] Failed to save:', err.message);
  }
}

/* ==================== Encryption helpers ==================== */

function sealCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object') return null;
  return encrypt(JSON.stringify(credentials));
}

function openCredentials(record) {
  if (!record) return null;
  if (record.credentialsEnc) {
    const plain = decrypt(record.credentialsEnc);
    if (!plain) return null;
    try {
      return JSON.parse(plain);
    } catch {
      console.error('[IntegrationStorage] Failed to parse decrypted credentials');
      return null;
    }
  }
  // Legacy plaintext — migrate in place when present
  if (record.credentials && typeof record.credentials === 'object') {
    return record.credentials;
  }
  return null;
}

function toPersistedRecord(data) {
  const { credentials, credentialsEnc, ...rest } = data || {};
  const sealed = credentials ? sealCredentials(credentials) : (credentialsEnc || null);
  const out = {
    ...rest,
    updatedAt: new Date().toISOString(),
  };
  if (sealed) out.credentialsEnc = sealed;
  // Never persist plaintext credentials
  return out;
}

function hydrateRecord(record) {
  if (!record) return null;
  const credentials = openCredentials(record);
  const { credentialsEnc, ...rest } = record;
  return {
    ...rest,
    credentials: credentials || undefined,
  };
}

/* ==================== In-memory cache ==================== */

let cache = {};
let lastLoadTime = 0;
const CACHE_TTL_MS = 5000;

function ensureLoaded() {
  if (Date.now() - lastLoadTime > CACHE_TTL_MS) {
    cache = loadFromFile();
    lastLoadTime = Date.now();
  }
}

function migratePlaintextInCache() {
  let changed = false;
  for (const [wsId, providers] of Object.entries(cache)) {
    if (!providers || typeof providers !== 'object') continue;
    for (const [provider, rec] of Object.entries(providers)) {
      if (!rec || rec.credentialsEnc || !rec.credentials) continue;
      const sealed = sealCredentials(rec.credentials);
      if (!sealed) continue;
      const { credentials, ...rest } = rec;
      cache[wsId][provider] = { ...rest, credentialsEnc: sealed, updatedAt: new Date().toISOString() };
      changed = true;
      console.log(`[IntegrationStorage] Migrated plaintext credentials → encrypted (${wsId}/${provider})`);
    }
  }
  if (changed) saveToFile(cache);
}

/* ==================== CRUD ==================== */

const integrationStorage = {
  /** Get a single integration's data for a workspace (credentials decrypted in memory). */
  get(workspaceId, provider) {
    ensureLoaded();
    const ws = cache[workspaceId];
    if (!ws) return null;
    return hydrateRecord(ws[provider] || null);
  },

  /** Set (create or update) an integration for a workspace. Credentials encrypted on disk. */
  set(workspaceId, provider, data) {
    ensureLoaded();
    if (!cache[workspaceId]) cache[workspaceId] = {};
    cache[workspaceId][provider] = toPersistedRecord({
      ...data,
      // Preserve existing sealed creds if caller omitted credentials
      credentialsEnc: data.credentials ? undefined : (cache[workspaceId][provider]?.credentialsEnc),
    });
    saveToFile(cache);
    return hydrateRecord(cache[workspaceId][provider]);
  },

  /** Remove an integration from a workspace. */
  remove(workspaceId, provider) {
    ensureLoaded();
    const ws = cache[workspaceId];
    if (!ws || !ws[provider]) return false;
    delete ws[provider];
    saveToFile(cache);
    return true;
  },

  /** List all integrations for a workspace (credentials decrypted). */
  list(workspaceId) {
    ensureLoaded();
    const ws = cache[workspaceId] || {};
    const out = {};
    for (const [provider, rec] of Object.entries(ws)) {
      out[provider] = hydrateRecord(rec);
    }
    return out;
  },

  /** Return all workspace IDs that have any stored integration. */
  listAllWorkspaces() {
    ensureLoaded();
    return Object.keys(cache);
  },

  /** Migrate data from the old WhatsApp credential store. */
  migrateFromWhatsApp() {
    const whatsappFile = path.join(__dirname, '..', 'data', 'whatsapp_credentials.json');
    if (!fs.existsSync(whatsappFile)) return { migrated: 0 };
    try {
      const raw = fs.readFileSync(whatsappFile, 'utf8');
      if (!raw.trim()) return { migrated: 0 };
      const parsed = JSON.parse(raw);
      let count = 0;
      Object.entries(parsed).forEach(([workspaceId, creds]) => {
        if (creds.token && creds.phoneNumberId) {
          this.set(workspaceId, 'whatsapp', {
            type: 'api_key',
            connected: true,
            account: creds.phoneNumberId,
            credentials: {
              token: creds.token,
              phoneNumberId: creds.phoneNumberId,
              wabaId: creds.wabaId || null,
            },
            connectedAt: creds.updatedAt || new Date().toISOString(),
          });
          count++;
        }
      });
      console.log(`[IntegrationStorage] Migrated ${count} WhatsApp credential set(s)`);
      return { migrated: count };
    } catch (err) {
      console.error('[IntegrationStorage] WhatsApp migration failed:', err.message);
      return { migrated: 0, error: err.message };
    }
  },

  /** Check whether a workspace has a connected provider. */
  isConnected(workspaceId, provider) {
    const rec = this.get(workspaceId, provider);
    return !!(rec && rec.connected);
  },

  /** Get raw credentials (useful for service calls). Returns null if not connected. */
  getCredentials(workspaceId, provider) {
    const rec = this.get(workspaceId, provider);
    if (!rec || !rec.connected) return null;
    return rec.credentials || null;
  },

  /**
   * Resolve workspace by matching a provider credential field (e.g. SMS phone).
   * Used by Twilio webhooks where JWT is absent.
   */
  findWorkspaceByCredential(provider, predicate) {
    ensureLoaded();
    if (typeof predicate !== 'function') return null;
    for (const [wsId, providers] of Object.entries(cache)) {
      if (!providers || typeof providers !== 'object') continue;
      const rec = hydrateRecord(providers[provider]);
      if (!rec || !rec.connected) continue;
      try {
        if (predicate(rec.credentials || {}, rec)) return wsId;
      } catch (_) {
        /* ignore predicate errors */
      }
    }
    return null;
  },
};

// Auto-migrate WhatsApp credentials + encrypt any legacy plaintext on first load
integrationStorage.migrateFromWhatsApp();
ensureLoaded();
migratePlaintextInCache();

module.exports = integrationStorage;
