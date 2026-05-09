const express = require("express");
const router = express.Router();
const axios = require("axios");

const SERPAPI_KEY = process.env.SERPAPI_KEY || "613bdd47bbd9ae7aedeece3b692e0d57cd1ca4f215c769c805688d515022f761";

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

router.get("/", async (req, res) => {
  console.log("SCRAPE HIT", req.query);

  try {
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

    const leads = deduped.map((place, i) => ({
      id: `lead_${i + 1}`,
      name: place.title || "Unknown",
      address: place.address || "N/A",
      phone: place.phone || "N/A",
      website: place.website || "N/A",
      email: "N/A",
      location: location,
      niche: keyword,
      source: "serpapi"
    }));

    console.log("SCRAPE SUCCESS", leads.length);
    return res.json({ leads });

  } catch (err) {
    console.error("SCRAPE ERROR", err.message);
    return res.status(500).json({
      error: err.message,
      leads: []
    });
  }
});

module.exports = router;
