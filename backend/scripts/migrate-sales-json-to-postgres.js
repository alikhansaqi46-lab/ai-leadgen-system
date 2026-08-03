/**
 * One-off migration: move sales documents / events / payments from the JSON
 * fallback files (backend/data/*.json) into Postgres, then empty the JSON files.
 * Safe to re-run: inserts use ON CONFLICT DO NOTHING.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { query } = require('../config/db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DOCS_FILE = path.join(DATA_DIR, 'sales_documents.json');
const EVENTS_FILE = path.join(DATA_DIR, 'sales_document_events.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'sales_payments.json');

function load(file) {
  if (!fs.existsSync(file)) return [];
  try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(p) ? p : []; } catch { return []; }
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

(async () => {
  const docs = load(DOCS_FILE);
  const events = load(EVENTS_FILE);
  const payments = load(PAYMENTS_FILE);
  console.log(`Found ${docs.length} docs, ${events.length} events, ${payments.length} payments in JSON files`);

  let inserted = 0;
  for (const d of docs) {
    const res = await query(
      `INSERT INTO sales_documents
       (id,workspace_id,doc_type,number,status,lead_id,contact_id,customer,company,line_items,currency,subtotal,discount_pct,discount_amount,tax_pct,tax_amount,shipping,total,notes,terms,payment_terms,template,valid_until,due_date,quote_id,pdf_path,ai_prompt,meta,amount_paid,created_at,updated_at,public_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
       ON CONFLICT (id) DO NOTHING`,
      [d.id, d.workspace_id, d.doc_type, d.number, d.status, d.lead_id || null, d.contact_id || null,
       JSON.stringify(d.customer || {}), JSON.stringify(d.company || {}), JSON.stringify(d.line_items || []),
       d.currency || 'MYR', num(d.subtotal), num(d.discount_pct), num(d.discount_amount), num(d.tax_pct), num(d.tax_amount),
       num(d.shipping), num(d.total), d.notes || '', d.terms || '', d.payment_terms || '', d.template || 'corporate',
       d.valid_until || null, d.due_date || null, d.quote_id || null, d.pdf_path || null, d.ai_prompt || null,
       JSON.stringify(d.meta || {}), num(d.amount_paid), d.created_at || new Date().toISOString(), d.updated_at || new Date().toISOString(),
       d.public_token || d.meta?.publicToken || null]
    );
    if (res.rowCount > 0) inserted += 1;
  }
  console.log(`Docs inserted: ${inserted} (skipped ${docs.length - inserted} already present)`);

  let evInserted = 0;
  for (const e of events) {
    const res = await query(
      `INSERT INTO sales_document_events (id,document_id,workspace_id,event_type,channel,payload,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [e.id, e.document_id, e.workspace_id, e.event_type, e.channel || null, JSON.stringify(e.payload || {}), e.created_at || new Date().toISOString()]
    );
    if (res.rowCount > 0) evInserted += 1;
  }
  console.log(`Events inserted: ${evInserted}`);

  let payInserted = 0;
  for (const p of payments) {
    const res = await query(
      `INSERT INTO sales_payments (id,invoice_id,workspace_id,amount,currency,method,status,external_id,paid_at,meta,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.invoiceId, p.workspaceId, num(p.amount), p.currency || 'MYR', p.method || 'manual', p.status || 'completed',
       p.externalId || null, p.paidAt || new Date().toISOString(), JSON.stringify(p.meta || {}), p.createdAt || new Date().toISOString()]
    );
    if (res.rowCount > 0) payInserted += 1;
  }
  console.log(`Payments inserted: ${payInserted}`);

  // Empty the JSON files (keep a timestamped backup)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const f of [DOCS_FILE, EVENTS_FILE, PAYMENTS_FILE]) {
    if (fs.existsSync(f) && load(f).length) {
      fs.copyFileSync(f, `${f}.${stamp}.bak`);
      fs.writeFileSync(f, '[]');
      console.log('Emptied (backup created):', path.basename(f));
    }
  }
  console.log('Migration complete.');
  process.exit(0);
})().catch((e) => { console.error('MIGRATION FAILED:', e.message); process.exit(1); });
