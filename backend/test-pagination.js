const axios = require('axios');
const scraperConfig = require('./config/scraperConfig');

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function test() {
  const key = scraperConfig.getKey();
  if (!key) { console.log('No API key'); return; }

  const queries = [
    { keyword: 'restaurant', location: 'Kuala Lumpur' },
    { keyword: 'gym', location: 'London' },
    { keyword: 'lawyer', location: 'New York' },
  ];

  for (const { keyword, location } of queries) {
    console.log(`\n=== ${keyword} in ${location} ===`);
    const params = {
      engine: 'google_maps',
      q: `${keyword} in ${location}`,
      type: 'search',
      api_key: key
    };
    try {
      const res = await axios.get('https://serpapi.com/search.json', { params, timeout: 25000 });
      const results = res.data.local_results || [];
      const pagination = res.data.serpapi_pagination || {};
      console.log(`  Results: ${results.length}`);
      console.log(`  Has next_page_token: ${!!pagination.next_page_token}`);
      console.log(`  next_page_token: ${pagination.next_page_token ? pagination.next_page_token.slice(0, 20) + '...' : 'none'}`);

      if (pagination.next_page_token) {
        console.log('  Fetching page 2 after 2.5s delay...');
        await delay(2500);
        const p2 = await axios.get('https://serpapi.com/search.json', {
          params: { ...params, next_page_token: pagination.next_page_token },
          timeout: 25000
        });
        const r2 = p2.data.local_results || [];
        console.log(`  Page 2 results: ${r2.length}`);
      }
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
    }
  }
}

test();
