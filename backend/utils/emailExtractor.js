/**
 * Safe website email extraction with SSRF guards.
 * Only http(s) to public hosts; blocks localhost, private, and link-local ranges.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

function isPrivateIp(ip) {
  if (!ip) return true;
  const v = String(ip).toLowerCase();
  if (v === '::1' || v === '0.0.0.0') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true; // IPv6 ULA / link-local
  if (net.isIPv4(v)) {
    const parts = v.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

async function assertSafePublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new Error('invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http(s) allowed');
  }
  if (parsed.username || parsed.password) {
    throw new Error('credentials in URL not allowed');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost'
    || host === 'metadata.google.internal'
    || host.endsWith('.local')
    || host.endsWith('.internal')
  ) {
    throw new Error('blocked host');
  }
  // Literal IP in hostname
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new Error('private IP blocked');
  }
  // Resolve DNS and reject private answers (basic DNS rebinding guard)
  try {
    const records = await dns.lookup(host, { all: true });
    for (const r of records) {
      if (isPrivateIp(r.address)) throw new Error('resolved to private IP');
    }
  } catch (err) {
    if (err.message.includes('private') || err.message.includes('blocked')) throw err;
    throw new Error('DNS lookup failed');
  }
  return parsed.toString();
}

async function extractEmailFromPage(url) {
  try {
    const safeUrl = await assertSafePublicUrl(url);
    const { data } = await axios.get(safeUrl, {
      timeout: 8000,
      maxRedirects: 3,
      maxContentLength: 2 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LeadFlowBot/1.0; +https://leadflow.ai)',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const $ = cheerio.load(data);

    let email = '';
    $('a[href^="mailto:"]').each((i, el) => {
      const mailto = $(el).attr('href');
      const match = mailto.match(/mailto:([^?]+)/);
      if (match && match[1]) {
        email = match[1];
        return false;
      }
    });

    if (email) return email;

    const text = $('body').text();
    const emailMatches = text.match(/[a-zA-Z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
    if (emailMatches && emailMatches.length > 0) {
      const validEmails = emailMatches.filter((e) =>
        !e.includes('example.com')
        && !e.includes('domain.com')
        && !e.includes('email.com')
        && !e.includes('test.com')
        && !/\.(png|jpe?g|gif|svg|webp|bmp|ico|tiff?|avif)$/i.test(e)
        && !/@2x|@3x|@1x/i.test(e)
      );
      if (validEmails.length > 0) {
        return validEmails[0];
      }
    }

    return '';
  } catch (err) {
    return '';
  }
}

async function extractEmail(website) {
  if (!website || website === 'N/A') return 'N/A';

  try {
    let baseUrl = website;
    if (!baseUrl.startsWith('http')) {
      baseUrl = 'https://' + baseUrl;
    }

    try {
      await assertSafePublicUrl(baseUrl);
    } catch (_) {
      return 'N/A';
    }

    let email = await extractEmailFromPage(baseUrl);
    if (email) return email;

    const contactPaths = ['/contact', '/contact-us', '/about', '/about-us'];
    for (const p of contactPaths) {
      try {
        const contactUrl = baseUrl.replace(/\/$/, '') + p;
        email = await extractEmailFromPage(contactUrl);
        if (email) return email;
      } catch {
        continue;
      }
    }

    return 'N/A';
  } catch (err) {
    return 'N/A';
  }
}

/**
 * Enrich leads that have a website but no usable email.
 * concurrency: max parallel website fetches (default 3).
 * Mutates lead.email in place and returns the same array.
 */
async function extractEmailsForLeads(leads, concurrency = 3) {
  const list = Array.isArray(leads) ? leads : [];
  const limit = Math.max(1, Math.min(Number(concurrency) || 3, 10));
  let idx = 0;

  async function worker() {
    while (idx < list.length) {
      const i = idx;
      idx += 1;
      const lead = list[i];
      if (!lead) continue;
      const existing = lead.email && String(lead.email).trim();
      if (existing && existing !== 'N/A') continue;
      if (!lead.website || lead.website === 'N/A') continue;
      try {
        const found = await extractEmail(lead.website);
        if (found && found !== 'N/A') {
          lead.email = found;
        }
      } catch (_) {
        /* keep missing */
      }
    }
  }

  const workers = Math.min(limit, Math.max(list.length, 1));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return list;
}

module.exports = {
  extractEmail,
  extractEmailFromPage,
  extractEmailsForLeads,
  assertSafePublicUrl,
  isPrivateIp,
};
