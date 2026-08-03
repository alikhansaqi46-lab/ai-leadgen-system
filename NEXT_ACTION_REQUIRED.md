# NEXT ACTION REQUIRED — Human Decisions

Last updated: 2026-07-23 (Supabase restored; TLS trust fixed; no credential guessing)

---

## Auth diagnosis (read this)

Full write-up: `docs/AUTH_SUPABASE_DIAGNOSIS.md`

**Summary:** Login 401 was caused by **Postgres TLS trust** to the Supabase pooler (`Supabase Root 2021 CA`), not by JWKS and not by AUTH_MODE. Backend is now started with `node --use-system-ca` and auto-loads `backend/certs/supabase-root-2021.pem`.

After that fix, a 401 with `Invalid email or password.` means the backend successfully checked `public.users` + bcrypt — use your known password in the UI. Do not run multi-password scripts.

Keep `AUTH_MODE=supabase`. Do not switch to local. Do not create demo users.

---

## Running stack

- Backend `:5001` — `node --use-system-ca server.js` (`npm start` in backend)
- Frontend `:3000` — CRA
- JWKS reachable; DB ping OK with verified TLS

---

## Still human

1. Sign in once in the browser with your real existing password to confirm dashboard.
2. Optional SQL: `campaigns.revenue`, `docs/S15_AUTOMATIONS.sql`
3. Set `ENCRYPTION_KEY` (64 hex) instead of deriving from `JWT_SECRET`
