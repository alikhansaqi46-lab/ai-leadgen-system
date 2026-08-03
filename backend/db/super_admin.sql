-- Super Admin platform tables (safe to re-run)
-- Owner console only — does not alter CRM product tables beyond optional user columns.

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_user_agent TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_country TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details JSONB DEFAULT '{}',
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS admin_auth_events (
  id TEXT PRIMARY KEY,
  email TEXT,
  user_id TEXT,
  event_type TEXT NOT NULL,
  success BOOLEAN DEFAULT FALSE,
  ip TEXT,
  user_agent TEXT,
  country TEXT,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_auth_events_created ON admin_auth_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_auth_events_email ON admin_auth_events (email);

CREATE TABLE IF NOT EXISTS admin_notifications (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  source TEXT,
  acknowledged BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_notifications_created ON admin_notifications (created_at DESC);

CREATE TABLE IF NOT EXISTS admin_expiry_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  notes TEXT,
  warn_days INTEGER DEFAULT 14,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_payment_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT,
  provider TEXT DEFAULT 'paypal',
  event_type TEXT NOT NULL,
  plan_key TEXT,
  amount NUMERIC(12, 2),
  currency TEXT DEFAULT 'USD',
  status TEXT,
  external_id TEXT,
  raw JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_payment_events_created ON admin_payment_events (created_at DESC);

CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_error_logs (
  id TEXT PRIMARY KEY,
  level TEXT DEFAULT 'error',
  source TEXT,
  message TEXT NOT NULL,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_error_logs_created ON admin_error_logs (created_at DESC);
