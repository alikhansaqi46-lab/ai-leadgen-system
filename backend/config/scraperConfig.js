const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'scraper-config.json');

function ensureDir() {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function load() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    console.error('[ScraperConfig] Failed to read config:', err.message);
    return {};
  }
}

function save(data) {
  ensureDir();
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[ScraperConfig] Failed to write config:', err.message);
  }
}

function getKey() {
  const config = load();
  // Fallback to env for backwards compat
  return config.serpApiKey || process.env.SERPAPI_KEY || null;
}

function setKey(key) {
  const config = load();
  config.serpApiKey = (key || '').trim();
  if (!config.serpApiKey) delete config.serpApiKey;
  save(config);
}

function getConfig() {
  return { configured: !!getKey(), serpApiKey: undefined };
}

module.exports = { getKey, setKey, getConfig };
