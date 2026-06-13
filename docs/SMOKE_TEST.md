# Smoke Test Checklist

Run this quick checklist after any change (and as the merge gate for every milestone)
to confirm the four core flows still work. It should take ~5 minutes.

## Prerequisites
- [ ] `backend/.env` is set with at least `SERPAPI_KEY` (scraping returns 503 without it).
- [ ] Backend running: `npm run dev:backend` (default http://localhost:5001).
- [ ] Frontend running: `npm run dev:frontend` (http://localhost:3000).
- [ ] Health check OK: `curl http://localhost:5001/health` returns 200.

---

## 1. Google Maps Scraping
- [ ] In the UI, enter a keyword (e.g. "restaurants"), country, and city, then start scraping.
- [ ] Results appear and a success message shows the saved/duplicate counts.
- [ ] API check: `curl "http://localhost:5001/api/scrape?keyword=restaurants&location=Austin,%20TX"` returns `leads` JSON.
- [ ] Negative check: with `SERPAPI_KEY` unset, `/api/scrape` returns HTTP 503 with a clear "not configured" message (no crash).

## 2. Lead Management
- [ ] Scraped leads show in the table with name/phone/address/etc.
- [ ] `curl http://localhost:5001/api/leads` returns the persisted leads.
- [ ] Filters endpoint works: `curl http://localhost:5001/api/leads/filters`.
- [ ] Delete a lead in the UI → it disappears and stays gone after refresh (persistence).
- [ ] Re-scraping the same query does NOT create duplicates (phone/name de-dup works).

## 3. WhatsApp Sending
- [ ] `curl http://localhost:5001/api/whatsapp/status` returns a JSON status (configured true/false).
- [ ] If credentials are NOT set: a send attempt returns HTTP 503 "WhatsApp not configured" (no crash).
- [ ] If credentials ARE set (or `WHATSAPP_TEST_MODE=true`): a single send / small bulk send returns success with message IDs (test mode logs without really sending).
- [ ] Webhook verify: `curl "http://localhost:5001/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<VERIFY_TOKEN>&hub.challenge=123"` echoes `123`.

## 4. CSV Export
- [ ] In the UI, click Export → a CSV downloads with the expected columns (Name, Phone, WhatsApp, Email, Website, Address, City, Area, Country, Niche, Rating, Reviews).
- [ ] Server-side export works: `curl -L http://localhost:5001/api/leads/export -o leads.csv` produces a non-empty CSV.
- [ ] Open the CSV and confirm rows match the leads in the UI.

---

## Security regression checks (added in S0)
- [ ] No hardcoded SerpAPI key in `backend/routes/scrape.js` (key comes only from `SERPAPI_KEY`).
- [ ] No OpenAI key referenced in the frontend bundle (`grep -r REACT_APP_OPENAI_API_KEY frontend/src` returns nothing).
- [ ] With `NODE_ENV=production`, a forced 500 returns `{ "error": "Internal Server Error" }` with **no** `stack`/`message` field.
- [ ] CORS: a request from an origin NOT in `ALLOWED_ORIGINS` is rejected by the browser; allowed origins succeed.

## Result
- [ ] All four core flows pass.
- [ ] All security regression checks pass.
- Tester: ______________  Date: ____________  Commit/branch: ____________
