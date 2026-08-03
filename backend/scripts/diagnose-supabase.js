/**
 * Diagnose Supabase connectivity (DB + JWKS). No secrets printed.
 * Run: node scripts/diagnose-supabase.js
 * Optional: node --use-system-ca scripts/diagnose-supabase.js
 */
require('dotenv').config();
const https = require('https');
const { getPool } = require('../config/db');
const { getPgSslConfig, loadExtraCaPems } = require('../config/tls');

function get(url) {
  return new Promise((resolve) => {
    https.get(url, { timeout: 15000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 400) }));
    }).on('error', (e) => resolve({ error: e.message }));
  });
}

(async () => {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const jwks = process.env.SUPABASE_JWKS_URL || `${base}/auth/v1/.well-known/jwks.json`;
  console.log('AUTH_MODE=', process.env.AUTH_MODE);
  console.log('STORAGE_DRIVER=', process.env.STORAGE_DRIVER);
  console.log('SUPABASE_URL=', base);
  console.log('extra CA files loaded=', loadExtraCaPems().length);
  const ssl = getPgSslConfig(process.env.DATABASE_URL || '');
  console.log('ssl.rejectUnauthorized=', ssl && ssl.rejectUnauthorized, 'ssl.caCount=', ssl && ssl.ca ? ssl.ca.length : 0);

  const j = await get(jwks);
  console.log('JWKS:', j.error || `OK status=${j.status} keys=${(() => { try { return JSON.parse(j.body).keys?.length; } catch { return '?'; } })()}`);

  try {
    const pool = getPool();
    const r = await pool.query('select now() as now, current_database() as db');
    console.log('DB:', 'OK', r.rows[0]);
    const u = await pool.query(
      `select id, email, email_verified, role,
              (password_hash is not null and length(password_hash) > 20) as has_bcrypt
       from users
       order by created_at nulls last
       limit 10`
    );
    console.log('USERS:', JSON.stringify(u.rows, null, 2));
    await pool.end();
  } catch (e) {
    console.log('DB:', 'FAIL', e.message);
    process.exitCode = 2;
  }
})();
