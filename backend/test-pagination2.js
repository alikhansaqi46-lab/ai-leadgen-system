const axios = require('axios');
const scraperConfig = require('./config/scraperConfig');

async function test() {
  const key = scraperConfig.getKey();
  if (!key) { console.log('No API key'); return; }

  console.log('=== Test: start parameter ===');
  for (let start of [0, 20, 40]) {
    const params = {
      engine: 'google_maps',
      q: 'restaurant in Kuala Lumpur',
      type: 'search',
      api_key: key,
      start
    };
    try {
      const res = await axios.get('https://serpapi.com/search.json', { params, timeout: 25000 });
      const results = res.data.local_results || [];
      console.log(`  start=${start}: ${results.length} results`);
      if (results.length > 0) {
        console.log(`    First: ${results[0].title}`);
      }
    } catch (e) {
      console.error(`  start=${start} ERROR: ${e.message}`);
    }
  }

  console.log('\n=== Test: pagioffice parameter ===');
  for (let offset of [0, 1, 2]) {
    const params = {
      engine: 'google_maps',
      q: 'restaurant in Kuala Lumpur',
      type: 'search',
      api_key: key,
      pagioffice: offset
    };
    try {
      const res = await axios.get('https://serpapi.com/search.json', { params, timeout: 25000 });
      const results = res.data.local_results || [];
      console.log(`  pagioffice=${offset}: ${results.length} results`);
    } catch (e) {
      console.error(`  pagioffice=${offset} ERROR: ${e.message}`);
    }
  }

  console.log('\n=== Test: Full response keys ===');
  const params = { engine: 'google_maps', q: 'restaurant in Kuala Lumpur', type: 'search', api_key: key };
  const res = await axios.get('https://serpapi.com/search.json', { params, timeout: 25000 });
  console.log('  Top-level keys:', Object.keys(res.data).filter(k => !k.startsWith('search_')).join(', '));
  console.log('  serpapi_pagination keys:', Object.keys(res.data.serpapi_pagination || {}).join(', ') || 'none');
}

test();
