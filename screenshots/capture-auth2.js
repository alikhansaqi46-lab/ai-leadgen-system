const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const outDir = 'C:\\AI-LeadGen-system\\screenshots';

  // Capture verify-email page
  await page.goto('http://localhost:3000/verify-email', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(outDir, 'auth-verify-email-v2.png'), fullPage: false });
  console.log('Captured: auth-verify-email-v2.png');

  // Capture account settings (need to login first)
  await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', 'testflow7@example.com');
  await page.fill('input[type="password"]', 'NewPass456');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/app/**', { timeout: 10000 });
  await page.waitForTimeout(2000);
  await page.goto('http://localhost:3000/app/account');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(outDir, 'auth-account-v2.png'), fullPage: false });
  console.log('Captured: auth-account-v2.png');

  await browser.close();
  console.log('Done');
})();
