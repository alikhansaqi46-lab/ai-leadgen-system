#!/usr/bin/env node
/**
 * Backfill Universal Contact Manager rows from existing leads.
 *
 * Safe to re-run. Applies schema.sql first when DATABASE_URL is set, then
 * normalizes email/phone/WhatsApp fields into contact methods.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool } = require('../config/db');
const leadStorage = require('../utils/leadStorage');
const contactStorage = require('../utils/contactStorage');

async function applySchemaIfNeeded() {
  if (!process.env.DATABASE_URL) return;
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await getPool().query(sql);
}

async function main() {
  await applySchemaIfNeeded();
  const workspaceId = process.env.MIGRATE_WORKSPACE_ID || process.env.DEFAULT_WORKSPACE_ID || 'default';
  const limit = parseInt(process.env.MIGRATE_CONTACT_LIMIT || '100000', 10);
  const leads = await leadStorage.getLeads({ workspaceId, limit });
  let methods = 0;
  for (const lead of leads) {
    const rows = await contactStorage.ensureLeadContacts(lead, { workspaceId });
    methods += rows.length;
  }
  console.log(`[migrate-contacts] workspace=${workspaceId} leads=${leads.length} contactMethodsAvailable=${methods}`);
  if (process.env.DATABASE_URL) await getPool().end();
}

main().catch(async (err) => {
  console.error('[migrate-contacts] Failed:', err.message);
  try {
    if (process.env.DATABASE_URL) await getPool().end();
  } catch {}
  process.exit(1);
});
