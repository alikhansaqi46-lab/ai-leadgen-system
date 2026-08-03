/**
 * PostgreSQL connection pool (lazy).
 *
 * Used only when STORAGE_DRIVER=postgres. A single shared Pool is created the
 * first time getPool() is called, from the DATABASE_URL connection string
 * (e.g. a Supabase Postgres URL).
 *
 * SSL: enabled automatically for non-local hosts (Supabase requires SSL).
 * Override with PGSSL=disable / PGSSL=require.
 * Certificate verification follows config/tls.js (TLS_INSECURE_ALLOW escape hatch).
 */

const { getPgSslConfig } = require('./tls');

let Pool;
try {
  ({ Pool } = require('pg'));
} catch (err) {
  // pg is only required when STORAGE_DRIVER=postgres. Defer the error until use.
  Pool = null;
}

let pool = null;

function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (required for STORAGE_DRIVER=postgres)');
  }
  if (!Pool) {
    throw new Error("The 'pg' package is not installed. Run `npm install pg` in backend/.");
  }

  pool = new Pool({
    connectionString,
    ssl: getPgSslConfig(connectionString),
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
  });

  pool.on('error', (err) => {
    console.error('[DB] Unexpected idle client error:', err.message);
  });

  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

module.exports = { getPool, query };
