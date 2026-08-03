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
  data         JSONB NOT NULL,              -- full lead object (id, name, mapsUrl, createdAt, ...)
  notes        TEXT                         -- CRM notes (editable from Inbox)
);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT;

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
-- S6: Campaign / CRM Pipeline — per-lead outreach lifecycle.
-- =====================================================================
CREATE TABLE IF NOT EXISTS campaigns (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT NOT NULL,
  workspace_id    TEXT NOT NULL DEFAULT 'default',
  status          TEXT NOT NULL DEFAULT 'new',       -- 'new' | 'sent' | 'replied' | 'interested' | 'meeting' | 'deal' | 'lost'
  sent_at         TIMESTAMPTZ,
  replied_at      TIMESTAMPTZ,
  interested_at   TIMESTAMPTZ,
  meeting_at      TIMESTAMPTZ,
  deal_at         TIMESTAMPTZ,
  lost_at         TIMESTAMPTZ,
  follow_up_1_at  TIMESTAMPTZ,
  follow_up_2_at  TIMESTAMPTZ,
  follow_up_1_sent BOOLEAN NOT NULL DEFAULT false,
  follow_up_2_sent BOOLEAN NOT NULL DEFAULT false,
  message_count   INTEGER NOT NULL DEFAULT 0,
  reply_count     INTEGER NOT NULL DEFAULT 0,
  test_mode       BOOLEAN NOT NULL DEFAULT false,
  revenue         NUMERIC(14, 2) DEFAULT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_workspace   ON campaigns (workspace_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_ws_lead     ON campaigns (workspace_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_ws_status   ON campaigns (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_campaigns_followup1   ON campaigns (workspace_id, follow_up_1_at);
CREATE INDEX IF NOT EXISTS idx_campaigns_followup2   ON campaigns (workspace_id, follow_up_2_at);

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
  unread_count    INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations (workspace_id);
CREATE INDEX IF NOT EXISTS idx_conversations_ws_lead   ON conversations (workspace_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_conversations_ws_recent ON conversations (workspace_id, last_message_at DESC);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
-- status values used by unified Inbox: open | ai_active | human_active | needs_human
-- | waiting_customer | quote_sent | invoice_sent | closed

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  workspace_id    TEXT NOT NULL DEFAULT 'default',
  direction       TEXT NOT NULL,                  -- 'outbound' | 'inbound'
  channel         TEXT NOT NULL,
  body            TEXT NOT NULL,
  source          TEXT,                           -- 'ai_draft' | 'manual' | 'inbound'
  draft_id        TEXT,
  status          TEXT DEFAULT 'sent',             -- 'sent' | 'delivered' | 'read' (outbound) or null (inbound)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_workspace ON messages (workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_ws_conv   ON messages (workspace_id, conversation_id, created_at);

-- Idempotent: add columns if they don't exist (for existing databases)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'sent';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS revenue NUMERIC(14, 2);

-- =====================================================================
-- S7: Users + Authentication (local JWT-based).
-- =====================================================================
CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,
  full_name        TEXT NOT NULL,
  business_name    TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  whatsapp_number  TEXT,
  password_hash    TEXT NOT NULL,
  email_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  email_code       TEXT,
  reset_code       TEXT,
  role             TEXT NOT NULL DEFAULT 'subscriber',
  subscription_status TEXT DEFAULT 'none',
  subscription_plan TEXT,
  subscription_id   TEXT,
  subscription_expires_at TIMESTAMPTZ,
  openai_api_key   TEXT,
  openai_api_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  free_ai_messages_remaining INTEGER NOT NULL DEFAULT 100,
  openai_source    TEXT DEFAULT 'master',
  serp_api_key     TEXT,
  sender_email     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_subscription_id ON users (subscription_id);

-- =====================================================================
-- S8: Unified Timeline — every significant action on a lead is an event.
-- This is the single source of truth for the lead activity feed.
-- =====================================================================
CREATE TABLE IF NOT EXISTS lead_events (
  id               TEXT PRIMARY KEY,
  lead_id          TEXT NOT NULL,
  workspace_id     TEXT NOT NULL DEFAULT 'default',
  type             TEXT NOT NULL,        -- 'lead_created' | 'message_sent' | 'message_received' | 'email_sent' | 'email_opened' | 'call_made' | 'call_completed' | 'status_changed' | 'note' | 'ai_action' | 'follow_up_scheduled' | 'follow_up_sent'
  channel          TEXT,                 -- 'whatsapp' | 'email' | 'sms' | 'call' | null
  conversation_id  TEXT,
  reference_id     TEXT,                -- message_id | call_id | email_message_id
  payload          JSONB,                -- flexible context per event type
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_events_ws_lead ON lead_events (workspace_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_events_ws_type ON lead_events (workspace_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_events_conv     ON lead_events (conversation_id);

-- =====================================================================
-- S9: Follow-Up Sequences — replace hardcoded follow_up_1 / follow_up_2.
-- Supports unlimited steps across all channels.
-- =====================================================================
CREATE TABLE IF NOT EXISTS follow_up_sequences (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  name          TEXT NOT NULL,          -- e.g. "Default WhatsApp Sequence"
  channel       TEXT NOT NULL,          -- 'whatsapp' | 'email' | 'sms'
  steps         JSONB NOT NULL,         -- [{ step: 1, waitDays: 2, template: "..." }, ...]
  is_default    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_follow_ups (
  id            TEXT PRIMARY KEY,
  lead_id       TEXT NOT NULL,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  sequence_id   TEXT NOT NULL,
  step_index    INTEGER NOT NULL DEFAULT 0,
  scheduled_at  TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'cancelled' | 'failed'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_followups_ws_lead ON lead_follow_ups (workspace_id, lead_id, status);
CREATE INDEX IF NOT EXISTS idx_lead_followups_due    ON lead_follow_ups (workspace_id, status, scheduled_at);

-- =====================================================================
-- S10: Lead Contacts — multiple contact points per lead.
-- =====================================================================
CREATE TABLE IF NOT EXISTS contacts (
  id            TEXT PRIMARY KEY,
  lead_id       TEXT NOT NULL,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  channel       TEXT NOT NULL,          -- 'email' | 'phone' | 'whatsapp' | 'sms' | future channels
  value         TEXT NOT NULL,          -- phone number | email address
  normalized_value TEXT,
  label         TEXT,
  notes         TEXT,
  is_primary    BOOLEAN NOT NULL DEFAULT false,
  is_verified   BOOLEAN NOT NULL DEFAULT false,
  metadata      JSONB DEFAULT '{}',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS normalized_value TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_contacts_lead ON contacts (lead_id, channel);
CREATE INDEX IF NOT EXISTS idx_contacts_workspace ON contacts (workspace_id);
CREATE INDEX IF NOT EXISTS idx_contacts_ws_lead ON contacts (workspace_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_contacts_ws_channel ON contacts (workspace_id, channel);
CREATE INDEX IF NOT EXISTS idx_contacts_ws_value ON contacts (workspace_id, channel, normalized_value);
CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_ws_channel_value
  ON contacts (workspace_id, channel, normalized_value)
  WHERE normalized_value IS NOT NULL;

-- =====================================================================
-- S10.1: Universal Contact Manager tags, notes, and custom fields.
-- These tables intentionally hang from leads so existing CRM/AI/campaign
-- records keep their lead_id graph while contact data becomes normalized.
-- =====================================================================
CREATE TABLE IF NOT EXISTS contact_tags (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  name          TEXT NOT NULL,
  color         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_tags_ws_name ON contact_tags (workspace_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_contact_tags_workspace ON contact_tags (workspace_id);

CREATE TABLE IF NOT EXISTS lead_contact_tags (
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  lead_id       TEXT NOT NULL,
  tag_id        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, lead_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_contact_tags_ws_lead ON lead_contact_tags (workspace_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_contact_tags_ws_tag ON lead_contact_tags (workspace_id, tag_id);

CREATE TABLE IF NOT EXISTS contact_notes (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  lead_id       TEXT NOT NULL,
  contact_id    TEXT,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_notes_ws_lead ON contact_notes (workspace_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_notes_ws_contact ON contact_notes (workspace_id, contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contact_custom_fields (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  lead_id       TEXT NOT NULL,
  field_key     TEXT NOT NULL,
  label         TEXT,
  field_type    TEXT NOT NULL DEFAULT 'text',
  field_value   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_custom_fields_ws_lead_key
  ON contact_custom_fields (workspace_id, lead_id, field_key);
CREATE INDEX IF NOT EXISTS idx_contact_custom_fields_ws_lead ON contact_custom_fields (workspace_id, lead_id);

-- =====================================================================
-- S10.2: Personal Contact Database.
-- Independent from Leads. These are user/customer-owned recipient contacts
-- used for bulk messaging and personal CRM lists, not scraped leads.
-- =====================================================================
CREATE TABLE IF NOT EXISTS personal_contacts (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL DEFAULT 'default',
  name                     TEXT,
  company                  TEXT,
  whatsapp_number          TEXT,
  whatsapp_normalized      TEXT,
  sms_number               TEXT,
  sms_normalized           TEXT,
  email                    TEXT,
  email_normalized         TEXT,
  notes                    TEXT,
  source                   TEXT NOT NULL DEFAULT 'manual',
  duplicate_of             TEXT,
  metadata                 JSONB DEFAULT '{}',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE personal_contacts ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE personal_contacts ADD COLUMN IF NOT EXISTS whatsapp_normalized TEXT;
ALTER TABLE personal_contacts ADD COLUMN IF NOT EXISTS sms_normalized TEXT;
ALTER TABLE personal_contacts ADD COLUMN IF NOT EXISTS email_normalized TEXT;
ALTER TABLE personal_contacts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE personal_contacts ADD COLUMN IF NOT EXISTS duplicate_of TEXT;
ALTER TABLE personal_contacts ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE personal_contacts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_personal_contacts_ws_created
  ON personal_contacts (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_personal_contacts_ws_name
  ON personal_contacts (workspace_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_personal_contacts_ws_email
  ON personal_contacts (workspace_id, email_normalized);
CREATE INDEX IF NOT EXISTS idx_personal_contacts_ws_whatsapp
  ON personal_contacts (workspace_id, whatsapp_normalized);
CREATE INDEX IF NOT EXISTS idx_personal_contacts_ws_sms
  ON personal_contacts (workspace_id, sms_normalized);
CREATE INDEX IF NOT EXISTS idx_personal_contacts_ws_duplicate
  ON personal_contacts (workspace_id, duplicate_of);

-- =====================================================================
-- S11: Extend messages for channel-agnostic inbox.
-- =====================================================================
ALTER TABLE messages ADD COLUMN IF NOT EXISTS external_message_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB;

-- =====================================================================
-- S12: WhatsApp Test Mode storage (per workspace).
-- =====================================================================
CREATE TABLE IF NOT EXISTS test_mode (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  test_number   TEXT,
  messages_used INTEGER NOT NULL DEFAULT 0,
  messages_limit INTEGER NOT NULL DEFAULT 10,
  active        BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_test_mode_workspace ON test_mode (workspace_id);

-- =====================================================================
-- S13: User preview settings (for Email/WhatsApp preview send).
-- =====================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS preview_settings JSONB DEFAULT '{}';

-- AI Sales Agent workspace knowledge + autonomous reply preferences
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_agent_config JSONB DEFAULT '{}';

-- =====================================================================
-- S14: Sender email (separate from account/login email).
-- =====================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS sender_email TEXT;

-- =====================================================================
-- S15: Automation Engine — durable workflows, runs, and logs.
-- Frontend must not invent execution metrics; these tables are the source of truth.
-- =====================================================================
CREATE TABLE IF NOT EXISTS automations (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  name          TEXT NOT NULL,
  description   TEXT,
  enabled       BOOLEAN NOT NULL DEFAULT false,
  trigger_type  TEXT NOT NULL,              -- 'manual' | 'lead_created' | 'score_hot' | 'reply_received' | 'schedule' | 'campaign_status'
  trigger_config JSONB NOT NULL DEFAULT '{}',
  conditions    JSONB NOT NULL DEFAULT '[]', -- [{ field, op, value }]
  actions       JSONB NOT NULL DEFAULT '[]', -- [{ type, config }]
  color         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automations_workspace ON automations (workspace_id);
CREATE INDEX IF NOT EXISTS idx_automations_ws_enabled ON automations (workspace_id, enabled);
CREATE INDEX IF NOT EXISTS idx_automations_ws_trigger ON automations (workspace_id, trigger_type);

CREATE TABLE IF NOT EXISTS automation_runs (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  trigger_type  TEXT,
  context       JSONB DEFAULT '{}',
  error         TEXT,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_ws ON automation_runs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_auto ON automation_runs (automation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs (workspace_id, status);

CREATE TABLE IF NOT EXISTS automation_run_logs (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  step_index    INTEGER NOT NULL DEFAULT 0,
  step_type     TEXT,                       -- 'trigger' | 'condition' | 'action'
  message       TEXT NOT NULL,
  level         TEXT NOT NULL DEFAULT 'info', -- 'info' | 'success' | 'error' | 'warn'
  payload       JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_logs_run ON automation_run_logs (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_logs_ws ON automation_run_logs (workspace_id, created_at DESC);
