# S2 — Auth + Workspace Isolation (runbook)

S2 adds authentication (Supabase Auth) and per-workspace data isolation behind
feature flags. The default (`AUTH_MODE=disabled`) preserves pre-S2 behavior
exactly — no login, single `default` workspace.

## What changed

- **Auth middleware** (`backend/middleware/auth.js`) populates `req.auth = { userId, workspaceId }`.
- **Workspace isolation** in `backend/utils/leadStorage.js`: every lead carries a
  `workspaceId`; all reads/writes/deletes are scoped by it across **all** drivers
  (JSON, Firestore, Postgres). Dedup runs within a workspace.
- **Routes** pass `req.auth.workspaceId` into storage; WhatsApp credentials are
  keyed by workspace. The **WhatsApp webhook stays unauthenticated**.
- **Frontend** `AuthGate` (`frontend/src/auth/`) injects the Supabase access token
  into requests and shows a login screen — only when `REACT_APP_AUTH_MODE=supabase`.

## AUTH_MODE

| AUTH_MODE | Token required | Workspace |
|-----------|----------------|-----------|
| `disabled` (default) | no | `DEFAULT_WORKSPACE_ID` (`default`) |
| `supabase` | yes (Supabase JWT, HS256) | `app_metadata.workspace_id` claim, else `sub` |
| `dev` | yes (HMAC, `DEV_AUTH_SECRET`) | claim, else `sub` — testing only |
| `clerk` | — | not implemented in S2 |

## Enabling Supabase Auth (when ready)

1. Provision a Supabase project (also unblocks the deferred S1 Postgres cutover).
2. Backend env:
   ```
   AUTH_MODE=supabase
   SUPABASE_JWT_SECRET=<Project Settings → API → JWT Secret>
   DEFAULT_WORKSPACE_ID=default
   ```
3. Frontend env:
   ```
   REACT_APP_AUTH_MODE=supabase
   REACT_APP_SUPABASE_URL=<project url>
   REACT_APP_SUPABASE_ANON_KEY=<anon key>
   ```
4. Stamp each user's workspace into `app_metadata.workspace_id` (e.g. a Supabase
   trigger/edge function on signup). One-workspace-per-user falls back to `sub`.
5. If using Postgres: `npm run db:init` then `npm run db:backfill-workspace`.
6. Reassign existing `default` data to the first real workspace if desired:
   ```sql
   UPDATE leads SET workspace_id = '<new-ws>' WHERE workspace_id = 'default';
   ```

## Rollback

Set `AUTH_MODE=disabled` (backend) and `REACT_APP_AUTH_MODE=disabled` (frontend),
redeploy. The app returns to no-login / single-`default`-workspace instantly. The
`workspace_id` column is additive (defaults to `default`) — safe to leave; no
data is moved or deleted.

## Tests

```
cd backend
npm run test:isolation                                  # JSON + auth middleware
DATABASE_URL=postgres://... npm run test:isolation      # + Postgres path
```
Covers: A/B can only see their own leads, A cannot delete B's lead, per-workspace
dedup, per-workspace filters/export, and auth middleware (disabled no-op; dev mode
401 on missing/invalid token; workspace resolved from claim).
