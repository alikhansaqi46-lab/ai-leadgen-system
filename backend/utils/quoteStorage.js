/**
 * Quotes & Invoices storage — workspace-scoped sales documents.
 */
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DOCS_FILE = path.join(DATA_DIR, 'sales_documents.json');
const EVENTS_FILE = path.join(DATA_DIR, 'sales_document_events.json');
const PROFILE_FILE = path.join(DATA_DIR, 'workspace_billing_profiles.json');
const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || 'default';

const QUOTE_STATUSES = ['draft','sent','viewed','negotiating','accepted','rejected','expired','converted'];
const INVOICE_STATUSES = ['draft','sent','paid','partially_paid','unpaid','overdue','cancelled'];
const TEMPLATES = ['corporate','modern','minimal','medical','construction','manufacturing','real_estate'];

let forceJsonFallback = String(process.env.QUOTES_JSON_FALLBACK || '').toLowerCase() === 'true';
let tablesReady = false;

function resolveDriver() {
  if (forceJsonFallback) return 'json';
  const d = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  if (d === 'postgres' || d === 'pg') return 'postgres';
  if (d === 'json' || d === 'file') return 'json';
  return process.env.DATABASE_URL ? 'postgres' : 'json';
}
function enableJsonFallback(err) {
  const msg = err && err.message ? err.message : String(err || '');
  // Never silently switch stores when Postgres is the explicitly configured driver.
  // A transient DB error must surface loudly instead of writing quotes to a divergent JSON file.
  const configured = (process.env.STORAGE_DRIVER || '').toLowerCase();
  if (configured === 'postgres' || configured === 'pg') {
    console.error('[QuoteStorage] Postgres error (no JSON fallback allowed):', msg);
    return false;
  }
  if (/certificate|self-signed|ECONNREFUSED|ENOTFOUND|does not exist|relation .* does not exist/i.test(msg)) {
    if (!forceJsonFallback) { console.warn('[QuoteStorage] JSON fallback:', msg); forceJsonFallback = true; }
    return true;
  }
  return false;
}
function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function load(file) {
  ensureDir();
  if (!fs.existsSync(file)) return [];
  try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(p) ? p : []; } catch { return []; }
}
function save(file, rows) { ensureDir(); fs.writeFileSync(file, JSON.stringify(rows, null, 2)); }
function loadProfiles() {
  ensureDir();
  if (!fs.existsSync(PROFILE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveProfiles(map) { ensureDir(); fs.writeFileSync(PROFILE_FILE, JSON.stringify(map, null, 2)); }
function asJson(v, fb) {
  if (v == null) return fb;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fb; } }
  return v;
}
function num(v, d = 0) {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  if (typeof v === 'string') {
    // Tolerate currency-formatted values ("RM50", "MYR 1,200.50", "$99")
    const cleaned = v.replace(/[^0-9.\-]/g, '');
    const m = parseFloat(cleaned);
    if (Number.isFinite(m)) return m;
  }
  return d;
}

function mapDoc(r) {
  return {
    id: r.id,
    workspaceId: r.workspace_id || r.workspaceId,
    docType: r.doc_type || r.docType,
    number: r.number,
    status: r.status,
    leadId: r.lead_id || r.leadId || null,
    contactId: r.contact_id || r.contactId || null,
    customer: asJson(r.customer, {}),
    company: asJson(r.company, {}),
    lineItems: asJson(r.line_items || r.lineItems, []),
    currency: r.currency || 'MYR',
    subtotal: num(r.subtotal),
    discountPct: num(r.discount_pct ?? r.discountPct),
    discountAmount: num(r.discount_amount ?? r.discountAmount),
    taxPct: num(r.tax_pct ?? r.taxPct),
    taxAmount: num(r.tax_amount ?? r.taxAmount),
    shipping: num(r.shipping),
    total: num(r.total),
    notes: r.notes || '',
    terms: r.terms || '',
    paymentTerms: r.payment_terms || r.paymentTerms || '',
    template: r.template || 'corporate',
    validUntil: r.valid_until || r.validUntil || null,
    dueDate: r.due_date || r.dueDate || null,
    quoteId: r.quote_id || r.quoteId || null,
    pdfPath: r.pdf_path || r.pdfPath || null,
    aiPrompt: r.ai_prompt || r.aiPrompt || null,
    meta: asJson(r.meta, {}),
    amountPaid: num(r.amount_paid ?? r.amountPaid),
    createdAt: r.created_at || r.createdAt,
    updatedAt: r.updated_at || r.updatedAt,
    sentAt: r.sent_at || r.sentAt || null,
    viewedAt: r.viewed_at || r.viewedAt || null,
    acceptedAt: r.accepted_at || r.acceptedAt || null,
    paidAt: r.paid_at || r.paidAt || null,
    publicToken: r.public_token || r.publicToken || null,
  };
}
function mapEvent(r) {
  return {
    id: r.id,
    documentId: r.document_id || r.documentId,
    workspaceId: r.workspace_id || r.workspaceId,
    eventType: r.event_type || r.eventType,
    channel: r.channel || null,
    payload: asJson(r.payload, {}),
    createdAt: r.created_at || r.createdAt,
  };
}
function mapProfile(r) {
  if (!r) return null;
  return {
    workspaceId: r.workspace_id || r.workspaceId,
    companyName: r.company_name || r.companyName || '',
    logoUrl: r.logo_url || r.logoUrl || '',
    signatureUrl: r.signature_url || r.signatureUrl || '',
    address: r.address || '', city: r.city || '', country: r.country || '',
    phone: r.phone || '', email: r.email || '', website: r.website || '',
    taxId: r.tax_id || r.taxId || '',
    defaultCurrency: r.default_currency || r.defaultCurrency || 'MYR',
    defaultTaxPct: num(r.default_tax_pct ?? r.defaultTaxPct),
    defaultTerms: r.default_terms || r.defaultTerms || '',
    paymentTerms: r.payment_terms || r.paymentTerms || '',
    headerText: r.header_text || r.headerText || '',
    footerText: r.footer_text || r.footerText || '',
    meta: asJson(r.meta, {}),
    createdAt: r.created_at || r.createdAt,
    updatedAt: r.updated_at || r.updatedAt,
  };
}

async function ensureTables() {
  if (tablesReady || resolveDriver() !== 'postgres') return;
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'quotes_invoices.sql'), 'utf8');
    await query(sql);
    // Existing DBs: add share token before unique index
    await query('ALTER TABLE sales_documents ADD COLUMN IF NOT EXISTS public_token TEXT');
    await query('CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_docs_public_token ON sales_documents (public_token) WHERE public_token IS NOT NULL');
    tablesReady = true;
  } catch (err) {
    // Retry column migration even if full SQL file partially failed
    try {
      await query('ALTER TABLE sales_documents ADD COLUMN IF NOT EXISTS public_token TEXT');
      await query('CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_docs_public_token ON sales_documents (public_token) WHERE public_token IS NOT NULL');
      tablesReady = true;
      forceJsonFallback = false;
      return;
    } catch (err2) {
      if (!enableJsonFallback(err2)) console.warn('[QuoteStorage] ensureTables:', err.message, err2.message);
    }
  }
}

function computeTotals({ lineItems = [], discountPct = 0, discountAmount = 0, taxPct = 0, shipping = 0 }) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const dPct = num(discountPct);

  // Document-level % discount is authoritative. Do not also apply line discounts
  // (AI often duplicates the same discount on both levels → double discount).
  let subtotal = 0;
  const normalized = items.map((it, i) => {
    const qty = num(it.quantity ?? it.qty, 1);
    const unit = num(it.unitPrice ?? it.unit_price ?? it.price);
    const rawLineDisc = num(it.discount);
    const lineDisc = dPct > 0 ? 0 : rawLineDisc;
    const lineTotal = Math.max(0, qty * unit - lineDisc);
    subtotal += lineTotal;
    return {
      id: it.id || `li_${i + 1}`,
      description: String(it.description || it.name || 'Item'),
      quantity: qty,
      unitPrice: unit,
      discount: lineDisc,
      amount: Math.round(lineTotal * 100) / 100,
      unit: it.unit || '',
    };
  });
  subtotal = Math.round(subtotal * 100) / 100;

  // Prefer % when set — ignore stale/absolute discountAmount from AI or prior bad saves.
  const discountFromPct = Math.round(subtotal * (dPct / 100) * 100) / 100;
  const dAmtInput = num(discountAmount);
  const discountAmountFinal = dPct > 0
    ? discountFromPct
    : (dAmtInput > 0 ? dAmtInput : 0);

  const taxable = Math.max(0, subtotal - discountAmountFinal);
  const taxAmount = Math.round(taxable * (num(taxPct) / 100) * 100) / 100;
  const ship = num(shipping);
  const total = Math.round((taxable + taxAmount + ship) * 100) / 100;
  return {
    lineItems: normalized,
    subtotal,
    discountPct: dPct,
    discountAmount: discountAmountFinal,
    taxPct: num(taxPct),
    taxAmount,
    shipping: ship,
    total,
  };
}

async function nextNumber(workspaceId, docType) {
  const prefix = docType === 'invoice' ? 'INV' : 'QT';
  const year = new Date().getFullYear();
  if (resolveDriver() === 'postgres') {
    try {
      await ensureTables();
      const { rows } = await query(
        `SELECT COUNT(*)::int AS n FROM sales_documents WHERE workspace_id=$1 AND doc_type=$2 AND EXTRACT(YEAR FROM created_at)=$3`,
        [workspaceId, docType, year]
      );
      return `${prefix}-${year}-${String((rows[0]?.n || 0) + 1).padStart(4, '0')}`;
    } catch (err) { if (!enableJsonFallback(err)) throw err; }
  }
  const docs = load(DOCS_FILE).filter((d) => (d.workspaceId || d.workspace_id) === workspaceId && (d.docType || d.doc_type) === docType);
  return `${prefix}-${year}-${String(docs.length + 1).padStart(4, '0')}`;
}

const quoteStorage = {
  QUOTE_STATUSES, INVOICE_STATUSES, TEMPLATES, computeTotals, ensureTables,

  async getBillingProfile(workspaceId) {
    await ensureTables();
    const empty = {
      workspaceId, companyName: '', logoUrl: '', signatureUrl: '', address: '', city: '', country: '',
      phone: '', email: '', website: '', taxId: '', defaultCurrency: 'MYR', defaultTaxPct: 0,
      defaultTerms: '', paymentTerms: 'Payment due within 14 days.', headerText: '', footerText: 'Thank you for your business.',
    };
    if (resolveDriver() === 'postgres') {
      try {
        const { rows } = await query('SELECT * FROM workspace_billing_profiles WHERE workspace_id=$1 LIMIT 1', [workspaceId]);
        return mapProfile(rows[0]) || empty;
      } catch (err) { if (!enableJsonFallback(err)) throw err; }
    }
    return mapProfile(loadProfiles()[workspaceId]) || empty;
  },

  async upsertBillingProfile(workspaceId, patch = {}) {
    await ensureTables();
    const cur = await this.getBillingProfile(workspaceId);
    const next = { ...cur, ...patch, workspaceId, updatedAt: new Date().toISOString(), createdAt: cur.createdAt || new Date().toISOString() };
    if (resolveDriver() === 'postgres') {
      try {
        await query(
          `INSERT INTO workspace_billing_profiles
           (workspace_id,company_name,logo_url,signature_url,address,city,country,phone,email,website,tax_id,default_currency,default_tax_pct,default_terms,payment_terms,header_text,footer_text,meta,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
           ON CONFLICT (workspace_id) DO UPDATE SET
             company_name=EXCLUDED.company_name, logo_url=EXCLUDED.logo_url, signature_url=EXCLUDED.signature_url,
             address=EXCLUDED.address, city=EXCLUDED.city, country=EXCLUDED.country, phone=EXCLUDED.phone, email=EXCLUDED.email,
             website=EXCLUDED.website, tax_id=EXCLUDED.tax_id, default_currency=EXCLUDED.default_currency,
             default_tax_pct=EXCLUDED.default_tax_pct, default_terms=EXCLUDED.default_terms, payment_terms=EXCLUDED.payment_terms,
             header_text=EXCLUDED.header_text, footer_text=EXCLUDED.footer_text, meta=EXCLUDED.meta, updated_at=EXCLUDED.updated_at`,
          [workspaceId, next.companyName||null, next.logoUrl||null, next.signatureUrl||null, next.address||null, next.city||null, next.country||null,
           next.phone||null, next.email||null, next.website||null, next.taxId||null, next.defaultCurrency||'MYR', num(next.defaultTaxPct),
           next.defaultTerms||null, next.paymentTerms||null, next.headerText||null, next.footerText||null, JSON.stringify(next.meta||{}), next.createdAt, next.updatedAt]
        );
        return this.getBillingProfile(workspaceId);
      } catch (err) { if (!enableJsonFallback(err)) throw err; }
    }
    const map = loadProfiles();
    map[workspaceId] = {
      workspace_id: workspaceId, company_name: next.companyName, logo_url: next.logoUrl, signature_url: next.signatureUrl,
      address: next.address, city: next.city, country: next.country, phone: next.phone, email: next.email, website: next.website,
      tax_id: next.taxId, default_currency: next.defaultCurrency, default_tax_pct: next.defaultTaxPct, default_terms: next.defaultTerms,
      payment_terms: next.paymentTerms, header_text: next.headerText, footer_text: next.footerText, meta: next.meta||{},
      created_at: next.createdAt, updated_at: next.updatedAt,
    };
    saveProfiles(map);
    return this.getBillingProfile(workspaceId);
  },

  async list({ workspaceId, docType, status, leadId, q, limit = 50, offset = 0 } = {}) {
    await ensureTables();
    const lim = Math.min(Number(limit) || 50, 200);
    const off = Math.max(0, Number(offset) || 0);
    if (resolveDriver() === 'postgres') {
      try {
        const clauses = ['workspace_id = $1']; const params = [workspaceId];
        if (docType) { params.push(docType); clauses.push(`doc_type = $${params.length}`); }
        if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
        if (leadId) { params.push(leadId); clauses.push(`lead_id = $${params.length}`); }
        if (q) {
          params.push(`%${String(q).toLowerCase()}%`);
          clauses.push(`(LOWER(number) LIKE $${params.length} OR LOWER(COALESCE(customer->>'name','')) LIKE $${params.length} OR LOWER(COALESCE(customer->>'company','')) LIKE $${params.length})`);
        }
        const where = clauses.join(' AND ');
        const countRes = await query(`SELECT COUNT(*)::int AS n FROM sales_documents WHERE ${where}`, params);
        params.push(lim, off);
        const { rows } = await query(`SELECT * FROM sales_documents WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`, params);
        return { items: rows.map(mapDoc), total: countRes.rows[0]?.n || 0 };
      } catch (err) { if (!enableJsonFallback(err)) throw err; }
    }
    let rows = load(DOCS_FILE).map(mapDoc).filter((d) => d.workspaceId === workspaceId);
    if (docType) rows = rows.filter((d) => d.docType === docType);
    if (status) rows = rows.filter((d) => d.status === status);
    if (leadId) rows = rows.filter((d) => d.leadId === leadId);
    if (q) {
      const s = String(q).toLowerCase();
      rows = rows.filter((d) => String(d.number||'').toLowerCase().includes(s) || String(d.customer?.name||'').toLowerCase().includes(s) || String(d.customer?.company||'').toLowerCase().includes(s));
    }
    rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return { items: rows.slice(off, off + lim), total: rows.length };
  },

  async get(id, workspaceId) {
    await ensureTables();
    if (resolveDriver() === 'postgres') {
      try {
        const { rows } = await query('SELECT * FROM sales_documents WHERE id=$1 AND workspace_id=$2 LIMIT 1', [id, workspaceId]);
        return rows[0] ? mapDoc(rows[0]) : null;
      } catch (err) { if (!enableJsonFallback(err)) throw err; }
    }
    const row = load(DOCS_FILE).find((d) => d.id === id && (d.workspaceId || d.workspace_id) === workspaceId);
    return row ? mapDoc(row) : null;
  },

  async getByPublicToken(token) {
    const t = String(token || '').trim();
    if (!t) return null;
    await ensureTables();
    if (resolveDriver() === 'postgres') {
      try {
        const { rows } = await query('SELECT * FROM sales_documents WHERE public_token=$1 LIMIT 1', [t]);
        return rows[0] ? mapDoc(rows[0]) : null;
      } catch (err) { if (!enableJsonFallback(err)) throw err; }
    }
    const row = load(DOCS_FILE).find((d) => (d.publicToken || d.public_token) === t);
    return row ? mapDoc(row) : null;
  },

  async ensurePublicToken(id, workspaceId) {
    const cur = await this.get(id, workspaceId);
    if (!cur) return null;
    if (cur.publicToken) return cur;
    const token = `sh_${uuidv4().replace(/-/g, '')}`;
    if (resolveDriver() === 'postgres') {
      try {
        await query('UPDATE sales_documents SET public_token=$3, updated_at=NOW() WHERE id=$1 AND workspace_id=$2', [id, workspaceId, token]);
        return this.get(id, workspaceId);
      } catch (err) { if (!enableJsonFallback(err)) throw err; }
    }
    return this.update(id, workspaceId, { publicToken: token, meta: { ...(cur.meta || {}), publicToken: token } });
  },

  async addPayment({ invoiceId, workspaceId, amount, currency = 'MYR', method = 'manual', status = 'completed', externalId = null, meta = {} }) {
    const id = `pay_${uuidv4()}`;
    const now = new Date().toISOString();
    const row = { id, invoiceId, workspaceId, amount: num(amount), currency, method, status, externalId, paidAt: now, meta, createdAt: now };
    if (resolveDriver() === 'postgres') {
      try {
        await ensureTables();
        await query(
          `INSERT INTO sales_payments (id,invoice_id,workspace_id,amount,currency,method,status,external_id,paid_at,meta,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, invoiceId, workspaceId, row.amount, currency, method, status, externalId, now, JSON.stringify(meta || {}), now]
        );
        return row;
      } catch (err) { if (!enableJsonFallback(err)) throw err; }
    }
    const file = path.join(DATA_DIR, 'sales_payments.json');
    const rows = load(file);
    rows.push(row);
    save(file, rows);
    return row;
  },

  async create(input, workspaceId) {
    await ensureTables();
    const docType = input.docType === 'invoice' ? 'invoice' : 'quote';
    const totals = computeTotals(input);
    const now = new Date().toISOString();
    const number = input.number || await nextNumber(workspaceId, docType);
    const row = {
      id: input.id || `${docType === 'invoice' ? 'inv' : 'qt'}_${uuidv4()}`,
      workspaceId, docType, number, status: input.status || 'draft',
      leadId: input.leadId || null, contactId: input.contactId || null,
      customer: input.customer || {}, company: input.company || {},
      lineItems: totals.lineItems, currency: input.currency || 'MYR',
      subtotal: totals.subtotal, discountPct: totals.discountPct, discountAmount: totals.discountAmount,
      taxPct: totals.taxPct, taxAmount: totals.taxAmount, shipping: totals.shipping, total: totals.total,
      notes: input.notes || '', terms: input.terms || '', paymentTerms: input.paymentTerms || '',
      template: TEMPLATES.includes(input.template) ? input.template : 'corporate',
      validUntil: input.validUntil || null, dueDate: input.dueDate || null, quoteId: input.quoteId || null,
      pdfPath: null, aiPrompt: input.aiPrompt || null, meta: input.meta || {}, amountPaid: num(input.amountPaid),
      createdAt: now, updatedAt: now, sentAt: null, viewedAt: null, acceptedAt: null, paidAt: null,
    };
    if (resolveDriver() === 'postgres') {
      try {
        await query(
          `INSERT INTO sales_documents
           (id,workspace_id,doc_type,number,status,lead_id,contact_id,customer,company,line_items,currency,subtotal,discount_pct,discount_amount,tax_pct,tax_amount,shipping,total,notes,terms,payment_terms,template,valid_until,due_date,quote_id,pdf_path,ai_prompt,meta,amount_paid,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$30)`,
          [row.id, workspaceId, row.docType, row.number, row.status, row.leadId, row.contactId,
           JSON.stringify(row.customer), JSON.stringify(row.company), JSON.stringify(row.lineItems),
           row.currency, row.subtotal, row.discountPct, row.discountAmount, row.taxPct, row.taxAmount, row.shipping, row.total,
           row.notes, row.terms, row.paymentTerms, row.template, row.validUntil, row.dueDate, row.quoteId, row.pdfPath, row.aiPrompt,
           JSON.stringify(row.meta), row.amountPaid, now]
        );
        await this.addEvent(row.id, workspaceId, 'created', null, { docType, number });
        return this.get(row.id, workspaceId);
      } catch (err) { if (!enableJsonFallback(err)) throw err; }
    }
    const docs = load(DOCS_FILE);
    docs.push({
      id: row.id, workspace_id: workspaceId, doc_type: row.docType, number: row.number, status: row.status,
      lead_id: row.leadId, contact_id: row.contactId, customer: row.customer, company: row.company, line_items: row.lineItems,
      currency: row.currency, subtotal: row.subtotal, discount_pct: row.discountPct, discount_amount: row.discountAmount,
      tax_pct: row.taxPct, tax_amount: row.taxAmount, shipping: row.shipping, total: row.total, notes: row.notes, terms: row.terms,
      payment_terms: row.paymentTerms, template: row.template, valid_until: row.validUntil, due_date: row.dueDate, quote_id: row.quoteId,
      pdf_path: row.pdfPath, ai_prompt: row.aiPrompt, meta: row.meta, amount_paid: row.amountPaid, created_at: now, updated_at: now,
    });
    save(DOCS_FILE, docs);
    await this.addEvent(row.id, workspaceId, 'created', null, { docType, number });
    return this.get(row.id, workspaceId);
  },

  async update(id, workspaceId, patch = {}) {
    const cur = await this.get(id, workspaceId);
    if (!cur) return null;
    const merged = { ...cur, ...patch };
    const totals = computeTotals({
      lineItems: merged.lineItems,
      discountPct: merged.discountPct,
      discountAmount: patch.discountAmount != null ? patch.discountAmount : (patch.discountPct != null ? 0 : merged.discountAmount),
      taxPct: merged.taxPct, shipping: merged.shipping,
    });
    const now = new Date().toISOString();
    const next = { ...merged, ...totals, template: TEMPLATES.includes(merged.template) ? merged.template : cur.template, updatedAt: now };
    if (resolveDriver() === 'postgres') {
      try {
        await query(
          `UPDATE sales_documents SET status=$3,lead_id=$4,contact_id=$5,customer=$6,company=$7,line_items=$8,currency=$9,subtotal=$10,discount_pct=$11,discount_amount=$12,tax_pct=$13,tax_amount=$14,shipping=$15,total=$16,notes=$17,terms=$18,payment_terms=$19,template=$20,valid_until=$21,due_date=$22,quote_id=$23,pdf_path=$24,ai_prompt=$25,meta=$26,amount_paid=$27,updated_at=$28,sent_at=$29,viewed_at=$30,accepted_at=$31,paid_at=$32,public_token=COALESCE($33, public_token) WHERE id=$1 AND workspace_id=$2`,
          [id, workspaceId, next.status, next.leadId, next.contactId, JSON.stringify(next.customer||{}), JSON.stringify(next.company||{}), JSON.stringify(next.lineItems),
           next.currency, next.subtotal, next.discountPct, next.discountAmount, next.taxPct, next.taxAmount, next.shipping, next.total,
           next.notes, next.terms, next.paymentTerms, next.template, next.validUntil, next.dueDate, next.quoteId, next.pdfPath, next.aiPrompt,
           JSON.stringify(next.meta||{}), next.amountPaid, now, next.sentAt, next.viewedAt, next.acceptedAt, next.paidAt, next.publicToken || null]
        );
        return this.get(id, workspaceId);
      } catch (err) { if (!enableJsonFallback(err)) throw err; }
    }
    const docs = load(DOCS_FILE);
    const idx = docs.findIndex((d) => d.id === id && (d.workspaceId || d.workspace_id) === workspaceId);
    if (idx < 0) return null;
    docs[idx] = {
      ...docs[idx], status: next.status, lead_id: next.leadId, contact_id: next.contactId, customer: next.customer, company: next.company,
      line_items: next.lineItems, currency: next.currency, subtotal: next.subtotal, discount_pct: next.discountPct, discount_amount: next.discountAmount,
      tax_pct: next.taxPct, tax_amount: next.taxAmount, shipping: next.shipping, total: next.total, notes: next.notes, terms: next.terms,
      payment_terms: next.paymentTerms, template: next.template, valid_until: next.validUntil, due_date: next.dueDate, quote_id: next.quoteId,
      pdf_path: next.pdfPath, ai_prompt: next.aiPrompt, meta: next.meta, amount_paid: next.amountPaid, updated_at: now,
      sent_at: next.sentAt, viewed_at: next.viewedAt, accepted_at: next.acceptedAt, paid_at: next.paidAt,
      public_token: next.publicToken || docs[idx].public_token || docs[idx].publicToken || null,
    };
    save(DOCS_FILE, docs);
    return this.get(id, workspaceId);
  },

  async remove(id, workspaceId) {
    const cur = await this.get(id, workspaceId);
    if (!cur) return false;
    if (resolveDriver() === 'postgres') {
      try {
        await query('DELETE FROM sales_document_events WHERE document_id=$1 AND workspace_id=$2', [id, workspaceId]);
        await query('DELETE FROM sales_payments WHERE invoice_id=$1 AND workspace_id=$2', [id, workspaceId]);
        await query('DELETE FROM sales_documents WHERE id=$1 AND workspace_id=$2', [id, workspaceId]);
        return true;
      } catch (err) { if (!enableJsonFallback(err)) throw err; }
    }
    save(DOCS_FILE, load(DOCS_FILE).filter((d) => !(d.id === id && (d.workspaceId || d.workspace_id) === workspaceId)));
    save(EVENTS_FILE, load(EVENTS_FILE).filter((e) => e.documentId !== id && e.document_id !== id));
    return true;
  },

  async addEvent(documentId, workspaceId, eventType, channel = null, payload = {}) {
    const row = { id: `sde_${uuidv4()}`, documentId, workspaceId, eventType, channel, payload, createdAt: new Date().toISOString() };
    if (resolveDriver() === 'postgres') {
      try {
        await ensureTables();
        await query(`INSERT INTO sales_document_events (id,document_id,workspace_id,event_type,channel,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [row.id, documentId, workspaceId, eventType, channel, JSON.stringify(payload||{}), row.createdAt]);
        return mapEvent(row);
      } catch (err) { if (!enableJsonFallback(err)) throw err; }
    }
    const events = load(EVENTS_FILE);
    events.push({ id: row.id, document_id: documentId, workspace_id: workspaceId, event_type: eventType, channel, payload, created_at: row.createdAt });
    save(EVENTS_FILE, events);
    return mapEvent(row);
  },

  async listEvents(documentId, workspaceId) {
    if (resolveDriver() === 'postgres') {
      try {
        await ensureTables();
        const { rows } = await query(`SELECT * FROM sales_document_events WHERE document_id=$1 AND workspace_id=$2 ORDER BY created_at ASC`, [documentId, workspaceId]);
        return rows.map(mapEvent);
      } catch (err) { if (!enableJsonFallback(err)) throw err; }
    }
    return load(EVENTS_FILE).map(mapEvent).filter((e) => e.documentId === documentId && e.workspaceId === workspaceId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  },

  async stats(workspaceId) {
    const { items } = await this.list({ workspaceId, limit: 500 });
    const quotes = items.filter((d) => d.docType === 'quote');
    const invoices = items.filter((d) => d.docType === 'invoice');
    const sum = (arr) => arr.reduce((s, d) => s + num(d.total), 0);
    return {
      quotesTotal: quotes.length,
      quotesDraft: quotes.filter((d) => d.status === 'draft').length,
      quotesSent: quotes.filter((d) => ['sent','viewed','negotiating'].includes(d.status)).length,
      quotesAccepted: quotes.filter((d) => d.status === 'accepted' || d.status === 'converted').length,
      invoicesTotal: invoices.length,
      invoicesUnpaid: invoices.filter((d) => ['sent','unpaid','overdue','partially_paid'].includes(d.status)).length,
      invoicesPaid: invoices.filter((d) => d.status === 'paid').length,
      quoteValue: Math.round(sum(quotes) * 100) / 100,
      invoiceValue: Math.round(sum(invoices) * 100) / 100,
      paidValue: Math.round(sum(invoices.filter((d) => d.status === 'paid')) * 100) / 100,
    };
  },

  async listDueQuoteFollowUps(workspaceId) {
    const { items } = await this.list({ workspaceId, status: 'sent', limit: 200 });
    const now = Date.now();
    return items.filter((d) => {
      const fu = d.meta?.quoteFollowUp;
      if (!fu || fu.sent) return false;
      if (['viewed', 'accepted', 'rejected', 'paid', 'partially_paid'].includes(d.status)) return false;
      const due = new Date(fu.dueAt || fu.scheduledAt).getTime();
      return Number.isFinite(due) && due <= now;
    });
  },
};

module.exports = quoteStorage;
