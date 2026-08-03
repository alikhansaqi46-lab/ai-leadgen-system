-- Owner Intelligence + AI usage tracking (safe to re-run)

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  user_id TEXT,
  source TEXT,
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  estimated_cost_usd NUMERIC(12, 6) DEFAULT 0,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS owner_success_events (
  id TEXT PRIMARY KEY,
  fingerprint TEXT UNIQUE,
  workspace_id TEXT NOT NULL,
  customer_email TEXT,
  customer_name TEXT,
  event_type TEXT NOT NULL,
  severity TEXT DEFAULT 'success',
  title TEXT NOT NULL,
  summary TEXT,
  country TEXT,
  industry TEXT,
  campaign_name TEXT,
  revenue NUMERIC(14, 2) DEFAULT 0,
  lead_count INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  meetings INTEGER DEFAULT 0,
  deals INTEGER DEFAULT 0,
  conversion_rate NUMERIC(8, 2) DEFAULT 0,
  channel TEXT,
  metrics JSONB DEFAULT '{}',
  notification_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_owner_success_created ON owner_success_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_success_ws ON owner_success_events (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS owner_campaign_library (
  id TEXT PRIMARY KEY,
  success_event_id TEXT,
  workspace_id TEXT NOT NULL,
  name TEXT,
  industry TEXT,
  country TEXT,
  channel TEXT,
  revenue NUMERIC(14, 2) DEFAULT 0,
  conversion_rate NUMERIC(8, 2) DEFAULT 0,
  why_it_worked TEXT,
  assets JSONB DEFAULT '{}',
  sequences JSONB DEFAULT '{}',
  funnel JSONB DEFAULT '{}',
  timeline JSONB DEFAULT '[]',
  offer TEXT,
  copy_style TEXT,
  prompts JSONB DEFAULT '[]',
  tags TEXT[] DEFAULT '{}',
  searchable TEXT,
  duplicated_from TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_owner_campaign_lib_created ON owner_campaign_library (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_campaign_lib_industry ON owner_campaign_library (industry);
CREATE INDEX IF NOT EXISTS idx_owner_campaign_lib_country ON owner_campaign_library (country);
CREATE INDEX IF NOT EXISTS idx_owner_campaign_lib_channel ON owner_campaign_library (channel);

-- Idempotent column upgrades for existing installs
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS offer TEXT;
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS copy_style TEXT;
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS prompts JSONB DEFAULT '[]';
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS searchable TEXT;
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS duplicated_from TEXT;
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

-- Owner Intelligence v2 lifecycle + scoring
ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS ai_score NUMERIC(4, 1) DEFAULT 0;
ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS score_label TEXT;
ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE;
ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;
ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS ignored BOOLEAN DEFAULT FALSE;
ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT FALSE;
ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS recommendations JSONB DEFAULT '{}';
ALTER TABLE owner_success_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS ai_score NUMERIC(4, 1) DEFAULT 0;
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS score_label TEXT;
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE;
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS ignored BOOLEAN DEFAULT FALSE;
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT FALSE;
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS recommendations JSONB DEFAULT '{}';
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS reply_rate NUMERIC(8, 2) DEFAULT 0;
ALTER TABLE owner_campaign_library ADD COLUMN IF NOT EXISTS lead_quality NUMERIC(8, 2) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_owner_success_score ON owner_success_events (ai_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_owner_success_pinned ON owner_success_events (pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_lib_score ON owner_campaign_library (ai_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_owner_lib_pinned ON owner_campaign_library (pinned DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS owner_launch_drafts (
  id TEXT PRIMARY KEY,
  library_id TEXT,
  success_event_id TEXT,
  source_workspace_id TEXT,
  target_workspace_id TEXT,
  channel TEXT NOT NULL,
  name TEXT,
  subject TEXT,
  body TEXT,
  settings JSONB DEFAULT '{}',
  status TEXT DEFAULT 'draft',
  launched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_owner_launch_status ON owner_launch_drafts (status, created_at DESC);
