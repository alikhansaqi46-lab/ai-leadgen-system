const express = require("express");
const router = express.Router();
const puppeteer = require("puppeteer");

router.get("/", async (req, res) => {
  try {
    const { keyword, location } = req.query;

    if (!keyword || !location) {
      return res.status(400).json({ error: "Missing params" });
    }

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu"
      ],
    });

    const page = await browser.newPage();

    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(
      keyword + " " + location
    )}`;

    await page.goto(searchUrl, { waitUntil: "networkidle2" });

    await page.waitForTimeout(5000);

    // scroll
    for (let i = 0; i < 15; i++) {
      await page.mouse.wheel({ deltaY: 1000 });
      await page.waitForTimeout(1500);
    }

    const results = await page.evaluate(() => {
      const data = [];
      const items = document.querySelectorAll('div[role="article"]');

      items.forEach((el) => {
        const name = el.querySelector(".fontHeadlineSmall")?.innerText;

        if (name) {
          data.push({
            business: name,
          });
        }
      });

      return data.slice(0, 20);
    });

    await browser.close();

    return res.json(results);
  } catch (error) {
    console.error("SCRAPE ERROR:", error);
    return res.status(500).json({ error: error.message || "Scraping failed" });
  }
});

module.exports = router;
