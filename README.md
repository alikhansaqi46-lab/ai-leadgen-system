# LeadFlow AI

Autonomous AI Sales Employee by NovaCore Technologies.

Full-stack SaaS for scraping, qualifying, and multi-channel outreach (Email, WhatsApp, SMS) with CRM pipeline, AI replies, and automations.

## Tech Stack

- **Frontend:** React 18 + TypeScript (Create React App), React Router 6
- **Backend:** Node.js + Express
- **Database:** PostgreSQL / Supabase (`STORAGE_DRIVER=postgres`) with JSON file fallback
- **Auth:** Local JWT (`AUTH_MODE=local`) or Supabase JWT (`AUTH_MODE=supabase`)
- **Scraping:** SerpAPI (Google Maps engine)
- **Messaging:** WhatsApp Meta Cloud API, Gmail OAuth/API, Twilio SMS
- **Billing:** PayPal subscriptions
- **AI:** Heuristic engine or OpenAI (`AI_MODE`)

## Features

- Lead scrape → qualify → score (hot/warm/cold)
- Multi-channel CRM pipeline (`new → sent → replied → interested → meeting → deal/lost`)
- Unified inbox with AI replies
- Gmail OAuth send + session inbox sync
- WhatsApp Meta send/templates/webhooks (signature-verified)
- SMS via Twilio
- Follow-up sequences + background worker
- Automation engine (backend) — see `docs/LEADFLOW_AI_MASTER_PLAN.md`
- PayPal subscription gates

## Project Structure

```
AI-LeadGen-system/
├── frontend/src/     # App shell, features, apiClient
├── backend/
│   ├── server.js
│   ├── routes/
│   ├── services/
│   ├── middleware/
│   ├── utils/        # *Storage layers
│   ├── config/
│   └── db/schema.sql
├── docs/
│   └── LEADFLOW_AI_MASTER_PLAN.md   # Permanent project brain
└── package.json
```

## Quick Start

```bash
npm run install:all
# Configure backend/.env from backend/.env.example
# Set JWT_SECRET, ENCRYPTION_KEY, DATABASE_URL, AUTH_MODE=local, SERPAPI_KEY, …
cd backend && npm run db:init
cd .. && npm run dev
```

- Frontend: http://localhost:3000  
- Backend: http://localhost:5001  
- Health: `GET /health`

## Security (production)

Production boot **fails** unless:

- `AUTH_MODE` is not `disabled` or `dev`
- `JWT_SECRET` is strong (≥32 chars)
- `ENCRYPTION_KEY` is 64 hex chars
- `TLS_INSECURE_ALLOW` is not `true`
- `ALLOWED_ORIGINS` or `FRONTEND_URL` is set

Also set: `WHATSAPP_APP_SECRET`, `PAYPAL_WEBHOOK_ID`, `WEBHOOK_SECRET`, `TWILIO_AUTH_TOKEN` / `TWILIO_WEBHOOK_BASE_URL`, optional `EMAIL_TRACKING_SECRET`.

See `docs/LEADFLOW_AI_MASTER_PLAN.md` §11 and §19.

## Documentation

| Doc | Purpose |
|-----|---------|
| `docs/LEADFLOW_AI_MASTER_PLAN.md` | Vision, architecture, roadmap |
| `docs/S1_MIGRATION.md` | Postgres cutover |
| `docs/S2_AUTH.md` | Auth + workspace isolation |
| `docs/SUPABASE_GOLIVE.md` | Live Supabase |
| `docs/SMOKE_TEST.md` | Smoke checklist |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run install:all` | Install frontend + backend |
| `npm run dev` | Concurrent backend + frontend |
| `npm run build` | Frontend production build |
| `npm start` | Backend only |
| `cd backend && npm run test:security` | Security regression checks |
| `cd backend && npm run test:stabilize` | Stabilization smoke checks |
| `cd backend && npm run test:isolation` | Workspace isolation tests |

## License

Private — NovaCore Technologies.
