# AI Lead Generation System

Full-stack web application for scraping and managing business leads from Google Maps.

## Tech Stack

- **Frontend:** React (Create React App)
- **Backend:** Node.js + Express
- **Database:** Firebase Firestore (optional) with a file-based JSON fallback (`backend/data/`)
- **Scraping:** SerpAPI (Google Maps engine)
- **Messaging:** WhatsApp via Meta Cloud API (Twilio path also available); email via Gmail SMTP

## Features

- Scrape business leads from Google Maps (via SerpAPI)
- Store leads in Firestore (or file-based fallback) with phone/name de-duplication
- Filter leads by country and niche
- Export leads to CSV
- WhatsApp outreach (Meta Cloud API): single, bulk, templates, webhook auto-reply
- Email outreach via Gmail SMTP
- Modern, responsive UI

## Project Structure

```
ai-leadgen-system/
├── frontend/          # React application
│   ├── src/
│   │   ├── App.js    # Main app component
│   │   ├── index.js  # Entry point
│   │   └── index.css # Styles
│   └── public/
├── backend/           # Node.js API
│   ├── config/       # Firebase config
│   ├── routes/       # API routes
│   ├── server.js     # Entry point
│   └── package.json
├── package.json      # Root workspace config
└── README.md
```

## Setup Instructions

### 1. Prerequisites

- Node.js 18+
- A SerpAPI key (https://serpapi.com) for Google Maps scraping
- (Optional) Firebase project with Firestore enabled — without it, leads persist to `backend/data/leads.json`
- (Optional) WhatsApp Meta Cloud API credentials for outreach

### 2. Firebase Setup

1. Create a Firebase project at https://console.firebase.google.com
2. Enable Firestore Database
3. Generate a service account key:
   - Project Settings → Service Accounts → Generate new private key
   - Save as `backend/serviceAccountKey.json`

Or use environment variables:
```
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_PRIVATE_KEY=your_private_key
FIREBASE_CLIENT_EMAIL=your_client_email
```

### 3. Installation

```bash
# Install all dependencies
npm run install:all
```

### 4. Environment Variables

Copy the example files and fill in your credentials:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Key variables:

| Variable | Where | Required | Notes |
|----------|-------|----------|-------|
| `SERPAPI_KEY` | backend | Yes (for scraping) | No default — `/api/scrape` returns 503 if unset |
| `PORT` | backend | No | Defaults to `5001` |
| `NODE_ENV` | backend | No | In `production`, error responses omit stack traces |
| `ALLOWED_ORIGINS` | backend | No | Comma-separated CORS allow-list (falls back to `FRONTEND_URL`, then localhost) |
| `EMAIL_USER` / `EMAIL_PASS` | backend | No | Gmail SMTP; email sending disabled if unset |
| `WHATSAPP_TOKEN` / `PHONE_NUMBER_ID` | backend | No | Meta Cloud API; can also be set at runtime via the UI |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | backend | No | Must match the token configured in Meta Developers |
| `FIREBASE_*` | backend | No | Enables Firestore; otherwise file-based storage is used |
| `REACT_APP_API_URL` | frontend | No | API base URL; empty = same origin |

> Security: do **not** put an OpenAI key in the frontend. AI generation is moving server-side; the browser must never receive the key.

### 5. Running the App

```bash
# Start both frontend and backend
npm run dev

# Or run separately:
npm run dev:backend   # Backend on http://localhost:5001
npm run dev:frontend  # Frontend on http://localhost:3000
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/scrape?keyword=&location=` | Scrape Google Maps via SerpAPI |
| GET | `/api/leads` | Get all leads (with filters) |
| GET | `/api/leads/filters` | Get unique countries/niches |
| GET | `/api/leads/export` | Export leads to CSV |
| DELETE | `/api/leads/:id` | Delete a lead |
| POST | `/api/leads/bulk` | Bulk add leads |
| POST | `/api/leads/bulk-delete` | Bulk delete leads |
| POST | `/api/whatsapp/credentials` | Save WhatsApp Meta credentials |
| GET | `/api/whatsapp/status` | WhatsApp configuration status |
| POST | `/api/whatsapp/send-bulk` | Bulk WhatsApp send |
| GET/POST | `/api/whatsapp/webhook` | Meta webhook (verify / receive) |
| POST | `/api/send-email` | Send an email to a lead |

## Usage

1. Open the app at http://localhost:3000
2. Enter a business type/keyword (e.g., "restaurants")
3. Optionally add location, country, and niche
4. Click "Start Scraping" to collect leads
5. Use filters to narrow down results
6. Export leads to CSV when ready

## License

MIT
