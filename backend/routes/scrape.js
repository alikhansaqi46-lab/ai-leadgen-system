const express = require("express");
const router = express.Router();
const axios = require("axios");
const storage = require('../utils/leadStorage');
const userStorage = require('../utils/userStorage');
const { v4: uuidv4 } = require('uuid');
const { extractEmailsForLeads } = require('../utils/emailExtractor');

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/* ==================== Known city lists for parsing ==================== */
const MALAYSIA_CITIES = new Set([
  'kuala lumpur','petaling jaya','johor bahru','george town','ipoh','shah alam',
  'subang jaya','klang','kuantan','kota kinabalu','malacca','seremban','sandakan',
  'miri','kuala terengganu','alor setar','muar','batu pahat','bintulu','taiping',
  'ampang','seberang perai','kajang','sungai petani','kota bharu','kulim','kluang',
  'mentakab','temerloh','bentong','kuantan','puchong','cyberjaya','putrajaya',
  'ampang jaya','tawau','lahad datu','keningau','kota samarahan','sibu','bintulu',
  'miri','sri aman','sarikei','bintangor','marudi','lawas','limbang','beaufort',
  'kota belud','kota marudu','kudat','papar','penampang','tuaran','ranau','kinabatangan',
  'sandakan','semporna','tawau','lahad datu','sabah','sarawak','selayang','gombak',
  'wangsa maju','setapak','sentul','cheras','bandar sunway','damansara','ttdi',
  'mont kiara','bangsar','mid valley','klcc','bukit bintang','pavilion',
]);

function parseCityFromAddress(address) {
  if (!address || address === 'N/A') return 'N/A';
  const lower = address.toLowerCase();
  const parts = address.split(',').map(p => p.trim()).filter(Boolean);

  // 1. Exact match against known cities
  for (const city of MALAYSIA_CITIES) {
    if (lower.includes(city)) {
      return city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  }

  // 2. Postcode heuristic: Malaysia postcode is 5 digits, city usually follows
  const postcodeIdx = parts.findIndex(p => /^\d{5}$/.test(p.trim()));
  if (postcodeIdx >= 0 && parts[postcodeIdx + 1]) {
    return parts[postcodeIdx + 1];
  }

  // 3. Filter out floor/unit/room fragments, then take last reasonable part
  const blacklist = /^(first|second|third|fourth|fifth|unit|suite|room|lot|no\.|level|floor|blk|block|e-\d|g-\d|\d+\.\d+|\d+-\d+|shop|office|kiosk|stall|bazaar)/i;
  const candidates = parts.filter(p => !blacklist.test(p.trim()) && p.trim().length > 2 && !/^\d+$/.test(p.trim()));

  // 4. Prefer the second-to-last candidate (before country/state)
  if (candidates.length >= 2) return candidates[candidates.length - 2];
  if (candidates.length === 1) return candidates[0];

  // 5. Fallback to second-to-last raw part
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[0] || 'N/A';
}

/* ==================== Config endpoints ==================== */

router.get("/config", async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const apiKey = await userStorage.getSerpApiKey(userId);
    res.json({ configured: !!apiKey });
  } catch (err) {
    console.error('[Scrape] Config fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

router.post("/config", async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { serpApiKey } = req.body;
    if (!serpApiKey || typeof serpApiKey !== 'string') {
      return res.status(400).json({ error: 'serpApiKey is required' });
    }
    await userStorage.setSerpApiKey(userId, serpApiKey.trim());
    res.json({ success: true, configured: true });
  } catch (err) {
    console.error('[Scrape] Config save failed:', err.message);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

/* ==================== Scrape endpoint ==================== */

router.get("/", async (req, res) => {
  console.log("SCRAPE HIT", req.query);

  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const SERPAPI_KEY = await userStorage.getSerpApiKey(userId);

    if (!SERPAPI_KEY) {
      console.error("[Scrape] SERPAPI_KEY is not configured for user:", userId);
      return res.status(503).json({
        error: "Scraping is not configured. Enter your SerpAPI key in the scraper settings.",
        setupRequired: true,
        leads: []
      });
    }

    const { keyword, location } = req.query;
    const limit = parseInt(req.query.limit, 10) || 20;

    if (!keyword || !location) {
      return res.status(400).json({
        error: "Missing keyword or location",
        leads: []
      });
    }

    // Clean location: remove any trailing scope suffix like ", city", ", state"
    const cleanLocation = location.replace(/,\s*(city|state|country)$/i, '').trim();
    const searchQuery = `${keyword} in ${cleanLocation}`;

    const allRaw = [];
    let page = 0;
    let startOffset = 0;
    const MAX_PAGES = Math.min(Math.ceil(limit / 20) + 1, 25); // safety cap at 25 pages

    console.log(`[Scrape] Starting: "${searchQuery}" | limit=${limit} | maxPages=${MAX_PAGES}`);

    do {
      page++;
      const params = {
        engine: "google_maps",
        q: searchQuery,
        type: "search",
        api_key: SERPAPI_KEY,
        start: startOffset
      };

      console.log(`[SerpAPI] Fetching page ${page} (start=${startOffset})…`);
      const response = await axios.get("https://serpapi.com/search.json", {
        params,
        timeout: 30000
      });

      const pageResults = response.data.local_results || [];
      const pagination = response.data.serpapi_pagination || {};
      const hasNext = !!pagination.next;
      console.log(`[SerpAPI] Page ${page}: ${pageResults.length} results | hasNext=${hasNext}`);
      allRaw.push(...pageResults);

      // Stop if we got fewer than a full page (no more results)
      if (pageResults.length < 20) {
        console.log(`[SerpAPI] Partial page (${pageResults.length} results), no more pages.`);
        break;
      }

      // Stop early if we've hit the requested limit
      if (allRaw.length >= limit) {
        console.log(`[SerpAPI] Hit requested limit (${limit}), stopping pagination.`);
        break;
      }

      // Increment offset for next page
      startOffset += 20;
    } while (startOffset < limit * 2 && page < MAX_PAGES);

    console.log(`[SerpAPI] Total merged raw results: ${allRaw.length}`);

    // Deduplicate by phone (fallback to name)
    const seen = new Set();
    const deduped = [];
    for (const place of allRaw) {
      const key = (place.phone || place.title || "").toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(place);
    }

    console.log(`[SerpAPI] After dedupe: ${deduped.length}`);

    const leads = deduped.map((place) => {
      const fullAddress = place.address || "N/A";
      return {
        id: uuidv4(),
        name: place.title || "Unknown",
        address: fullAddress,
        phone: place.phone || "N/A",
        website: place.website || "N/A",
        email: "N/A",
        city: parseCityFromAddress(fullAddress),
        country: location.split(',').slice(-1)[0]?.trim() || location,
        location: location,
        niche: keyword,
        rating: place.rating || null,
        reviews: place.reviews || null,
        source: "serpapi"
      };
    });

    // Extract emails from websites
    console.log(`[Scrape] Extracting emails from ${leads.filter(l => l.website && l.website !== 'N/A').length} websites…`);
    await extractEmailsForLeads(leads, 5);

    // Save to persistent storage (deduplicates against existing)
    const workspaceId = (req.auth && req.auth.workspaceId) || undefined;
    const saved = await storage.addLeads(leads, { workspaceId });
    console.log(`[Scrape] Saved ${saved.length} new leads (${leads.length - saved.length} duplicates skipped)`);

    // Return only the SAVED leads — every one has a real UUID in persistent storage
    console.log("SCRAPE SUCCESS", saved.length);
    return res.json({ leads: saved, savedCount: saved.length, totalScraped: leads.length });

  } catch (err) {
    console.error("SCRAPE ERROR", err.message);
    if (err.response) {
      console.error("SerpAPI response status:", err.response.status, err.response.data);
    }
    return res.status(500).json({
      error: err.message,
      leads: []
    });
  }
});

module.exports = router;
