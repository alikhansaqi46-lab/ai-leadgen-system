#!/usr/bin/env node
/**
 * S2 backfill: ensure every existing lead row has a workspace_id and that the
 * JSONB `data` object carries a matching `workspaceId` field.
 *
 * The schema ALTER already defaults the new column to 'default', so pre-S2 rows
 * are valid immediately. This script additionally stamps `workspaceId` into the
 * `data` JSONB so the objects returned by getLeads() include the field.
 *
 * Idempotent — safe to re-run. Only touches Postgres (STORAGE_DRIVER=postgres).
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/backfill-workspace.js
 */

require('dotenv').config();
const { getPool } = require('../config/db');

const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || 'default';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  const pool = getPool();

  // 1. Any NULL workspace_id (shouldn't happen with the NOT NULL default, but be safe).
  const fixCol = await pool.query(
    `UPDATE leads SET workspace_id = $1 WHERE workspace_id IS NULL`,
    [DEFAULT_WORKSPACE_ID]
  );

  // 2. Stamp workspaceId into the JSONB data where missing, matching the column.
  const fixData = await pool.query(
    `UPDATE leads
        SET data = jsonb_set(data, '{workspaceId}', to_jsonb(workspace_id), true)
      WHERE NOT (data ? 'workspaceId')`
  );

  const total = await pool.query(`SELECT count(*)::int AS n FROM leads`);

  console.log(`[backfill] workspace_id column fixed on ${fixCol.rowCount} row(s)`);
  console.log(`[backfill] data.workspaceId stamped on ${fixData.rowCount} row(s)`);
  console.log(`[backfill] table total: ${total.rows[0].n} row(s)`);

  await pool.end();
}

main().catch((err) => {
  console.error('[backfill] Failed:', err.message);
  process.exit(1);
});
