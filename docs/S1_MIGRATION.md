# S1 — PostgreSQL / Supabase Migration Runbook

Replaces JSON/file-based lead storage with PostgreSQL **behind the existing
`leadStorage.js` interface**. Routes are unchanged; the swap is controlled by the
`STORAGE_DRIVER` feature flag and is fully reversible.

## What changed
- `backend/utils/leadStorage.js` now supports a `postgres` driver alongside the
  existing `firestore` and `json` drivers. `deduplicateLeads` is unchanged.
- New: `backend/config/db.js` (pg pool), `backend/db/schema.sql`,
  `backend/scripts/init-db.js`, `backend/scripts/migrate-json-to-postgres.js`.

## Storage drivers (`STORAGE_DRIVER`)
| Value | Behavior |
|-------|----------|
| `auto` (default) | Firestore if configured, else JSON file — **identical to pre-S1 behavior** |
| `json` | Force file-based JSON (`backend/data/leads.json`) |
| `firestore` | Force Firestore |
| `postgres` | Use PostgreSQL / Supabase (requires `DATABASE_URL`) |

## One-time cutover

1. **Provision Postgres** (e.g. Supabase → Project Settings → Database → Connection string URI).
2. **Set env** in `backend/.env`:
   ```
   DATABASE_URL=postgres://...   # from your provider
   # STORAGE_DRIVER left as 'auto' for now (don't cut over yet)
   ```
3. **Create the schema** (idempotent):
   ```
   cd backend && npm install && npm run db:init
   ```
4. **Dry-run the import** (no writes — prints counts + sample):
   ```
   npm run db:migrate-json -- --dry-run
   # include existing Firestore data too:  npm run db:migrate-json -- --dry-run --from-firestore
   ```
5. **Import for real** (copy-only, idempotent via `ON CONFLICT (id) DO NOTHING`):
   ```
   npm run db:migrate-json
   # or:  npm run db:migrate-json -- --from-firestore
   ```
6. **Verify on staging**: set `STORAGE_DRIVER=postgres`, restart, run `docs/SMOKE_TEST.md`
   (scraping, lead list/filter/delete, CSV export). Confirm row counts match.
7. **Cut over production**: set `STORAGE_DRIVER=postgres` and redeploy.

## Rollback
The import is **copy-only** — the original JSON file / Firestore data is never
modified. To roll back, set `STORAGE_DRIVER` back to `auto` (or `json`/`firestore`)
and redeploy. The previous store is immediately authoritative again. No
down-migration and no data loss.

## Notes
- WhatsApp credentials remain file-based in S1 (out of scope; unchanged).
- Multi-tenancy (`workspace_id`) is intentionally **not** added here — that is S2.
