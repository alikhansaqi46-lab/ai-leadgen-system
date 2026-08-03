/**
 * Live route smoke against a running backend (default http://127.0.0.1:5001).
 * Run: node scripts/verify-live-routes.js
 * Optional: API_BASE_URL=http://127.0.0.1:5001
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const base = (process.env.API_BASE_URL || 'http://127.0.0.1:5001').replace(/\/$/, '');

function request(method, path) {
  return new Promise((resolve) => {
    const u = new URL(base + path);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        timeout: 8000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', (err) => resolve({ error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
    if (method === 'POST') req.write('{}');
    req.end();
  });
}

const probes = [
  ['GET', '/health', [200]],
  ['GET', '/api/paypal/plans', [200]],
  ['GET', '/api/email/tracking/open', [400]],
  ['GET', '/api/email/tracking/click', [400]],
  ['GET', '/api/whatsapp-status', [401]],
  ['GET', '/api/dashboard/metrics', [401]],
  ['GET', '/api/automations', [401]],
  ['GET', '/api/reports/performance', [401]],
  ['GET', '/api/leads', [401]],
  ['GET', '/api/sms/status', [401]],
  ['GET', '/api/campaign', [401]],
  ['GET', '/api/integrations', [401]],
  ['POST', '/api/webhook/order', [401, 503]],
  ['POST', '/api/sms/webhook', [200, 403, 503]],
  ['GET', '/api/whatsapp/webhook', [403, 503]],
];

(async () => {
  console.log(`Live route smoke → ${base}\n`);
  let failed = 0;
  for (const [method, path, want] of probes) {
    const code = await request(method, path);
    if (code && code.error) {
      console.log(`  ✗ ${method} ${path} → ${code.error}`);
      failed += 1;
      continue;
    }
    const ok = want.includes(code);
    console.log(`  ${ok ? '✓' : '✗'} ${method} ${path} → ${code} (want ${want.join('|')})`);
    if (!ok) failed += 1;
  }
  if (failed) {
    console.error(`\n${failed} probe(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${probes.length} live probes passed`);
})();
