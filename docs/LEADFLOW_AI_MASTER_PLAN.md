# LeadFlow AI — Master Plan

**Document status:** Permanent project brain  
**Company:** NovaCore Technologies  
**Product:** LeadFlow AI — Autonomous AI Sales Employee  
**Last updated:** 2026-07-23 (Backend restarted :5001 security-v2; live route smoke; TLS CA file support)  
**Overall completion (honest):** ~94% (API live + tests green; Postgres TLS CA + secrets still human blockers)

This document is the source of truth for vision, architecture, standards, and roadmap.  
It is derived from the existing repository plus the agreed product mission.  
It does **not** invent APIs, tables, or features that do not exist; gaps are labeled as **Target** or **Missing**.

---

## 1. Project Vision

### What LeadFlow AI is

LeadFlow AI is **not** a lead generator, email marketing tool, WhatsApp sender, or generic CRM.

LeadFlow AI is a **fully autonomous AI Sales Employee**.

Its mission is to replace the daily work of a human sales representative.  
The customer should only define the campaign. Everything else should run automatically.

### End-user contract

The user provides:

| Input | Example |
|-------|---------|
| Campaign Name | Dentists Kuala Lumpur |
| Business Type | Dental Clinic |
| Location | Kuala Lumpur |
| Target Country | Malaysia |
| Language | English |
| Goal | Book Appointments |

After **Start Campaign**, LeadFlow AI must perform the remaining work.

### Full autonomous sales pipeline (target)

```
Campaign
  → Lead Scraping
  → Business Verification
  → Email Discovery
  → Phone Discovery
  → WhatsApp Detection
  → Lead Qualification
  → AI Scoring
  → Priority Ranking
  → CRM Creation
  → Email Outreach
  → WhatsApp Outreach
  → SMS Outreach
  → AI Conversation
  → Automatic Replies
  → Follow-up Engine
  → Objection Handling
  → Meeting Booking
  → Pipeline Updates
  → Deal Closing
  → Customer Handover
  → Reports
  → Analytics
```

### Product principles

1. Every feature must increase **autonomous selling**.
2. Never build decorative or unnecessary features.
3. Prefer security, reliability, automation, maintainability, performance, and scalability over cosmetics.
4. No fake data, placeholder logic, mocked APIs, or hardcoded statistics in production paths.
5. Dashboard metrics must come from the database/APIs only.

### Primary modules (product map)

| Module | Role |
|--------|------|
| Lead Scraper | Discover businesses by niche/location |
| AI Qualification | Score and prioritize leads |
| CRM / Pipeline | Track lead lifecycle to deal/lost |
| Email Automation | Gmail/OAuth outreach + inbox |
| WhatsApp Automation | Meta Cloud API outreach + webhook |
| SMS Automation | Twilio send + status webhooks |
| Automation Engine | Triggers → conditions → actions (target: real backend) |
| AI Conversations | Qualify, reply, autonomous decisions |
| AI Follow-ups | Scheduled multi-step sequences |
| Deal Pipeline | Status: new → sent → replied → interested → meeting → deal / lost |
| Analytics / Dashboard | Real operational metrics |
| Billing / Subscription | PayPal plans + gates |
| Settings | Integrations, AI agent knowledge, OpenAI keys |
| Reports | Historical performance (partial today) |

---

## 2. Complete System Architecture

### High-level topology (as implemented)

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (React 18 + TypeScript, CRA)                      │
│  BrowserRouter → AuthProvider → ProtectedRoute → AppShell   │
│  Features: Capture → Engage → Automate → Configure          │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTPS / Bearer JWT
                            │ axios (REACT_APP_API_URL / proxy :5001)
┌───────────────────────────▼─────────────────────────────────┐
│  Backend (Express, Node.js) — backend/server.js             │
│  Port: PORT || 5001                                         │
│  Mounts: /api/auth|leads|contacts|scrape|ai|whatsapp|       │
│          campaign|email|integrations|sms|paypal|webhook|    │
│          settings|openai + inline send/health/upload        │
└───┬─────────────┬──────────────┬──────────────┬─────────────┘
    │             │              │              │
    ▼             ▼              ▼              ▼
 Postgres      File JSON      External APIs   Unified Send
 (Supabase)    integrations   SerpAPI         conversations
 STORAGE_      OpenAI keys*   Gmail/Meta      campaigns
 DRIVER        scraper cfg    Twilio/PayPal   timeline
```

\*OpenAI keys for users are stored encrypted in Postgres `users` when using DB driver; integration credentials for channels currently use file storage (`data/integrations.json`).

### Workspace model

- One workspace per authenticated user (`workspace_id` ≈ user id / JWT `sub`).
- `AUTH_MODE=disabled` uses `DEFAULT_WORKSPACE_ID` (typically `default`).
- Most storage layers are workspace-scoped.

### Storage driver

Controlled by `STORAGE_DRIVER`: `auto` | `postgres` | `json` (legacy Firestore path removed from app runtime).

### Channel send spine

All primary outbound channel sends should flow through:

`routes → provider service → services/unifiedSend.js`

`unifiedSend` writes:

- Conversation + message
- Campaign status / counts
- Timeline (`lead_events`)
- Optional follow-up scheduling

### What exists vs vision gap

| Layer | Exists today | Gap vs autonomous vision |
|-------|--------------|--------------------------|
| Scrape → leads | Yes (SerpAPI) | Chained via `POST /api/campaign/start` (auto-send gated) |
| Qualify / score | Yes | Manual or dashboard auto-qualify when unscored |
| Outreach drafts | Yes (approve gate) | Not fully auto-send without human approve |
| Multi-channel CRM | Yes | Status updated by send/reply; LeadsPage stage control |
| Follow-ups | Schema + worker + process-due API | Postgres TLS may block remote ticks |
| Automations UI | Backend-backed | Objection playbooks / richer action set still growing |
| Dashboard | Real KPI API + drill-downs | Bounce/DSN and deep revenue attribution still missing |

---

## 3. Database Architecture

**Source of truth:** `backend/db/schema.sql`  
**Driver:** `pg` pool via `backend/config/db.js` (`DATABASE_URL`, optional `PGSSL`)

No formal SQL `FOREIGN KEY` constraints. Relationships are logical via `lead_id`, `workspace_id`, `conversation_id`.

### Core entity graph

```
users (auth, billing, AI keys, agent config)
  └── workspace_id ≈ user.id
        ├── leads (+ data JSONB, notes)
        │     ├── lead_scores (hot|warm|cold)
        │     ├── outreach_drafts
        │     ├── campaigns (pipeline status)
        │     ├── conversations → messages
        │     ├── lead_events (timeline)
        │     ├── contacts (+ tags, notes, custom fields)
        │     └── lead_follow_ups → follow_up_sequences
        └── personal_contacts (standalone recipient DB)
test_mode (WhatsApp test limits per workspace)
```

### Tables (implemented)

| Table | Purpose |
|-------|---------|
| `leads` | Scraped/imported businesses; `data` JSONB holds full object |
| `lead_scores` | AI/heuristic score + priority per lead |
| `outreach_drafts` | Approve-before-send drafts (`draft`/`approved`/`rejected`) |
| `campaigns` | Per-lead pipeline: `new\|sent\|replied\|interested\|meeting\|deal\|lost` |
| `conversations` | Thread per lead+channel; archive/pin/unread |
| `messages` | Inbound/outbound bodies + status |
| `users` | Auth, subscription, encrypted OpenAI fields, sender email, preview/AI config |
| `lead_events` | Unified activity timeline |
| `follow_up_sequences` | Named multi-step sequences (JSONB steps) |
| `lead_follow_ups` | Per-lead scheduled steps (`pending\|sent\|cancelled\|failed`) |
| `contacts` | Normalized contact methods on a lead |
| `contact_tags` / `lead_contact_tags` | Tagging |
| `contact_notes` / `contact_custom_fields` | CRM enrichment |
| `personal_contacts` | Contacts module (not scraped leads) |
| `test_mode` | WhatsApp test-mode state |

### Analytics storage today

- Campaign analytics: computed in `campaignStorage.getAnalytics` from `campaigns` + channel message counts.
- Channel stats: `conversationStorage.getMessageCountsByChannel`.
- **Missing for enterprise dashboard:** dedicated metrics/history tables for time-series charts (open rate, revenue time series, average response time, etc.). Some open/click tracking endpoints exist on email routes; historical dashboard series are not fully productized.

### Non-Postgres persistence (current)

| Store | Location | Notes |
|-------|----------|-------|
| Channel integrations | `data/integrations.json` | OAuth tokens / Meta / Twilio — **Priority 1: encrypt + preferably migrate** |
| Scraper config | `data/scraper-config.json` | SerpAPI key file fallback |
| Automations (frontend) | `localStorage` | Not durable server-side |

---

## 4. Frontend Architecture

**Stack:** React 18, TypeScript, React Router 6, Axios, CRA (`react-scripts` 5)  
**Entry:** `frontend/src/index.tsx`  
**Shell:** `AppShell` + `Sidebar` + `Topbar` + `Outlet`  
**Design tokens:** `frontend/src/app/shell.css` (`--lf-*`, Inter, dark navy SaaS theme)

### Route map (`AppRoutes.tsx`)

| Path | Page | Auth |
|------|------|------|
| `/`, `/pricing` | Landing, Pricing | Public |
| `/login`, `/signup`, `/verify-email`, `/forgot-password` | Auth | Public |
| `/app` | Dashboard | Protected |
| `/app/contacts` | Personal contacts | Protected |
| `/app/leads` | Lead CRM list | Protected |
| `/app/scraper` | SerpAPI scrape | Protected |
| `/app/inbox` | Unified inbox | Protected |
| `/app/whatsapp`, `/email`, `/sms` | Channel CRMs | Protected |
| `/app/ai-agent` | Qualify + outreach drawer | Protected |
| `/app/automations` | Automation UI (local) | Protected |
| `/app/settings`, `/settings/subscription`, `/account` | Config / billing / profile | Protected |

Navigation story (`navigation.ts`): **Overview → Capture → Engage → Automate → Configure**.

### Auth UI

- `AuthContext` talks to `/api/auth/*`, stores JWT in memory + `localStorage` (`lf_auth_token`).
- `ProtectedRoute` gates `/app/*`.
- `AuthGate` is currently a passthrough; Supabase gate exists but is not mounted in `index.tsx`.

### API client

`frontend/src/lib/apiClient.ts` — single axios instance, Bearer interceptor, typed helpers for leads, contacts, scrape, channels, AI, campaign, PayPal, OpenAI, uploads.

`frontend/src/lib/bulkCampaign.ts` — session handoff of selected leads/contacts to channel pages.

### Known frontend honesty gaps

| Item | Status |
|------|--------|
| Dashboard KPIs from leads/scores/channel stats | Real API |
| `getCampaignStats` fetched | Partially unused in rendered UI |
| Automations KPIs | Estimated (`activeCount * N`) — **not production truth** |
| Sidebar AI usage meter | Placeholder hard-coded |
| Topbar search | Non-functional UI |
| Legacy `App.js` | Present, not mounted |

---

## 5. Backend Architecture

**Entry:** `backend/server.js`  
**Package:** Express, dotenv, cors, pg, jose/jsonwebtoken, bcryptjs, googleapis, nodemailer, openai, axios, cheerio, uuid

### Layering

```
routes/          HTTP adapters + validation
middleware/      auth, subscription
services/        providers (email, WhatsApp, SMS, AI, auth, unifiedSend)
utils/*Storage   persistence adapters (postgres/json)
config/          db, providers registry, scraper config
db/schema.sql    schema + migrations-by-idempotent-SQL
```

### Middleware

| Middleware | File | Behavior |
|------------|------|----------|
| `requireAuth` | `middleware/auth.js` | Bearer JWT → `req.auth = { userId, workspaceId }` |
| `requireEmailVerified` | same | Blocks unverified users (super_admin bypass) |
| `requireSubscription` | `middleware/subscription.js` | active/pending; skipped if `AUTH_MODE=disabled`; admin bypass |
| Channel gates | `server.js` | WhatsApp/Email/PayPal/integrations selective auth |

`AUTH_MODE`: `disabled` | `supabase` | `dev` | `local` (`clerk` throws).

### Services (implemented)

| Service | Responsibility |
|---------|----------------|
| `authService` | Signup/login, bcrypt, JWT, verification/reset mail |
| `emailService` | Nodemailer system + workspace send, personalization |
| `emailOAuthService` | Google OAuth + Gmail API send |
| `emailInboxService` | Gmail history/list sync; session polling while Inbox open |
| `whatsappMeta` | Meta Cloud API send/templates/media |
| `smsService` | Twilio SMS |
| `unifiedSend` | Canonical outbound + CRM writes |
| `previewSend` | Preview/trust-mode copy sends |
| `aiProvider` | heuristic \| openai qualify/outreach/reply/autonomous |
| `scoring` / `outreach` / `reply` | Heuristic engines |
| `autonomousReplyService` | Auto-reply on inbound email |
| `openAiKeyService` | Per-user key, free quota, master fallback |

### Process gaps (backend)

- No Helmet.
- No global HTTP rate limiter.
- `NODE_TLS_REJECT_UNAUTHORIZED='0'` set at boot (**critical security debt**).
- Nodemailer / some SSL paths use `rejectUnauthorized: false`.
- No in-process cron for follow-ups; `POST /api/campaign/follow-up/process-due` must be triggered.
- Inbox sync is session-scoped (while UI open), not a global worker.

---

## 6. API Architecture

Base: `/api/*` on Express. Frontend proxies to `http://localhost:5001` in dev.

### Auth — `/api/auth`

`POST signup|login|verify-email|resend-verification|forgot-password|reset-password`  
`GET|PUT /me`, `POST /change-password`, `GET|PUT /me/sender-email`

### Leads — `/api/leads`

List/filter/export, update/delete, bulk upsert/delete

### Contacts — `/api/contacts`

CRUD, CSV export, bulk import/delete (personal contacts)

### Scrape — `/api/scrape`

Config get/set, scrape execution (SerpAPI)

### AI — `/api/ai`

Qualify, scores, outreach drafts (+ approve/reject), conversations/messages, reply/auto-reply, autonomous, generate-message

### Campaign CRM — `/api/campaign`

`GET /stats`, `/channel-stats`, leads, overdue, conversations  
Status/sent/reply/follow-up endpoints, send-with-preview, test-mode

### Email — `/api/email`

Status, send/bulk, templates, receive, inbox session start/stop, sync, open/click tracking

### WhatsApp — `/api/whatsapp`

Credentials, validate, send/bulk, templates, status, Meta webhook GET/POST

### SMS — `/api/sms`

Status, send/bulk, Twilio webhook + status-callback

### Integrations — `/api/integrations`

Providers registry, connect/disconnect, OAuth URL/callback

### Billing — `/api/paypal`

Plans, subscription status, create/cancel, webhook

### Other

| Mount | Notes |
|-------|-------|
| `/api/webhook` | External order/inbound with `WEBHOOK_SECRET` |
| `/api/settings` | Preview + AI agent settings |
| `/api/openai` | Key status/set/delete/test/refill |
| `/health` | Health check |
| `/api/upload-image` | Auth upload |
| `/api/send-email` | Legacy/inline send (auth) |
| `/api/send-whatsapp` | Legacy inline — **currently lacks auth in server.js** (security debt) |

### Missing APIs (required by vision / Priority 2–3)

- `/api/automations` CRUD + execute + logs + history
- `/api/dashboard` (or expanded `/api/campaign/stats`) returning **all** required cards + historical series
- Drill-down list endpoints per metric (leads filtered by hot, meetings, deals, etc.)
- Reliable webhook signature verification APIs already exist partially; PayPal/WhatsApp signature verification must be verified/hardened (Priority 1)

---

## 7. CRM Architecture

### Two contact worlds

1. **Leads** — scraped/imported businesses; pipeline-backed (`campaigns`).
2. **Personal contacts** — `/api/contacts` address book for outreach lists.

### Pipeline statuses (canonical)

`new → sent → replied → interested → meeting → deal`  
or terminal `lost`

Timestamps: `sent_at`, `replied_at`, `interested_at`, `meeting_at`, `deal_at`, `lost_at`.

### Conversation CRM

- One conversation per `(lead, channel)`.
- Messages direction: `outbound` | `inbound`.
- Inbox UI: archive, pin, unread, AI reply, email sync session.

### Timeline

`lead_events` is the intended single activity feed (message sent/received, status changes, follow-ups, AI actions).

### Follow-ups

- Legacy columns on `campaigns` (`follow_up_1_*`, `follow_up_2_*`).
- Newer model: `follow_up_sequences` + `lead_follow_ups`.
- Processing via campaign route `process-due` (not autonomous daemon yet).

### Scoring integration

`lead_scores.priority`: `hot` | `warm` | `cold` drives AI Agent + Dashboard quality panels.

---

## 8. AI Architecture

### Mode switch (`AI_MODE`)

| Mode | Behavior |
|------|----------|
| `heuristic` (default) | Deterministic scoring + template outreach/reply |
| `openai` | LLM via OpenAI (user key and/or master `OPENAI_API_KEY`) |

### Capabilities (implemented)

| Capability | Entry |
|------------|-------|
| Qualify leads | `aiProvider.qualifyLeads` → `/api/ai/qualify` |
| Outreach drafts | `generateOutreach` → drafts storage + approve gate |
| Reply generation | `generateReply` + inbox actions |
| Autonomous decision | `autonomousDecision` → `/api/ai/autonomous` |
| Inbound email auto-reply | `autonomousReplyService` |
| Agent knowledge | User `ai_agent_config` via settings |
| Quota | Free AI messages + per-user encrypted API key |

### AI Sales Employee target behavior

When a campaign starts, AI should (target):

1. Qualify and rank scraped leads.
2. Choose channel mix (email / WhatsApp / SMS).
3. Personalize first touch in campaign language.
4. Reply to inbound with objection handling.
5. Schedule and execute follow-ups.
6. Update pipeline (interested → meeting → deal/lost).
7. Hand over closed deals with a report.

**Today:** pieces exist; orchestration is largely manual UI flows + optional auto-reply + follow-up process-due.

---

## 9. Automation Engine Design

### Current state (honest)

`AutomationsPage.tsx` is **mostly UI**:

- Templates hard-coded in frontend.
- Workflows/logs in **user-scoped localStorage**.
- Activate/deactivate do **not** execute outreach.
- KPI tiles use estimates (`activeCount * 3`, etc.).
- Optional AI shape via `/api/ai/autonomous`; falls back to a local 2-step stub.
- Copy notes that a visual builder is “coming soon.”

Related but separate automation primitives already in backend:

- Follow-up sequences + process-due
- Autonomous email reply
- External webhooks (`/api/webhook`)
- Campaign send-with-preview

### Target architecture (Priority 2)

Replace localStorage UI with a real backend engine.

#### Proposed entities (to be designed against existing Postgres patterns)

| Entity | Purpose |
|--------|---------|
| `automations` | Definition: name, enabled, workspace |
| `automation_triggers` | e.g. lead_created, score_hot, reply_received, schedule_cron, campaign_started |
| `automation_conditions` | Filters (priority, channel, country, status) |
| `automation_actions` | scrape_step, qualify, send_email, send_whatsapp, send_sms, update_status, schedule_followup, notify |
| `automation_runs` | Execution instances |
| `automation_run_logs` | Step logs, retries, errors |

#### Runtime requirements

- Trigger bus (events from `lead_events` / campaign / inbound webhooks)
- Condition evaluator
- Action executor reusing `unifiedSend`, AI services, scrape, campaign storage
- Scheduler (cron / interval worker) with retries + backoff
- Idempotency keys
- Execution history API for the Automations UI
- Workspace isolation + subscription gates

#### Frontend contract

Automations page must load/save/run exclusively via API.  
Estimated KPIs must be removed; show real `running`, `scheduled`, `succeeded`, `failed` counts.

---

## 10. Dashboard Design

### Product rules

- Never show fake numbers.
- Every card uses real backend data.
- Every card should be clickable into related records.
- Charts must use historical DB data.
- Premium enterprise SaaS look: fast, modern, minimal, professional.

### Required cards (target set)

| Card | Suggested source (existing or extend) |
|------|----------------------------------------|
| Total Leads | `leads` count |
| New Leads Today | `leads.created_at` filter |
| Qualified Leads | `lead_scores` count |
| Hot / Cold Leads | `lead_scores.priority` |
| Emails Sent / Delivered / Replies | messages + email status / channel-stats |
| WhatsApp Sent / Delivered / Replies | messages + Meta status where available |
| SMS Sent / Delivered / Replies | messages + Twilio callbacks |
| Meetings Booked | `campaigns.status = meeting` |
| Deals Won / Lost | `deal` / `lost` |
| Open Conversations | `conversations.status = open` |
| Active Campaigns | define product meaning (today: campaign rows ≠ marketing “campaigns”) |
| Running Automations | automation engine (Missing) |
| Revenue | Needs explicit revenue field/events (Missing or derive from deals) |
| Conversion / Reply / Open / Click rates | Compute from messages + tracking |
| Average AI Score | `AVG(lead_scores.score)` |
| Average Response Time | Derive from message timestamps (Missing productization) |
| Follow-ups Scheduled / Completed | `lead_follow_ups` |

### Current dashboard (`DashboardPage.tsx`)

**Real today:**

- Total leads, emails found, reachable (phone/WhatsApp), avg rating
- Hot / Warm / Cold / Unscored (scores API; may auto-qualify)
- AI messages remaining (OpenAI status)
- Channel performance sent/replies (channel-stats)

**Fetched but underused:** campaign stats (`getCampaignStats`).

**Not yet enterprise-complete:** full required card set, click-through drill-downs, historical charts, revenue, automations running, meetings/deals cards as first-class UI.

### Target UX

1. KPI grid (all required metrics).
2. Click → filtered list page or drawer (leads/conversations/campaigns).
3. Time-series charts (7/30/90 day) from DB aggregations.
4. Pipeline funnel from `campaigns.byStatus`.
5. Zero placeholders; loading skeletons only while fetching.

---

## 11. Security Standards

### Priority 1 — Critical hardening (current debt)

| Item | Current | Required |
|------|---------|----------|
| TLS verification | `NODE_TLS_REJECT_UNAUTHORIZED='0'` in `server.js`; some mail/DB SSL rejectUnauthorized false | Remove; fix root certs; never disable in production |
| Integration credentials | File JSON | Encrypt at rest (AES-256-GCM already exists in `utils/encryption.js`); prefer Postgres |
| PayPal webhooks | Public route | Verify PayPal signatures / webhook ID |
| WhatsApp webhooks | Verify token exists | Validate Meta signature (`X-Hub-Signature-256`) |
| Helmet | Absent | Add Helmet with secure defaults |
| Rate limiting | Absent globally | Add express-rate-limit (auth + send endpoints especially) |
| Production config | Mixed AUTH_MODE / secrets | Lock: strong `JWT_SECRET`, `ENCRYPTION_KEY`, CORS allow-list, `NODE_ENV=production` |
| Legacy `/api/send-whatsapp` | No auth observed | Require auth or remove |
| Secrets | `.env` / never commit | Keep out of git; complete `.env.example` |

### Standing rules

- Validate all input; parameterized SQL only (`pg` query helpers).
- Escape/sanitize HTML where rendered (frontend `MessageContent`).
- Protect API keys, OAuth tokens, JWTs.
- Never expose stacks in production (global handler already strips in production).
- bcrypt for passwords; email verification required for sensitive routes.
- Subscription gates for paid channel features.
- Super-admin list via `SUPER_ADMIN_EMAILS` only.

### Encryption already present

`backend/utils/encryption.js` — AES-256-GCM used for user OpenAI keys in `userStorage`. Extend this pattern to integration credentials.

---

## 12. Coding Standards

1. **Project first:** read existing code before changing.
2. **Minimum diff:** preserve architecture; reuse `unifiedSend`, storage utils, `apiClient`.
3. **No fake implementations:** no TODO stubs shipped as features.
4. **Workspace isolation:** every query must respect `workspace_id`.
5. **Idempotent schema:** prefer `CREATE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` like `schema.sql`.
6. **Errors:** map external API failures via existing helpers (`externalApiErrors`); never leak secrets.
7. **Modules:** routes thin; services own side effects; storage owns persistence.
8. **Frontend:** match `lf-*` design system; TypeScript for new pages; no new UI libraries without decision.
9. **Do not rewrite working code** without a production reason.
10. **Never commit** `.env`, credentials, upload dumps, or private keys.

### Workflow for every task

1. Analyze  
2. Brief plan  
3. Implement minimum files  
4. Test  
5. Fix  
6. Report what changed  
7. Report remaining work  

---

## 13. UI/UX Standards

### Product UI bar

Premium enterprise SaaS: consistent spacing, typography, colors, components; responsive; no broken layouts; no unfinished screens.

### Existing design system

- CSS variables `--lf-*` in `shell.css`
- Dark navy theme, indigo primary (`#6366f1`)
- Components: `lf-card`, `lf-btn`, `lf-pill`, alerts, skeletons, segmented controls
- Shared: `PageHeader`, `ConnectionCard`, `Logo`, `MessageContent`

### Rules aligned with autonomous product

- Dashboard and Automations must never show decorative fake metrics.
- Empty states must explain the next autonomous action (e.g. Start Campaign / Connect Gmail).
- Channel pages should emphasize campaign execution, not one-off toys.
- Landing/marketing may use static copy; authenticated app may not invent stats.

### Known UX debt

- Non-functional topbar search
- Placeholder AI usage in sidebar
- Automations “running” estimates
- README still mentions Firebase (docs drift)

---

## 14. Deployment Standards

### Current run model

| Command | Behavior |
|---------|----------|
| Root `npm run install:all` | Install frontend + backend |
| `npm run dev` | Concurrent backend + frontend |
| `npm start` | Backend serves API (+ built frontend if present) |
| `npm run build` | Frontend production build |
| Backend `db:init` | Apply `schema.sql` |

### Environment

- Backend: `backend/.env` from `.env.example` (+ undocumented secrets must be added to example carefully without real values).
- Frontend: `REACT_APP_API_URL`, `REACT_APP_AUTH_MODE`, optional Supabase vars.

### Production expectations

1. `NODE_ENV=production`
2. `STORAGE_DRIVER=postgres` + managed Postgres/Supabase
3. `AUTH_MODE=local` or `supabase` (never `disabled` in public prod)
4. TLS verification **enabled**
5. CORS allow-list = real frontend origins only
6. Helmet + rate limits enabled
7. Secrets via host env / secret manager
8. Backups enabled on Postgres
9. Process manager (systemd/PM2/container) with restart policy
10. Health check monitoring on `/health`
11. Separate worker process for schedulers (follow-ups + automations) — **target**

### Related runbooks (existing)

- `docs/S1_MIGRATION.md` — storage cutover  
- `docs/S2_AUTH.md` — auth + isolation  
- `docs/SUPABASE_GOLIVE.md` — live Supabase  
- `docs/SMOKE_TEST.md` — smoke + security checks  

---

## 15. Testing Standards

A task is **not done** until:

- Code compiles / TypeScript accepts changed files
- Backend starts
- Frontend starts
- Touched APIs work with real DB
- Errors handled; edge cases reviewed
- No console errors on happy path
- No broken routes

### Existing test assets

| Asset | Notes |
|-------|-------|
| `docs/SMOKE_TEST.md` | Manual scrape/leads/WhatsApp/export + security regressions |
| Backend scripts under `backend/scripts/` | Verification scripts (Gmail, autoreply, deliverability, etc.) |
| `npm run test:isolation` | Workspace isolation |
| Frontend `textDirection.test.ts` | Unit test example |
| Ad-hoc `test-*.js` files | Dev utilities — not a full suite |

### Target test pyramid

1. **Unit:** scoring, encryption, condition evaluator, rate helpers  
2. **Integration:** auth, campaign status transitions, unifiedSend writes  
3. **API smoke:** authenticated GETs for each mounted router  
4. **Security:** TLS on, webhook signatures reject bad payloads, rate limit triggers  
5. **E2E (later):** Start Campaign happy path across scrape → qualify → send → reply → pipeline  

No mocked “success” responses that hide broken providers in production builds.

---

## 16. Sprint Roadmap

### CTO Implementation Order (locked)

1. Critical Security  
2. Production Stability  
3. Automation Engine  
4. Dashboard  
5. CRM  
6. AI  
7. WhatsApp  
8. Email  
9. SMS  
10. Analytics  
11. Billing  
12. Remaining improvements  

### Sprint A — Critical Security Hardening (Priority 1) — DONE 2026-07-23

1. [x] Remove global `NODE_TLS_REJECT_UNAUTHORIZED=0`; TLS verify via `config/tls.js`  
2. [x] Encrypt integration credentials at rest (`credentialsEnc` AES-256-GCM)  
3. [x] Verify PayPal webhooks (`middleware/paypalWebhook.js` + `PAYPAL_WEBHOOK_ID`)  
4. [x] Verify WhatsApp Meta signatures (`X-Hub-Signature-256` + `WHATSAPP_APP_SECRET`)  
5. [x] Helmet-equivalent security headers (`middleware/security.js`)  
6. [x] Rate limiting (api / auth / send / webhook)  
7. [x] Auth-protect legacy `/api/send-whatsapp`; send rate limits  
8. [x] Production config lock + expanded `.env.example`  
9. [x] Hide debug conversation/version endpoints in production  

Note: Official `helmet` / `express-rate-limit` npm packages could not be installed in this environment (npm registry TLS leaf cert failure). Equivalent production middleware was implemented in-repo. Swap to official packages when registry TLS works.

### Sprint A2 — Production Stability (in progress)

1. [x] Remove Automations estimated KPIs (`activeCount * N`)  
2. [x] Sidebar AI usage → real `/api/openai/status` (or hide if unavailable)  
3. [x] WhatsApp/SMS KPI fallbacks no longer invent localStorage counters  
4. [x] Always-on follow-up worker (process-due on interval)  
5. [x] Re-verify Email CRM audit criticals (OAuth scopes, inbox CRM)  
   - campaignStorage import in emailInboxService: already present  
   - draftStorage broken JSON path: **fixed** (restored full API, removed Firebase)  
   - Gmail OAuth scope request/validation: already in integrations.js (`mail.google.com`) — remaining risk is Google Cloud Console consent config (ops, not code)  
6. [x] README Firebase drift cleanup

### Sprint B — Real Automation Engine (Priority 2) — IN PROGRESS (foundation live)

1. [x] Schema for automations + runs + logs (`schema.sql` S15)  
2. [x] `automationStorage` + `/api/automations` CRUD/stats/runs/logs  
3. [x] `automationEngine` with real actions: `qualify_leads`, `update_campaign_status`, `schedule_followup`, `log_only`  
4. [x] Automations UI wired to backend (no localStorage KPIs / no estimated metrics)  
5. [x] Event bus wiring (`lead_created`, `score_hot`, `reply_received`) into `dispatchEvent`  
6. [x] Channel send actions via `unifiedSend` (`send_whatsapp`, `send_email`, `send_sms`)  
7. [ ] Retry/backoff policies + scheduler triggers (`trigger_type=schedule`)  

### Sprint C — Enterprise Dashboard (Priority 3) — IN PROGRESS

1. [x] `/api/dashboard/metrics` — full real KPI set from storage  
2. [x] `/api/dashboard/drilldown` — related records  
3. [x] Dashboard UI rebuilt with clickable cards + pipeline/channel panels  
4. [x] Historical 14-day series from `lead_events` timeline  
5. [ ] Delivered/open/click rates when tracking data is complete  

### Sprint B remaining

7. [x] Schedule triggers (`automationScheduler` + `trigger_type=schedule`)  
8. [ ] Retry/backoff policies for failed automation runs  

### Sprint C — Enterprise Dashboard (Priority 3)

1. Expand stats API for all required metrics  
2. Historical aggregations  
3. Rebuild Dashboard UI with clickable cards + charts  
4. Drill-down routes/filters  

### Sprint D — Channel / CRM / AI polish (after C)

CRM status consistency → AI orchestrator → WhatsApp/Email/SMS reliability → Analytics → Billing hardening.

### Sprint E — Autonomous Campaign Orchestrator (vision)

Single API/UI action: create campaign inputs → scrape → qualify → multi-channel outreach → auto-reply → follow-ups → pipeline → report.

---

## 16.1 Full Audit Snapshot (2026-07-23)

### Fake / non-production UI (addressed or remaining)

| Item | Status |
|------|--------|
| Automations estimated KPIs | Fixed — honest local counts + engine-pending zeros |
| Sidebar AI usage placeholder | Fixed — real OpenAI quota |
| WA/SMS localStorage fake stat fallbacks | Fixed — API-only zeros |
| Automations localStorage engine | Remaining — needs Sprint B |
| Topbar search non-functional | Remaining (low) |
| WhatsApp demo templates when unconfigured | Done — empty list + setup message (no fake templates) |

### Security (pre-fix → post-fix)

| Issue | Status |
|-------|--------|
| Global TLS disable | Fixed |
| Mail/IMAP/DB `rejectUnauthorized: false` | Fixed (opt-in `TLS_INSECURE_ALLOW`) |
| Integration credentials plaintext JSON | Fixed (encrypted at rest) |
| PayPal webhook unsigned | Fixed (verify API) |
| WhatsApp POST unsigned | Fixed (HMAC) |
| No Helmet / rate limits | Fixed (in-repo) |
| Unauthenticated `/api/send-whatsapp` | Fixed |
| Debug endpoints public | Fixed (auth + prod 404) |
| Production AUTH_MODE=disabled risk | Locked via assertProductionConfig |

### Architecture weaknesses (remaining)

- Postgres TLS to Supabase may fail on corporate MITM machines (JSON fallback)  
- Integrations still file-based (encrypted) — prefer Postgres later  
- Start Campaign does not yet auto-blast (intentional gate) or discover emails deeply  
- Email bounce / DSN handling still missing  
- Meeting booking / handover still mostly manual  

---

## 17. Current Completion Status

**Honest overall: ~93%** (security v3 landed; not “done” until E2E smoke + secrets + TLS/DB healthy)

### Completed / largely working

| Module | Status |
|--------|--------|
| Authentication (local JWT, verify, reset) | Done |
| AI Qualification (heuristic + OpenAI) | Done |
| AI Outreach drafts + approve gate | Done |
| Lead Scraper (SerpAPI) | Done |
| Gmail Integration (OAuth + send + inbox session) | Mostly done (audit historically flagged critical scope/inbox issues — re-verify) |
| Email CRM | Mostly done |
| WhatsApp CRM (Meta) | Mostly done (delivered/read → timeline) |
| SMS Module (Twilio) | Done (basic) |
| Campaign / pipeline system | Done (no demotion on resend; Leads stage control) |
| Contacts (personal) | Done |
| Dashboard | Real KPI API + drill-downs + WA delivery rates |
| OpenAI key + quota | Done |
| CRM pipeline statuses | Done |
| PayPal subscription plumbing | Present |
| Settings / AI agent knowledge | Done |
| Unified inbox | Done |
| Follow-up storage + worker | Present (Postgres TLS may block remote ticks) |
| Automation Engine | Backend schema + runtime + schedule/retry + UI |
| Start Campaign orchestrator | Foundation live (scrape → email discovery → CRM → qualify → follow-ups; send gated) |
| Reports | Live `/api/reports/performance` + Reports UI |

### Incomplete / weak

| Module | Status |
|--------|--------|
| Email bounce / delivery receipts | Open/click pixels + DSN bounce detection on inbox sync |
| Objection playbooks as first-class automations | `handle_objection` action + template (autoSend gated) |
| Revenue analytics | Partial (0 unless deal has amount) |
| Business verification / deep email discovery | Partial |
| Meeting booking / handover automation | Handover JSON package on deal; calendar booking still missing |
| Auto-send from Start Campaign | Gated (needs channel config + explicit enable) |
| Calendar / meeting booking | Missing |
| Revenue analytics | Partial (0 unless deal has amount) |

### Documentation honesty note

`PRODUCTION_READINESS_REPORT.md` (2026-07-04) claimed production-ready after Firebase removal.  
`EMAIL_CRM_AUDIT_REPORT.md` (2026-07-06) still listed critical Gmail issues.  
This master plan treats **security + automation + real dashboard** as higher priority than cosmetic polish, and does **not** treat the product as production-complete.

---

## 18. Remaining Features

Ordered by CTO priority, not by novelty.

### P1 — Security

- [x] Enable TLS verification everywhere  
- [x] Encrypt + harden integration credential storage  
- [x] PayPal webhook verification  
- [x] WhatsApp signature verification  
- [x] Helmet-equivalent headers  
- [x] Global/route rate limits  
- [x] Lock production configuration  
- [x] Fix unauthenticated legacy send endpoints  
- [x] HMAC-signed email open/click tracking tokens + inject on send  
- [x] Twilio webhook / status-callback signature verification  
- [x] Upload MIME allowlist + size + magic-byte + email-verified gate  
- [x] Fail-closed `WEBHOOK_SECRET` (external + email receive; required in prod lock)  
- [x] HMAC-signed OAuth `state` (anti workspace takeover) + origin-restricted postMessage  
- [x] WhatsApp verify token: no hard-coded default; required in prod  
- [x] Attachment path jail under `uploads/`  
- [x] Shared `workspaceOf` ignores spoofable `x-user-id` when AUTH_MODE is real  
- [x] External webhook workspace pinned (`WEBHOOK_WORKSPACE_ID` / default)  

### P2 — Automation Engine

- [x] Backend automation schema + APIs  
- [x] Trigger / condition / action runtime  
- [x] Scheduling + retries + logs + history  
- [x] Replace Automations frontend persistence  
- [x] Real running-automation metrics  

### P3 — Dashboard

- [x] Full required metric set from DB  
- [x] Clickable cards + drill-downs  
- [x] Historical charts (14-day series)  
- [x] Meetings / deals / revenue / rates / follow-ups / open conversations / active campaigns  
- [x] WhatsApp delivered/read rates from timeline  
- [x] Emails delivered, SMS delivered, pipeline value, AI success rate  

### P4 — Production & Autonomy

- [x] Background workers (follow-ups, automations; optional inbox still manual)  
- [x] Start Campaign orchestrator (foundation; auto-send gated)  
- [x] Objection handling playbooks as first-class automation (`handle_objection` action)  
- [x] Customer handover package (`GET /api/campaign/handover/:leadId` + auto on deal)  
- [x] Reports module (`/api/reports/performance` + `/app/reports`)  
- [x] README/docs accuracy (Firebase drift removed)  
- [ ] Dependency audit + monitoring  
- [x] Email bounce / DSN handling (inbox sync → `email_bounced` timeline)  
- [x] Start Campaign email discovery (website scrape, capped)  
- [x] Subscription expiry enforcement + scrape/start gates  

### Stabilization log (2026-07-23)

- [x] Fix automation retry infinite loop (require `nextRetryAt`; mark `superseded`)  
- [x] Fix delay-resume race (claim → resume → succeed; restore on failure)  
- [x] Public SMS webhook / status-callback (Twilio)  
- [x] Public email tracking open/click (pixels)  
- [x] Email receive webhook secret gate  
- [x] Public PayPal `/plans`  
- [x] AI send paths require subscription + send rate limit  
- [x] Campaign status `getOrCreate` (no silent null)  
- [x] Click tracking http(s)-only redirect + prefer signed `targetUrl`  
- [x] Unify Reports with Dashboard metrics source  
- [x] Honest Emails Delivered (no sent−bounce invention)  
- [x] Remove dead `frontend/src/App.js`  
- [x] `npm run test:stabilize` smoke suite  
- [x] HMAC email tracking tokens + pixel/link injection on send  
- [x] Twilio `X-Twilio-Signature` on SMS webhook + status-callback  
- [x] Upload harden (image/* only, 5MB, magic bytes, requireEmailVerified)  
- [x] Quarantine Firebase migration/cleanup scripts (exit stubs; JSON migrate only)  
- [x] `/api/whatsapp-status` requires auth  
- [x] Security v3: webhook fail-closed, OAuth state HMAC, WA verify token, upload jail, SSRF  

### Explicit non-priorities (until P1–P3 advance)

- Decorative UI redesigns
- New channels beyond email/WhatsApp/SMS
- Fake demo modes that invent metrics

---

## 19. Production Checklist

### Blockers before public production

- [x] `NODE_TLS_REJECT_UNAUTHORIZED` not disabled  
- [x] Helmet-equivalent headers enabled (in-repo; npm helmet blocked by TLS)  
- [x] Rate limiting on auth and send paths  
- [x] Integration secrets encrypted (and not world-readable JSON in prod)  
- [x] PayPal webhook signature verified (needs `PAYPAL_WEBHOOK_ID` set)  
- [x] WhatsApp webhook signature verified (needs `WHATSAPP_APP_SECRET` set)  
- [ ] `AUTH_MODE` not `disabled` on public internet  
- [ ] Strong `JWT_SECRET` + `ENCRYPTION_KEY` set  
- [ ] CORS allow-list = production frontend only  
- [ ] Postgres backups enabled  
- [x] No fake Automations/Dashboard/WhatsApp pipeline statistics in UI  
- [x] Legacy unauthenticated send routes fixed  
- [ ] `/health` monitored  
- [ ] Gmail OAuth scopes sufficient for send + inbox (re-verify audit items)  
- [ ] `npm audit` reviewed for backend + frontend  

### Launch readiness (post-blockers)

- [ ] Smoke test (`docs/SMOKE_TEST.md`) PASS  
- [ ] Isolation test PASS  
- [ ] Subscription gates verified  
- [ ] Super-admin bootstrap verified  
- [x] Error responses hide stacks in production  
- [x] Upload and static paths secured (MIME allowlist + size + magic bytes + auth)  
- [x] Worker process for due follow-ups (minimum)  

### Operational

- [ ] Log aggregation  
- [ ] Alerting on 5xx and provider rate limits  
- [ ] Documented rollback (`STORAGE_DRIVER` / previous build)  

---

## 20. Future Vision

### Near-term (complete the employee)

LeadFlow AI becomes a system where creating a campaign is the **only** required human step for standard outbound sales motions. Scraping, qualification, multi-channel outreach, replies, follow-ups, and pipeline updates run under the Automation Engine with full audit logs.

### Mid-term

- True multi-user workspaces (beyond 1:1 user=workspace)
- Shared inboxes and role-based access
- Meeting booking integrations (calendar)
- Revenue attribution per campaign
- Deliverability intelligence (domain health, bounce handling)
- Multilingual objection libraries tied to AI agent config

### Long-term

LeadFlow AI is recognized as the world’s best **Autonomous AI Sales Employee**:

- Continuous learning from won/lost deals within a workspace
- Cross-channel memory per lead
- Autonomous budget/pacing controls
- Human approval only for exceptions (compliance, high-value deals, escalation)

### Success definition (unchanged)

LeadFlow AI is successful **only** when a customer can create a campaign and the AI performs the complete sales workflow with minimal human intervention.

If a feature does not contribute to that vision, it is not a priority.

---

## Appendix A — Repository map (quick)

```
backend/
  server.js
  routes/          auth, leads, contacts, scrape, ai, whatsapp, campaign,
                   email, integrations, sms, paypal, webhook, settings, openai
  services/        auth, email*, whatsapp, sms, ai*, unifiedSend, previewSend
  middleware/      auth, subscription
  utils/           *Storage, encryption, gmail*, email*
  config/          db, providers, scraperConfig
  db/schema.sql
frontend/src/
  index.tsx, app/*, features/*, lib/apiClient.ts, auth/*, components/*
docs/
  LEADFLOW_AI_MASTER_PLAN.md   ← this file
  S1_MIGRATION.md, S2_AUTH.md, SUPABASE_GOLIVE.md, SMOKE_TEST.md
```

## Appendix B — Priority reminder

1. **Critical Security Hardening**  
2. **Real Automation Engine**  
3. **Professional Enterprise Dashboard**  
4. **Production Readiness**  

All future work in this repository must align with this master plan.

---

*End of LeadFlow AI Master Plan.*
