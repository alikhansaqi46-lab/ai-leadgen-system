# Auth / Supabase reconnect diagnosis (2026-07-23)

## What was wrong (infrastructure)

Login returned **HTTP 401** with body `self-signed certificate in certificate chain` while `STORAGE_DRIVER=postgres`.

That was **not** a wrong password. `userStorage.findByEmail()` could not open Postgres TLS to the Supabase pooler, and the exception was returned as the login error.

### Why TLS failed

| Endpoint | Certificate | Fix |
|----------|-------------|-----|
| `SUPABASE_JWKS_URL` (HTTPS) | Public CA; fails under corporate TLS inspection without system store | Start Node with `--use-system-ca` |
| `DATABASE_URL` pooler `:6543` | Chain ends at **Supabase Root 2021 CA** (not in Mozilla/Node default roots) | Trust `backend/certs/supabase-root-2021.pem` (auto-loaded by `config/tls.js`) |

**Do not** set `TLS_INSECURE_ALLOW=true` for production.

### Current verified state (no credential tests)

- Backend process: `node --use-system-ca server.js` on `:5001`
- `AUTH_MODE=supabase` (unchanged)
- JWKS: HTTP 200, 1 key, **ES256**
- Postgres: `select 1` OK with `rejectUnauthorized: true` + Supabase CA
- Synthetic HS256 token (same secret as `authService`) verifies via middleware **HS256 fallback** after JWKS rejects wrong alg

## How this app actually authenticates

`REACT_APP_AUTH_MODE=supabase` does **not** mean the login form calls Supabase Auth.

| Step | What runs |
|------|-----------|
| Login UI | `AuthContext.login` → `POST /api/auth/login` |
| Password check | bcrypt against **`public.users`** in Supabase Postgres |
| Token issued | **HS256** JWT signed with `JWT_SECRET` (`authService.signToken`) |
| API auth (`requireAuth`) | Try **JWKS ES256/RS256** (true Supabase Auth tokens), then fall back to **HS256 + JWT_SECRET** (custom login tokens) |
| `/api/auth/me` | Uses `authService.verifyToken` (HS256 only) |

So:

- **Infrastructure failure** → TLS/JWKS/DB (now fixed when started with `--use-system-ca` + Supabase CA files).
- **After that fix**, `401 {"error":"Invalid email or password."}` means the backend **did** reach Postgres and bcrypt rejected the pair (or email not in `public.users`). That is credential/data mismatch, not JWKS misconfiguration.

Supabase Auth identities live in **`auth.users`**. Custom app accounts live in **`public.users`**. They are not automatically the same store.

## Env checklist (redacted)

Backend:

- `AUTH_MODE=supabase`
- `STORAGE_DRIVER=postgres`
- `SUPABASE_URL=https://oxkbuoltwdsvhylgupyx.supabase.co`
- `SUPABASE_JWKS_URL=…/auth/v1/.well-known/jwks.json`
- `DATABASE_URL` → `aws-1-ap-southeast-1.pooler.supabase.com:6543`
- `JWT_SECRET` set (used to sign/verify custom login tokens)

Frontend:

- `REACT_APP_AUTH_MODE=supabase`
- `REACT_APP_API_URL=http://localhost:5001`
- `REACT_APP_SUPABASE_URL` matches backend project ref
- Login still posts to backend `/api/auth/login` (not `supabase.auth.signInWithPassword`)

## Operator steps to confirm with your real password

1. Keep backend as: `cd backend && npm start` (uses `--use-system-ca`).
2. Open `/login`, sign in with the **existing** email/password you know.
3. If it still fails, read the error text on the form (now surfaces `response.data.error`) and backend log line `[Auth] Login error: …`.
4. Distinguish:
   - `Invalid email or password.` → email missing from `public.users` or password hash mismatch.
   - `Please verify your email…` → row exists; `email_verified=false`.
   - certificate / JWKS errors → TLS regression (restart with `--use-system-ca`, ensure `backend/certs/supabase-root-2021.pem` present).

## Schema nits (unrelated to login 401)

Worker logs after reconnect:

- `column "revenue" does not exist`
- `relation "automations" does not exist`

Apply pending SQL (`campaigns.revenue`, `docs/S15_AUTOMATIONS.sql`) when ready — does not block auth validation.
