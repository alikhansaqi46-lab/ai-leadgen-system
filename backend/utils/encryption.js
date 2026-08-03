/**
 * AES-256-GCM encryption for sensitive data (API keys, tokens).
 *
 * Uses ENCRYPTION_KEY env var (32-byte hex string).
 * If ENCRYPTION_KEY is missing, falls back to a derived key from JWT_SECRET
 * with a strong warning logged. For production, always set ENCRYPTION_KEY.
 *
 * Usage:
 *   const { encrypt, decrypt } = require('./utils/encryption');
 *   const cipher = encrypt(plainText);
 *   const plain = decrypt(cipher);
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

let cachedKey = null;
let warnedMissingEncryptionKey = false;

function getKey() {
  if (cachedKey) return cachedKey;
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) {
    if (envKey.length !== 64) {
      console.warn('[Encryption] ENCRYPTION_KEY must be a 64-character hex string (256 bits).');
    }
    cachedKey = Buffer.from(envKey, 'hex');
    return cachedKey;
  }
  // Derive a fallback key from JWT_SECRET — NOT for production, but keeps things running
  const fallback = process.env.JWT_SECRET || 'lf-local-secret-change-in-production';
  if (!warnedMissingEncryptionKey) {
    warnedMissingEncryptionKey = true;
    console.warn('[Encryption] ENCRYPTION_KEY is not set. Deriving key from JWT_SECRET. Set ENCRYPTION_KEY for production.');
  }
  cachedKey = crypto.scryptSync(fallback, 'leadflow-salt', 32);
  return cachedKey;
}

/**
 * Encrypt a plaintext string.
 * Returns base64-encoded string: iv + tag + ciphertext.
 */
function encrypt(plainText) {
  if (!plainText || typeof plainText !== 'string') return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, tag, encrypted]);
  return combined.toString('base64');
}

/**
 * Decrypt a base64-encoded ciphertext string (iv + tag + ciphertext).
 */
function decrypt(cipherText) {
  if (!cipherText || typeof cipherText !== 'string') return null;
  try {
    const combined = Buffer.from(cipherText, 'base64');
    if (combined.length < IV_LENGTH + TAG_LENGTH) {
      console.error('[Encryption] Ciphertext too short — possibly corrupted.');
      return null;
    }
    const iv = combined.slice(0, IV_LENGTH);
    const tag = combined.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = combined.slice(IV_LENGTH + TAG_LENGTH);
    const key = getKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    console.error('[Encryption] Decryption failed:', err.message);
    return null;
  }
}

module.exports = { encrypt, decrypt };
