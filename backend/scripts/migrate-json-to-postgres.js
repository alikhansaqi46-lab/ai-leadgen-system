#!/usr/bin/env node
/**
 * Migrate existing leads into PostgreSQL.
 *
 * Source: File JSON (default backend/data/leads.json). Firestore import removed.
 *
 * Safety:
 *   - COPY-ONLY: never modifies or deletes the source data.
 *   - Idempotent: INSERT ... ON CONFLICT (id) DO NOTHING (re-runnable, no dupes).
 *   - --dry-run: report what WOULD happen, write nothing.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/migrate-json-to-postgres.js [--dry-run] [--file path]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../config/db');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
if (args.includes('--from-firestore')) {
  console.error('[ARCHIVED] --from-firestore removed. Migrate from JSON files only.');
  process.exit(1);
}
const fileArgIdx = args.indexOf('--file');
const FILE_PATH = fileArgIdx !== -1 && args[fileArgIdx + 1]
  ? path.resolve(args[fileArgIdx + 1])
  : path.join(__dirname, '..', 'data', 'leads.json');

function loadFromFile() {
  if (!fs.existsSync(FILE_PATH)) {
    console.warn('[migrate] No JSON file at', FILE_PATH);
    return [];
  }
  const raw = fs.readFileSync(FILE_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function normalize(lead) {
  // Preserve existing id/createdAt; only fill if missing.
  const id = lead.id ? String(lead.id) : uuidv4();
  const createdAt = lead.createdAt || new Date().toISOString();
  return { ...lead, id, createdAt };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  const source = loadFromFile();

  // De-dup by id within the source set (keep first occurrence).
  const byId = new Map();
  for (const lead of source.map(normalize)) {
    if (!byId.has(lead.id)) byId.set(lead.id, lead);
  }
  const leads = Array.from(byId.values());

  console.log(`[migrate] Source leads: ${source.length} (unique ids: ${leads.length})`);
  console.log(`[migrate] Source file: ${FILE_PATH}`);

  const pool = getPool();

  // How many already exist in the DB?
  const ids = leads.map((l) => l.id);
  let alreadyPresent = 0;
  if (ids.length > 0) {
    const existing = await pool.query('SELECT id FROM leads WHERE id = ANY($1)', [ids]);
    alreadyPresent = existing.rows.length;
  }
  const toInsert = leads.length - alreadyPresent;
  console.log(`[migrate] Already in DB: ${alreadyPresent} | Would insert: ${toInsert}`);

  if (leads[0]) {
    console.log('[migrate] Sample lead:', JSON.stringify({ id: leads[0].id, name: leads[0].name, phone: leads[0].phone }));
  }

  if (DRY_RUN) {
    console.log('[migrate] DRY RUN — no rows written.');
    await pool.end();
    return;
  }

  let inserted = 0;
  for (const lead of leads) {
    const result = await pool.query(
      `INSERT INTO leads (id, name, phone, country, niche, created_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        lead.id,
        lead.name || null,
        lead.phone || null,
        lead.country || null,
        lead.niche || null,
        lead.createdAt,
        JSON.stringify(lead),
      ]
    );
    inserted += result.rowCount;
  }

  const total = await pool.query('SELECT count(*)::int AS c FROM leads');
  console.log(`[migrate] Inserted ${inserted} new leads. Table total: ${total.rows[0].c}.`);
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] Failed:', err.message);
  process.exit(1);
});
