# AI Lead Generation System

Full-stack web application for scraping and managing business leads from Google Maps.

## Tech Stack

- **Frontend:** React
- **Backend:** Node.js + Express
- **Database:** Firebase Firestore
- **Scraping:** Puppeteer (Google Maps)

## Features

- Scrape business leads from Google Maps
- Store leads in Firebase database
- Filter leads by country and niche
- Export leads to CSV
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
- Firebase project with Firestore enabled
- Google account (for Google Maps scraping)

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

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

### 5. Running the App

```bash
# Start both frontend and backend
npm run dev

# Or run separately:
npm run dev:backend   # Backend on http://localhost:5000
npm run dev:frontend  # Frontend on http://localhost:3000
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/leads` | Get all leads (with filters) |
| GET | `/api/leads/filters` | Get unique countries/niches |
| GET | `/api/leads/export` | Export leads to CSV |
| DELETE | `/api/leads/:id` | Delete a lead |
| POST | `/api/scrape/google-maps` | Scrape Google Maps |

## Usage

1. Open the app at http://localhost:3000
2. Enter a business type/keyword (e.g., "restaurants")
3. Optionally add location, country, and niche
4. Click "Start Scraping" to collect leads
5. Use filters to narrow down results
6. Export leads to CSV when ready

## License

MIT
