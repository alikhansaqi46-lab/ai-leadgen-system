const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const outDir = 'C:\\AI-LeadGen-system\\screenshots';

  // Get a fresh token by logging in via API
  const http = require('http');
  const loginData = JSON.stringify({ email: 'testflow7@example.com', password: 'NewPass456' });
  const token = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: 5001, path: '/api/auth/login',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': loginData.length }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body).token); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(loginData);
    req.end();
  });

  if (!token) { console.error('Login failed'); await browser.close(); return; }

  // Set token in localStorage and navigate to account
  await page.goto('http://localhost:3000/login');
  await page.evaluate((t) => { localStorage.setItem('lf_auth_token', t); }, token);
  await page.goto('http://localhost:3000/app/account');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(outDir, 'auth-account-v2.png'), fullPage: false });
  console.log('Captured: auth-account-v2.png');

  // Capture dashboard while logged in
  await page.goto('http://localhost:3000/app/dashboard');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(outDir, 'auth-dashboard-v2.png'), fullPage: false });
  console.log('Captured: auth-dashboard-v2.png');

  await browser.close();
  console.log('Done');
})();
