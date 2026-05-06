const express = require("express");
const router = express.Router();
const axios = require("axios");

// SerpAPI key (Google Maps scraper via HTTP - works on Render)
const SERPAPI_KEY = "613bdd47bbd9ae7aedeece3b692e0d57cd1ca4f215c769c805688d515022f761";

/**
 * GET /api/scrape?keyword=gym&location=karachi
 * Uses SerpAPI Google Maps engine - no Puppeteer, works on Render
 * ALWAYS returns JSON (never HTML)
 */
router.get("/", async (req, res) => {
  console.log("SCRAPE ROUTE HIT");
  console.log("[scrape.js] >>> query:", req.query);

  // Defensive: always return JSON, even on unexpected errors
  const sendJson = (statusCode, payload) => {
    res.setHeader("Content-Type", "application/json");
    return res.status(statusCode).json(payload);
  };

  try {
    const { keyword, location } = req.query;

    if (!keyword || !location) {
      return sendJson(400, {
        error: "Missing required query params: keyword and location",
        example: "/api/scrape?keyword=gym&location=karachi"
      });
    }

    console.log(`🔍 [SerpAPI] keyword="${keyword}" location="${location}"`);

    const searchQuery = `${keyword} in ${location}`;

    const response = await axios.get("https://serpapi.com/search.json", {
      params: {
        engine: "google_maps",
        q: searchQuery,
        type: "search",
        num: 20,
        api_key: SERPAPI_KEY
      },
      timeout: 20000
    });

    const rawResults = response.data.local_results || [];
    console.log(`📄 SerpAPI returned ${rawResults.length} raw results`);

    // Transform to clean lead objects
    const leads = rawResults.map((place, index) => ({
      id: `scraped_${index + 1}`,
      name: place.title || "Unknown",
      address: place.address || "N/A",
      phone: place.phone || place.formatted_phone_number || "N/A",
      website: place.website || place.link || "N/A",
      email: "N/A",           // extracted separately if needed
      place_id: place.place_id || place.data_id || "",
      location: location,
      niche: keyword,
      lat: place.gps_coordinates?.latitude || place.latitude || null,
      lng: place.gps_coordinates?.longitude || place.longitude || null,
      rating: place.rating || null,
      reviews: place.reviews || null,
      source: "serpapi",
      createdAt: new Date().toISOString()
    }));

    // Remove exact duplicates by place_id
    const seen = new Set();
    const uniqueLeads = [];
    for (const lead of leads) {
      const key = lead.place_id || `${lead.name}-${lead.address}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueLeads.push(lead);
      }
    }

    console.log(`✅ Returning ${uniqueLeads.length} clean leads`);

    return sendJson(200, uniqueLeads);

  } catch (error) {
    const errMsg = error.response?.data?.error || error.message || "Unknown error";
    console.error("[scrape.js] ❌ ERROR in /api/scrape:", errMsg);

    // ALWAYS return JSON, never let Express default handler send HTML
    return sendJson(502, {
      error: "Scraping service unavailable",
      details: errMsg,
      leads: [],
      suggestion: "Check SerpAPI quota or try again later"
    });
  }
});

module.exports = router;
