const axios = require('axios');
const scraperConfig = require('./config/scraperConfig');

async function test() {
  const key = scraperConfig.getKey();
  if (!key) { console.log('No API key'); return; }

  const params = { engine: 'google_maps', q: 'restaurant in Kuala Lumpur', type: 'search', api_key: key };
  const res = await axios.get('https://serpapi.com/search.json', { params, timeout: 25000 });

  console.log('serpapi_pagination.next:', res.data.serpapi_pagination?.next);
  console.log('serpapi_pagination:', JSON.stringify(res.data.serpapi_pagination, null, 2));
}

test();
