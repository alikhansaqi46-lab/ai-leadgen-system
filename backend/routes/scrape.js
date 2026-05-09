const express = require("express");
const router = express.Router();
const axios = require("axios");

const SERPAPI_KEY = process.env.SERPAPI_KEY || "613bdd47bbd9ae7aedeece3b692e0d57cd1ca4f215c769c805688d515022f761";

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

    const response = await axios.get("https://serpapi.com/search.json", {
      params: {
        engine: "google_maps",
        q: `${keyword} in ${location}`,
        type: "search",
        api_key: SERPAPI_KEY
      },
      timeout: 20000
    });

    const raw = response.data.local_results || [];

    const leads = raw.map((place, i) => ({
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
