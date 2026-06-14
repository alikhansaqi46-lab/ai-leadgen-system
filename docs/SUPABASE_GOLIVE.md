# Supabase Go-Live (runbook)

Activates the already-built S1 (Postgres storage) + S2 (auth + workspace
isolation) on a live Supabase project. This is a **config + data + verification**
change — the code shipped in PRs #2/#3 and stays dormant until the flags below
are flipped. Rollback is instant (flip the flags back).

Default behavior is unchanged: with `STORAGE_DRIVER=auto` + `AUTH_MODE=disabled`
the app runs exactly as before (file JSON, no login, single `default` workspace).

## 1. Supabase project setup (one-time, in the dashboard)

1. Create a project (choose a region close to your users; save the DB password).
2. Authentication → Users → add one test user (enable "Auto Confirm").
3. Collect:
   - **DATABASE_URL** — Connect → Connection string → **Session pooler** URI
     (replace `[YOUR-PASSWORD]`). The session pooler is required for a long-lived
     `pg` Pool.
   - **SUPABASE_URL** — Settings → API → Project URL (`https://<ref>.supabase.co`).
   - **REACT_APP_SUPABASE_ANON_KEY** — Settings → API → `anon` `public` key.

No tables, SQL, or RLS policies are created by hand — `init-db` applies the schema
and isolation is enforced at the application layer.

## 2. JWT verification (ES256/JWKS vs legacy HS256)

Current Supabase projects sign access tokens with **asymmetric keys (ES256/RS256)**
and publish a public JWKS endpoint. The backend verifies each token against
`{SUPABASE_URL}/auth/v1/.well-known/jwks.json` — **no secret required**.

- Asymmetric (default): set `SUPABASE_URL`. (Optionally `SUPABASE_JWKS_URL` to
  override the endpoint.)
- Legacy HS256: older projects expose a "JWT Secret" — set `SUPABASE_JWT_SECRET`
  instead. If both are set, JWKS takes precedence.

JWK fetching, caching and key rotation are handled by `jose` (`createRemoteJWKSet`).

## 3. Create the schema (clean start)

```bash
cd backend
DATABASE_URL='<session-pooler-uri>' node scripts/init-db.js
```

Creates `leads`, `lead_scores`, `outreach_drafts`, `conversations`, `messages`
and all workspace indexes (idempotent). Starting clean → **no data migration**.
(If you ever need to import existing file JSON leads:
`DATABASE_URL=... node scripts/migrate-json-to-postgres.js --dry-run` then without
`--dry-run`; it is copy-only and idempotent.)

## 4. Flip the flags

Backend env:

```ini
STORAGE_DRIVER=postgres
DATABASE_URL=<session-pooler-uri>
AUTH_MODE=supabase
SUPABASE_URL=https://<ref>.supabase.co
ALLOWED_ORIGINS=<frontend origin(s)>
```

Frontend env (build-time):

```ini
REACT_APP_AUTH_MODE=supabase
REACT_APP_SUPABASE_URL=https://<ref>.supabase.co
REACT_APP_SUPABASE_ANON_KEY=<anon public key>
```

## 5. Verify

```bash
# Isolation on the LIVE Postgres (leads/scores/drafts/conversations + auth):
cd backend && DATABASE_URL='<uri>' npm run test:isolation

# Auth gate (replace TOKEN with the test user's access_token):
curl -i localhost:5001/api/leads                          # → 401 (no token)
curl -i -H "Authorization: Bearer $TOKEN" localhost:5001/api/leads   # → 200
curl -i "localhost:5001/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=ping"  # → 200 (open)
```

Then in the browser: sign in as the test user → run the four flows (scrape, lead
mgmt, WhatsApp, CSV) and the S5 loop (qualify → draft → approve → move to inbox →
reply). All data is scoped to that user's workspace (their Supabase `sub`).

## 6. Rollback (instant)

Set `STORAGE_DRIVER=auto`, `AUTH_MODE=disabled` (and frontend
`REACT_APP_AUTH_MODE=disabled`) and restart/rebuild. The Postgres data is left
intact; `leads.json` was never modified.

## Notes

- **Workspace model (V1):** one workspace per user, keyed by the Supabase `sub`.
  Shared/team workspaces are a later milestone.
- **Webhook:** the Meta WhatsApp webhook stays unauthenticated and resolves to the
  `default` workspace (inbound→workspace sync is post-V1).
