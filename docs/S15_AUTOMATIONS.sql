-- S15: Automation Engine tables only
-- Paste into Supabase → SQL Editor → Run (DEV project only)
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS automations (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  name          TEXT NOT NULL,
  description   TEXT,
  enabled       BOOLEAN NOT NULL DEFAULT false,
  trigger_type  TEXT NOT NULL,
  trigger_config JSONB NOT NULL DEFAULT '{}',
  conditions    JSONB NOT NULL DEFAULT '[]',
  actions       JSONB NOT NULL DEFAULT '[]',
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
  status        TEXT NOT NULL DEFAULT 'pending',
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
  step_type     TEXT,
  message       TEXT NOT NULL,
  level         TEXT NOT NULL DEFAULT 'info',
  payload       JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_logs_run ON automation_run_logs (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_logs_ws ON automation_run_logs (workspace_id, created_at DESC);
