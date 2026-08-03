-- AI Quotes & Invoicing (Stage 1)
-- Normalized documents linked to leads; customer snapshot for historical accuracy.
-- Payment table prepared for Stage 2 gateway integration.

CREATE TABLE IF NOT EXISTS workspace_billing_profiles (
  workspace_id     TEXT PRIMARY KEY,
  company_name     TEXT,
  logo_url         TEXT,
  signature_url    TEXT,
  address          TEXT,
  city             TEXT,
  country          TEXT,
  phone            TEXT,
  email            TEXT,
  website          TEXT,
  tax_id           TEXT,
  default_currency TEXT NOT NULL DEFAULT 'MYR',
  default_tax_pct  NUMERIC(8, 2) NOT NULL DEFAULT 0,
  default_terms    TEXT,
  payment_terms    TEXT,
  header_text      TEXT,
  footer_text      TEXT,
  meta             JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales_documents (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL DEFAULT 'default',
  doc_type         TEXT NOT NULL,              -- 'quote' | 'invoice'
  number           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft',
  lead_id          TEXT,                       -- reference only; do not duplicate CRM
  contact_id       TEXT,
  customer         JSONB NOT NULL DEFAULT '{}', -- snapshot at document time
  company          JSONB NOT NULL DEFAULT '{}', -- snapshot of billing profile
  line_items       JSONB NOT NULL DEFAULT '[]',
  currency         TEXT NOT NULL DEFAULT 'MYR',
  subtotal         NUMERIC(14, 2) NOT NULL DEFAULT 0,
  discount_pct     NUMERIC(8, 2) NOT NULL DEFAULT 0,
  discount_amount  NUMERIC(14, 2) NOT NULL DEFAULT 0,
  tax_pct          NUMERIC(8, 2) NOT NULL DEFAULT 0,
  tax_amount       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  shipping         NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total            NUMERIC(14, 2) NOT NULL DEFAULT 0,
  notes            TEXT,
  terms            TEXT,
  payment_terms    TEXT,
  template         TEXT NOT NULL DEFAULT 'corporate',
  valid_until      TIMESTAMPTZ,
  due_date         TIMESTAMPTZ,
  quote_id         TEXT,                       -- invoice sourced from quote
  pdf_path         TEXT,
  ai_prompt        TEXT,
  meta             JSONB NOT NULL DEFAULT '{}',
  amount_paid      NUMERIC(14, 2) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ,
  viewed_at        TIMESTAMPTZ,
  accepted_at      TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  public_token     TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_sales_docs_ws ON sales_documents (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_docs_ws_type ON sales_documents (workspace_id, doc_type, status);
CREATE INDEX IF NOT EXISTS idx_sales_docs_lead ON sales_documents (workspace_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_sales_docs_number ON sales_documents (workspace_id, number);
CREATE INDEX IF NOT EXISTS idx_sales_docs_quote ON sales_documents (quote_id);

CREATE TABLE IF NOT EXISTS sales_document_events (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  event_type    TEXT NOT NULL,
  channel       TEXT,
  payload       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_doc_events_doc ON sales_document_events (document_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_doc_events_ws ON sales_document_events (workspace_id, created_at DESC);

-- Future payment gateway integration (Stage 2+)
CREATE TABLE IF NOT EXISTS sales_payments (
  id            TEXT PRIMARY KEY,
  invoice_id    TEXT NOT NULL,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  amount        NUMERIC(14, 2) NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'MYR',
  method        TEXT,                          -- 'manual' | 'paypal' | 'stripe' | ...
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|completed|failed|refunded
  external_id   TEXT,
  paid_at       TIMESTAMPTZ,
  meta          JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_payments_invoice ON sales_payments (invoice_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_payments_ws ON sales_payments (workspace_id, created_at DESC);
