-- S1: Lead storage schema (PostgreSQL / Supabase)
-- Idempotent: safe to run multiple times.
--
-- Hybrid design: typed columns for the fields we filter / dedup / order on,
-- plus a JSONB `data` column that holds the COMPLETE lead object verbatim so
-- the storage layer returns the exact same shape the app already expects.

CREATE TABLE IF NOT EXISTS leads (
  id          TEXT PRIMARY KEY,            -- preserves existing UUID/string ids exactly
  name        TEXT,
  phone       TEXT,
  country     TEXT,
  niche       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  data        JSONB NOT NULL               -- full lead object (id, name, mapsUrl, createdAt, ...)
);

CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_country    ON leads (country);
CREATE INDEX IF NOT EXISTS idx_leads_niche      ON leads (niche);
