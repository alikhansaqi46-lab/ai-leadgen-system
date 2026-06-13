/**
 * PostgreSQL connection pool (lazy).
 *
 * Used only when STORAGE_DRIVER=postgres. A single shared Pool is created the
 * first time getPool() is called, from the DATABASE_URL connection string
 * (e.g. a Supabase Postgres URL).
 *
 * SSL: enabled automatically for non-local hosts (Supabase requires SSL).
 * Override with PGSSL=disable / PGSSL=require.
 */

let Pool;
try {
  ({ Pool } = require('pg'));
} catch (err) {
  // pg is only required when STORAGE_DRIVER=postgres. Defer the error until use.
  Pool = null;
}

let pool = null;

function shouldUseSsl(connectionString) {
  const mode = (process.env.PGSSL || '').toLowerCase();
  if (mode === 'disable' || mode === 'false') return false;
  if (mode === 'require' || mode === 'true') return true;
  // Auto: local connections don't need SSL; everything else does.
  return !/@(localhost|127\.0\.0\.1)[:/]/.test(connectionString || '');
}

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
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false,
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
