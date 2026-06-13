#!/usr/bin/env node
/**
 * Initialize the PostgreSQL schema for lead storage.
 *
 * Applies backend/db/schema.sql to the database pointed to by DATABASE_URL.
 * Idempotent (uses CREATE TABLE/INDEX IF NOT EXISTS) — safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/init-db.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool } = require('../config/db');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const pool = getPool();
  console.log('[init-db] Applying schema from', schemaPath);
  await pool.query(sql);
  console.log('[init-db] Schema applied successfully.');
  await pool.end();
}

main().catch((err) => {
  console.error('[init-db] Failed:', err.message);
  process.exit(1);
});
