-- S1: Lead storage schema (PostgreSQL / Supabase)
-- Idempotent: safe to run multiple times.
--
-- Hybrid design: typed columns for the fields we filter / dedup / order on,
-- plus a JSONB `data` column that holds the COMPLETE lead object verbatim so
-- the storage layer returns the exact same shape the app already expects.

CREATE TABLE IF NOT EXISTS leads (
  id           TEXT PRIMARY KEY,            -- preserves existing UUID/string ids exactly
  name         TEXT,
  phone        TEXT,
  country      TEXT,
  niche        TEXT,
  -- S2: per-workspace isolation. Defaults to 'default' so pre-S2 rows / disabled
  -- auth mode keep working unchanged.
  workspace_id TEXT NOT NULL DEFAULT 'default',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  data         JSONB NOT NULL               -- full lead object (id, name, mapsUrl, createdAt, ...)
);

-- S2: add the column on pre-existing tables (idempotent).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_country    ON leads (country);
CREATE INDEX IF NOT EXISTS idx_leads_niche      ON leads (niche);
CREATE INDEX IF NOT EXISTS idx_leads_workspace  ON leads (workspace_id);
CREATE INDEX IF NOT EXISTS idx_leads_ws_created ON leads (workspace_id, created_at DESC);

-- =====================================================================
-- S5.1: AI lead qualification scores.
-- One row per (workspace, lead); re-qualifying upserts on the PK.
-- breakdown holds the explainable factor list verbatim (JSONB).
-- =====================================================================
CREATE TABLE IF NOT EXISTS lead_scores (
  lead_id      TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  score        INTEGER NOT NULL,
  priority     TEXT NOT NULL,                 -- 'hot' | 'warm' | 'cold'
  breakdown    JSONB,
  model        TEXT,                          -- 'heuristic' | 'openai:<model>'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_scores_workspace ON lead_scores (workspace_id);
CREATE INDEX IF NOT EXISTS idx_scores_priority  ON lead_scores (workspace_id, priority);
CREATE INDEX IF NOT EXISTS idx_scores_ws_score  ON lead_scores (workspace_id, score DESC);

-- =====================================================================
-- S5.2: AI outreach drafts (cold email / WhatsApp / follow-ups).
-- Approve-before-send gate: status moves draft -> approved | rejected.
-- Many drafts per lead (per channel/step), so id is the PK.
-- =====================================================================
CREATE TABLE IF NOT EXISTS outreach_drafts (
  id           TEXT PRIMARY KEY,
  lead_id      TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  channel      TEXT NOT NULL,                 -- 'email' | 'whatsapp'
  kind         TEXT NOT NULL,                 -- 'initial' | 'followup'
  step         INTEGER NOT NULL DEFAULT 0,
  wait_days    INTEGER NOT NULL DEFAULT 0,
  subject      TEXT,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'approved' | 'rejected'
  model        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drafts_workspace ON outreach_drafts (workspace_id);
CREATE INDEX IF NOT EXISTS idx_drafts_ws_lead   ON outreach_drafts (workspace_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_drafts_ws_status ON outreach_drafts (workspace_id, status);

-- =====================================================================
-- S5.3: Inbox foundation — conversations + messages.
-- A conversation groups two-way outreach for one (lead, channel).
-- Messages are appended (outbound from approved drafts / manual, inbound later).
-- =====================================================================
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT NOT NULL,
  workspace_id    TEXT NOT NULL DEFAULT 'default',
  channel         TEXT NOT NULL,                  -- 'email' | 'whatsapp'
  status          TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'closed'
  subject         TEXT,
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations (workspace_id);
CREATE INDEX IF NOT EXISTS idx_conversations_ws_lead   ON conversations (workspace_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_conversations_ws_recent ON conversations (workspace_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  workspace_id    TEXT NOT NULL DEFAULT 'default',
  direction       TEXT NOT NULL,                  -- 'outbound' | 'inbound'
  channel         TEXT NOT NULL,
  body            TEXT NOT NULL,
  source          TEXT,                           -- 'ai_draft' | 'manual' | 'inbound'
  draft_id        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_workspace ON messages (workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_ws_conv   ON messages (workspace_id, conversation_id, created_at);
