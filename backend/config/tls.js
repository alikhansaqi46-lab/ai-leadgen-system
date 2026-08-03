/**
 * Shared TLS options for outbound connections (SMTP, IMAP, Postgres).
 *
 * Default: verify certificates (rejectUnauthorized: true).
 * Escape hatch: TLS_INSECURE_ALLOW=true — only for local debugging.
 * Production refuses TLS_INSECURE_ALLOW (enforced by productionConfigLock).
 *
 * Optional trust anchors (appended to Node's root store, never replace):
 *   TLS_CA_FILE=/path/to/corp-root.pem
 *   NODE_EXTRA_CA_CERTS=/path/to/corp-root.pem  (also read here for pg/nodemailer)
 */

const fs = require('fs');
const tls = require('tls');

function tlsInsecureAllowed() {
  return String(process.env.TLS_INSECURE_ALLOW || '').toLowerCase() === 'true';
}

function loadExtraCaPems() {
  const path = require('path');
  const bundledSupabaseRoot = path.join(__dirname, '..', 'certs', 'supabase-root-2021.pem');
  const bundledSupabaseChain = path.join(__dirname, '..', 'certs', 'supabase-pooler-chain.pem');
  const paths = [
    process.env.TLS_CA_FILE,
    process.env.NODE_EXTRA_CA_CERTS,
    // Auto-trust Supabase pooler PKI when certs were extracted locally (rejectUnauthorized stays true).
    bundledSupabaseRoot,
    bundledSupabaseChain,
  ].filter(Boolean);
  const pems = [];
  const seen = new Set();
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) {
        if (p === process.env.TLS_CA_FILE || p === process.env.NODE_EXTRA_CA_CERTS) {
          console.warn('[TLS] CA file not found:', p);
        }
        continue;
      }
      const abs = path.resolve(p);
      if (seen.has(abs)) continue;
      seen.add(abs);
      pems.push(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      console.warn('[TLS] Failed to read CA file', p, err.message);
    }
  }
  return pems;
}

/**
 * Nodemailer / generic TLS / pg ssl options.
 * @returns {{ rejectUnauthorized: boolean, ca?: string[] }}
 */
function getTlsOptions() {
  if (tlsInsecureAllowed()) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[TLS] TLS_INSECURE_ALLOW is set in production — this is forbidden.');
    } else {
      console.warn('[TLS] TLS_INSECURE_ALLOW=true — certificate verification DISABLED (dev only).');
    }
    return { rejectUnauthorized: false };
  }

  const extra = loadExtraCaPems();
  if (extra.length) {
    // Merge system roots + extra PEMs so public CAs still work (Supabase, etc.)
    const roots = Array.isArray(tls.rootCertificates) ? tls.rootCertificates.slice() : [];
    return {
      rejectUnauthorized: true,
      ca: roots.concat(extra),
    };
  }
  return { rejectUnauthorized: true };
}

/**
 * Postgres `pg` Pool ssl option.
 * Returns false when SSL should be off; otherwise an ssl config object.
 */
function getPgSslConfig(connectionString) {
  const mode = (process.env.PGSSL || '').toLowerCase();
  if (mode === 'disable' || mode === 'false') return false;
  const useSsl = mode === 'require' || mode === 'true'
    || !/@(localhost|127\.0\.0\.1)[:/]/.test(connectionString || '');
  if (!useSsl) return false;
  return getTlsOptions();
}

/** True when an error looks like a corporate/MITM TLS trust failure. */
function isTlsTrustError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return (
    msg.includes('self-signed certificate')
    || msg.includes('unable to verify the first certificate')
    || msg.includes('certificate chain')
    || msg.includes('unable to get local issuer')
  );
}

module.exports = {
  getTlsOptions,
  getPgSslConfig,
  tlsInsecureAllowed,
  isTlsTrustError,
  loadExtraCaPems,
};
