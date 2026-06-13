const express = require("express");
const router = express.Router();
const axios = require("axios");
const storage = require('../utils/leadStorage');
const { v4: uuidv4 } = require('uuid');

const SERPAPI_KEY = process.env.SERPAPI_KEY;

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

router.get("/", async (req, res) => {
  console.log("SCRAPE HIT", req.query);

  try {
    if (!SERPAPI_KEY) {
      console.error("[Scrape] SERPAPI_KEY is not configured");
      return res.status(503).json({
        error: "Scraping is not configured. Set the SERPAPI_KEY environment variable.",
        setupRequired: true,
        leads: []
      });
    }

    const { keyword, location } = req.query;

    if (!keyword || !location) {
      return res.status(400).json({
        error: "Missing keyword or location",
        leads: []
      });
    }

    const allRaw = [];
    let nextToken = null;
    let page = 0;
    const MAX_PAGES = 5; // safety cap

    do {
      page++;
      const params = {
        engine: "google_maps",
        q: `${keyword} in ${location}`,
        type: "search",
        api_key: SERPAPI_KEY
      };
      if (nextToken) {
        params.next_page_token = nextToken;
      }

      const response = await axios.get("https://serpapi.com/search.json", {
        params,
        timeout: 25000
      });

      const pageResults = response.data.local_results || [];
      console.log(`[SerpAPI] Page ${page}: raw results = ${pageResults.length}`);
      allRaw.push(...pageResults);

      nextToken = response.data.serpapi_pagination?.next_page_token || null;

      // SerpAPI sometimes needs a short delay before fetching next page
      if (nextToken && page < MAX_PAGES) {
        await delay(1500);
      }
    } while (nextToken && page < MAX_PAGES);

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

    const leads = deduped.map((place) => ({
      id: uuidv4(),
      name: place.title || "Unknown",
      address: place.address || "N/A",
      phone: place.phone || "N/A",
      website: place.website || "N/A",
      email: "N/A",
      city: place.address?.split(',')?.[0]?.trim() || location,
      location: location,
      niche: keyword,
      rating: place.rating || null,
      reviews: place.reviews || null,
      source: "serpapi"
    }));

    // Save to persistent storage (deduplicates against existing)
    const saved = await storage.addLeads(leads);
    console.log(`[Scrape] Saved ${saved.length} new leads (${leads.length - saved.length} duplicates skipped)`);

    // Return only the SAVED leads — every one has a real UUID in persistent storage
    console.log("SCRAPE SUCCESS", saved.length);
    return res.json({ leads: saved, savedCount: saved.length, totalScraped: leads.length });

  } catch (err) {
    console.error("SCRAPE ERROR", err.message);
    return res.status(500).json({
      error: err.message,
      leads: []
    });
  }
});

module.exports = router;
