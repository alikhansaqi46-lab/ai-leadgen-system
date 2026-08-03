/**
 * One-time migration: add archived + pinned columns to conversations table.
 * Safe to re-run (uses IF NOT EXISTS).
 */

require('dotenv').config();
const { query } = require('../config/db');

async function migrate() {
  console.log('[Migration] Adding archived / pinned columns to conversations...');
  try {
    await query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false`);
    await query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false`);
    console.log('[Migration] ✅ Columns added successfully.');
  } catch (err) {
    console.error('[Migration] ❌ Failed:', err.message);
    process.exit(1);
  }
}

migrate();
